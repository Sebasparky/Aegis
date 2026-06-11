/**
 * Post-Fill Probe v1 (ANTIGEN_FILL_STATE, default-off).
 *
 * One short-lived CDP attach run by the protected-fill execute endpoints AFTER
 * a fill completes, evaluating the shared page-state probe IIFE
 * (buildPageStateProbeExpr) with the fill-state section enabled. The result
 * feeds buildPostFillState — the agent-facing post_fill_state summary that
 * removes the post-fill re-snapshot / scroll-hunt / redaction-re-verification
 * loop.
 *
 * Standalone by design (Option A): the profile/payment fill executors are
 * callback-driven WS state machines (and the OPPWA payment path is attached to
 * a cross-origin IFRAME target, not the top document), so threading a probe
 * through them is invasive and partly impossible. One extra local WS connect
 * (~20ms) buys a single implementation that serves both paths.
 *
 * FAIL-CLOSED CONTRACT: every failure path — transport, no target, attach
 * failure, unreadable eval, hard timeout — returns `undefined`. The caller's
 * fill success reporting is NEVER affected; post_fill_state simply degrades to
 * outcome "unknown" (or is omitted). The probe value is internal-only: it is
 * passed to buildPostFillState (explicit-field allowlist) and never spread
 * into a response, trace event, or log.
 *
 * SAFETY: the probe runs on the TOP document only — it structurally cannot and
 * must not enter cross-origin payment iframes. The fill-state section never
 * reads `.value` of any field (see antigenClickVerification.ts LEAK BOUNDARY).
 */

import WebSocket from "ws";
import {
  getBrowserWsUrl,
  invalidateBrowserWsUrl,
  pickBestPageTarget,
  type CdpPageTarget,
} from "./cdpTargetSelection.js";
import {
  buildPageStateProbeExpr,
  POST_FILL_SETTLE_SCHEDULE_MS,
  type PageStateProbe,
} from "./antigenClickVerification.js";
import { isActiveSurfacesEnabled } from "./antigenSnapshotPageMap.js";
import { BrowserTimingScope } from "./browserTiming.js";

/** Post-fill state is enabled only when the dev flag is explicitly set. */
export function isFillStateEnabled(): boolean {
  return process.env.ANTIGEN_FILL_STATE === "true";
}

/** Hard ceiling on the whole probe run (connect + attach + settle loop). */
const POST_FILL_PROBE_TIMEOUT_MS = 5_000;

export interface PostFillProbeResult {
  /** INTERNAL — pass only to buildPostFillState; never spread into responses. */
  probe: PageStateProbe;
  /** Wall-clock duration of the whole probe run (incl. connect), ms. */
  probe_ms: number;
}

/**
 * Early-exit predicate for the post-fill settle loop: stop polling as soon as
 * the probe is readable AND decision-relevant state appeared — validation
 * errors are visible, or at least one ENABLED non-dismiss next action exists.
 * Exported for unit testing.
 */
export function isPostFillProbeSettled(probe: PageStateProbe): boolean {
  if (probe.status !== "ok" || !probe.fill_state) return false;
  const fs = probe.fill_state;
  if (fs.invalid_count > 0 || fs.alert_count > 0) return true;
  return (
    Array.isArray(fs.form_actions) &&
    fs.form_actions.some((a) => a.disabled !== true && a.dismiss !== true)
  );
}

/**
 * Run the after-fill page-state probe against the SAME tab the fill just used
 * (pickBestPageTarget with the fill's domain/preferred URL — the selection the
 * fill executors use). Probes immediately, then re-probes on
 * POST_FILL_SETTLE_SCHEDULE_MS only while unsettled. Returns undefined on any
 * failure (fail-closed).
 */
export async function runPostFillProbe(params: {
  cdpUrl: string;
  domain?: string;
  preferredTargetUrl?: string;
}): Promise<PostFillProbeResult | undefined> {
  const { cdpUrl, domain, preferredTargetUrl } = params;
  const timing = new BrowserTimingScope("antigen_post_fill_probe");
  const t0 = process.hrtime.bigint();

  let browserWsUrl: string | undefined;
  let targets: CdpPageTarget[];
  try {
    // /json/version goes through the short-TTL process-level cache; /json/list
    // (live page/URL state) is ALWAYS fetched fresh.
    [browserWsUrl, targets] = await Promise.all([
      getBrowserWsUrl(cdpUrl),
      fetch(`${cdpUrl}/json/list`).then((r) => r.json() as Promise<CdpPageTarget[]>),
    ]);
  } catch {
    timing.end({ ok: false, stage: "fetch" });
    return undefined;
  }
  if (!browserWsUrl || !Array.isArray(targets)) {
    timing.end({ ok: false, stage: "fetch" });
    return undefined;
  }
  const { target } = pickBestPageTarget(targets, {
    domain,
    preferredUrl: preferredTargetUrl,
  });
  if (!target) {
    timing.end({ ok: false, stage: "target" });
    return undefined;
  }
  timing.mark("connect_resolve");

  const expr = buildPageStateProbeExpr({
    collectSurfaceActions: isActiveSurfacesEnabled(),
    collectFillState: true,
  });

  const result = await new Promise<PostFillProbeResult | undefined>((resolve) => {
    const ws = new WebSocket(browserWsUrl as string);
    let msgId = 1;
    let settled = false;
    let polls = 0;
    const pending = new Map<number, (r: Record<string, unknown> | undefined) => void>();

    const finish = (value: PostFillProbeResult | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      timing.end({ ok: value !== undefined, polls });
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), POST_FILL_PROBE_TIMEOUT_MS);

    const sendAndWait = (
      method: string,
      p: Record<string, unknown>,
      sid?: string,
    ): Promise<Record<string, unknown> | undefined> =>
      new Promise((res) => {
        const id = msgId++;
        pending.set(id, res);
        const msg: Record<string, unknown> = { id, method, params: p };
        if (sid) msg.sessionId = sid;
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          pending.delete(id);
          res(undefined);
        }
      });
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    ws.on("error", () => {
      invalidateBrowserWsUrl(cdpUrl);
      finish(undefined);
    });
    ws.on("message", (data: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const id = msg.id as number | undefined;
      if (id === undefined) return;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      waiter(msg.result as Record<string, unknown> | undefined);
    });
    ws.on("open", () => {
      void (async () => {
        try {
          const attach = await sendAndWait("Target.attachToTarget", {
            targetId: target.id,
            flatten: true,
          });
          const sid = attach?.sessionId as string | undefined;
          if (!sid) return finish(undefined);
          timing.mark("attach");

          const evalOnce = async (): Promise<PageStateProbe | undefined> => {
            const r = await sendAndWait(
              "Runtime.evaluate",
              { expression: expr, returnByValue: true },
              sid,
            );
            const val = (r?.result as Record<string, unknown> | undefined)?.value as
              | PageStateProbe
              | undefined;
            if (!val || typeof val !== "object" || (val.status !== "ok" && val.status !== "error")) {
              return undefined;
            }
            return val;
          };

          let probe = await evalOnce();
          polls++;
          for (
            let i = 0;
            i < POST_FILL_SETTLE_SCHEDULE_MS.length &&
            probe !== undefined &&
            probe.status === "ok" &&
            !isPostFillProbeSettled(probe);
            i++
          ) {
            await sleep(POST_FILL_SETTLE_SCHEDULE_MS[i]);
            const next = await evalOnce();
            polls++;
            if (!next) break; // keep the last readable probe
            probe = next;
          }
          if (!probe) return finish(undefined);
          timing.mark("settle");
          const probeMs = Math.round(Number(process.hrtime.bigint() - t0) / 1_000_000);
          finish({ probe, probe_ms: probeMs });
        } catch {
          finish(undefined);
        }
      })();
    });
  });
  return result;
}
