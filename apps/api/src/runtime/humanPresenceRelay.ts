/**
 * Human Presence Relay v1 — live CDP hold/click mirroring.
 *
 * The runtime side of the Human Presence Relay: while the user performs a
 * branded press-and-hold (or tap confirmation) in the Aegis web UI, this module
 * mirrors that LIVE interaction into the agent's browser session over CDP.
 *
 * Hard rules (the product principle this module enforces):
 * - The browser mouse-down exists ONLY while fresh user heartbeats arrive from
 *   the web UI. ~1.2s of silence → immediate fail-closed mouseReleased.
 * - No gesture is ever recorded, stored, or replayed. Hold sessions are
 *   memory-only and carry no path/timing recordings.
 * - There is NO auto-solve path: every mousePressed here is caused by a live
 *   user hold-start event, every mouseReleased by the user's release (or the
 *   fail-closed timer / cancellation).
 * - Geometry (the challenge control's box) is re-located LIVE at hold-start
 *   time and lives only inside function scope — it is never stored on the
 *   HumanVerificationRequest and never appears in any API response.
 *
 * The transport above this module is heartbeat POSTs in v1; the exported
 * surface (startHoldSession / heartbeatHoldSession / endHoldSession /
 * confirmPresenceClick / recheckChallenge) is transport-agnostic so a
 * WebSocket/SSE or mobile-push transport can swap in later.
 */

import WebSocket from "ws";

import type { HumanVerificationChallengeType, HumanVerificationRequest } from "@aegis/types";

import { getBrowserWsUrl, invalidateBrowserWsUrl, pickBestPageTarget, type CdpPageTarget } from "./cdpTargetSelection.js";
import { buildOverlaySnippetJs } from "./antigenSnapshotRuntime.js";
import {
  makePointerRuntimeState,
  movePointerToBox,
  clickBoxWithPointer,
  pressAtPoint,
  releaseAtPoint,
  resolvePointerTimingMode,
  type ElementBox,
} from "./nativePointerRuntime.js";
import { taskBrowserSessions } from "./taskBrowserSessions.js";

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Heartbeat silence after which the browser hold is force-released. */
export const HOLD_FAIL_CLOSED_MS = 1_200;
/** Settle delay between release/click and the post-action presence probe. */
const POST_ACTION_PROBE_DELAY_MS = 500;
/** Per-CDP-call timeout for relay operations. */
const CDP_CALL_TIMEOUT_MS = 8_000;
/** Hard ceiling on a single hold (defense-in-depth behind heartbeats + TTL). */
export const HOLD_MAX_DURATION_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Live presence probe (page-side IIFE) ────────────────────────────────────

/**
 * Raw-JS IIFE that re-locates the human-verification challenge on the LIVE
 * page: present?, challenge type, and the current box of the interactive
 * control (press-hold button / human checkbox). Concatenates
 * buildOverlaySnippetJs() — the SINGLE source of overlay + human-verification
 * classification — so the relay can never drift from snapshot detection.
 *
 * The returned control_box is internal targeting geometry consumed inside this
 * module only. It is never stored or returned through any API surface.
 */
export function buildHumanVerificationProbeExpr(): string {
  return `(function(){
    var OVERLAY_TITLE_MAX=120;
    var OVERLAY_WALK_DEPTH=12;
    var OVERLAY_DRAWER_RE=/(drawer|flyout|off-?canvas|side-?panel|slide-?over|snackbar)/i;
    var OVERLAY_DISMISS_RE=/\\b(close|dismiss|no thanks|not now|maybe later)\\b/i;
    var OVERLAY_CHAT_RE=/(chat|messeng|intercom|zendesk|drift|live\\s*help|support\\s*widget|help\\s*widget|chat\\s*widget|launcher)/i;
    function txt(s){ return (s==null?'':String(s)).replace(/\\s+/g,' ').trim(); }
    function clip(s,max){ s=txt(s); return s.length>max?s.slice(0,max):s; }
    function attr(el,n){ try{ return el.getAttribute(n); }catch(e){ return null; } }
    ${buildOverlaySnippetJs()}
    // Candidate challenge containers: explicit dialog ARIA, plus the element
    // stack under the viewport center (challenge modals are centered), plus
    // fixed high-coverage body children (bare PerimeterX-style dimmers).
    var containers=[];
    try{ containers=Array.prototype.slice.call(document.querySelectorAll('[aria-modal="true"],dialog[open],[role="dialog"],[role="alertdialog"]')); }catch(e){ containers=[]; }
    try{
      var stack=document.elementsFromPoint(window.innerWidth/2,window.innerHeight/2)||[];
      for(var s=0;s<stack.length&&s<12;s++){ containers.push(stack[s]); }
    }catch(e){}
    try{
      var kids=document.body?document.body.children:[];
      for(var i=0;i<kids.length&&i<60;i++){ if(fixedCoverage(kids[i])>=0.5) containers.push(kids[i]); }
    }catch(e){}
    var found=null, foundType=null;
    for(var c=0;c<containers.length;c++){
      var node=containers[c]; if(!node||node===document.documentElement||node===document.body) continue;
      var hvt=null; try{ hvt=humanVerificationOf(node); }catch(e){ hvt=null; }
      if(hvt){ found=node; foundType=hvt; break; }
    }
    if(!found) return { present:false, vw:window.innerWidth, vh:window.innerHeight };
    var control=null;
    try{
      var els=found.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],input[type="checkbox"],[role="checkbox"]');
      for(var j=0;j<els.length;j++){
        var el=els[j];
        var nm=''; try{ nm=txt(el.innerText!=null?el.innerText:el.textContent); }catch(e){ nm=''; }
        if(!nm) nm=txt(attr(el,'aria-label')||'');
        var hit=false; try{ hit=isHvControl(el,nm,foundType); }catch(e){ hit=false; }
        if(hit){ control=el; break; }
      }
      // press_and_hold fallback: a single button inside the challenge container
      // IS the hold target even when its label doesn't echo "press & hold".
      if(!control&&foundType==='press_and_hold'){
        var bs=found.querySelectorAll('button,[role="button"]');
        if(bs.length===1) bs[0]&&(control=bs[0]);
      }
    }catch(e){}
    var box=null;
    if(control){
      try{
        var r=control.getBoundingClientRect();
        if(r.width>0&&r.height>0) box={x:r.left,y:r.top,width:r.width,height:r.height};
      }catch(e){ box=null; }
    }
    return { present:true, challenge_type:foundType, control_box:box, vw:window.innerWidth, vh:window.innerHeight };
  })()`;
}

export interface HumanVerificationProbeResult {
  present: boolean;
  challenge_type?: HumanVerificationChallengeType;
  /** INTERNAL targeting geometry — never stored, never returned via any API. */
  control_box?: ElementBox | null;
  vw: number;
  vh: number;
}

// ─── Minimal long-lived CDP page client ──────────────────────────────────────
//
// The hold needs ONE WebSocket held open across hold-start → heartbeats →
// hold-end: reconnect-per-event adds 50–150ms+ jitter per beat (racing the
// 1.2s fail-closed timer) and the release must reach the same input domain the
// press did. Pattern (browser-level ws + Target.attachToTarget flatten) matches
// challengeInjection.ts / realisticClickKnownBox.

export interface CdpPageClient {
  send(method: string, params?: Record<string, unknown>): void;
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  evaluate(expression: string): Promise<unknown>;
  close(): void;
}

// Exported additively so the Visual Gesture Capsule point-explicit relay
// (visualGestureCapsuleRelay.ts) can reuse this CDP page-client opener instead
// of duplicating the WebSocket/Target.attach plumbing. No behavior change.
export async function openCdpPageClient(params: {
  cdpUrl: string;
  domain?: string;
  preferredUrl?: string;
}): Promise<{ ok: true; client: CdpPageClient; target: CdpPageTarget } | { ok: false; error: string }> {
  const { cdpUrl, domain, preferredUrl } = params;
  let browserWsUrl: string | undefined;
  let targets: CdpPageTarget[];
  try {
    [browserWsUrl, targets] = await Promise.all([
      getBrowserWsUrl(cdpUrl),
      fetch(`${cdpUrl}/json/list`).then((r) => r.json() as Promise<CdpPageTarget[]>),
    ]);
  } catch (err) {
    return { ok: false, error: `CDP_FETCH_FAILED: ${(err as Error).message}` };
  }
  if (!browserWsUrl) return { ok: false, error: "CDP_NO_BROWSER_WS: No browser WebSocket debugger URL from CDP." };
  if (!Array.isArray(targets)) return { ok: false, error: "CDP_FETCH_FAILED: invalid /json/list response." };

  const { target } = pickBestPageTarget(targets, { domain, preferredUrl });
  if (!target) return { ok: false, error: "CDP_NO_PAGE_TARGET: No page targets found via CDP." };

  return await new Promise((resolve) => {
    const ws = new WebSocket(browserWsUrl!);
    let msgId = 1;
    let sessionId: string | null = null;
    const pending = new Map<number, (result: Record<string, unknown> | undefined, error?: unknown) => void>();
    let settled = false;

    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      invalidateBrowserWsUrl(cdpUrl);
      ws.terminate();
      resolve({ ok: false, error: "CDP_CONNECT_TIMEOUT: attach timed out." });
    }, CDP_CALL_TIMEOUT_MS);

    const sendRaw = (method: string, p: Record<string, unknown> = {}, sid?: string): number => {
      const id = msgId++;
      const msg: Record<string, unknown> = { id, method, params: p };
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
      return id;
    };

    const client: CdpPageClient = {
      send(method, p = {}) {
        if (ws.readyState === WebSocket.OPEN && sessionId) void sendRaw(method, p, sessionId);
      },
      call(method, p = {}) {
        return new Promise((res, rej) => {
          if (ws.readyState !== WebSocket.OPEN || !sessionId) {
            rej(new Error("CDP_CONNECTION_CLOSED"));
            return;
          }
          const id = sendRaw(method, p, sessionId);
          const callTimer = setTimeout(() => {
            pending.delete(id);
            rej(new Error("CDP_CALL_TIMEOUT"));
          }, CDP_CALL_TIMEOUT_MS);
          pending.set(id, (result, error) => {
            clearTimeout(callTimer);
            if (error) rej(new Error(`CDP_ERROR: ${JSON.stringify(error)}`));
            else res(result);
          });
        });
      },
      async evaluate(expression: string): Promise<unknown> {
        const result = await client.call("Runtime.evaluate", { expression, returnByValue: true });
        const evalResult = result?.result as Record<string, unknown> | undefined;
        return evalResult?.value;
      },
      close() {
        try {
          clearTimeout(connectTimer);
          ws.close();
        } catch {
          /* best-effort */
        }
      },
    };

    let attachId: number | undefined;
    ws.on("open", () => {
      attachId = sendRaw("Target.attachToTarget", { targetId: target.id, flatten: true });
    });
    ws.on("message", (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const id = msg.id as number | undefined;
      if (id === undefined) return;
      const result = msg.result as Record<string, unknown> | undefined;
      if (id === attachId && !sessionId) {
        if (!result?.sessionId) {
          if (!settled) {
            settled = true;
            clearTimeout(connectTimer);
            ws.close();
            resolve({ ok: false, error: "CDP_ATTACH_FAILED: no sessionId." });
          }
          return;
        }
        sessionId = result.sessionId as string;
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          resolve({ ok: true, client, target });
        }
        return;
      }
      const handler = pending.get(id);
      if (handler) {
        pending.delete(id);
        handler(result, msg.error);
      }
    });
    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        invalidateBrowserWsUrl(cdpUrl);
        resolve({ ok: false, error: `CDP_WS_ERROR: ${err.message}` });
      }
      for (const [, handler] of pending) handler(undefined, { message: err.message });
      pending.clear();
    });
    ws.on("close", () => {
      for (const [, handler] of pending) handler(undefined, { message: "connection closed" });
      pending.clear();
    });
  });
}

function parseProbeValue(value: unknown): HumanVerificationProbeResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.present !== "boolean") return null;
  const out: HumanVerificationProbeResult = {
    present: v.present,
    vw: typeof v.vw === "number" ? v.vw : 1280,
    vh: typeof v.vh === "number" ? v.vh : 800,
  };
  if (typeof v.challenge_type === "string") {
    out.challenge_type = v.challenge_type as HumanVerificationChallengeType;
  }
  const box = v.control_box as Record<string, unknown> | null | undefined;
  if (
    box &&
    typeof box.x === "number" &&
    typeof box.y === "number" &&
    typeof box.width === "number" &&
    typeof box.height === "number"
  ) {
    out.control_box = { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  return out;
}

/** Resolve the CDP base URL for a request's browser session (ready sessions only). */
export function resolveRelayCdpUrl(
  request: HumanVerificationRequest,
): { ok: true; cdpUrl: string } | { ok: false; error: string } {
  const session = taskBrowserSessions.get(request.browser_session_id);
  if (!session || session.status !== "ready") {
    return {
      ok: false,
      error:
        `BROWSER_SESSION_NOT_READY: browser session '${request.browser_session_id}' is not available ` +
        `(status: ${session?.status ?? "not found"}).`,
    };
  }
  return { ok: true, cdpUrl: session.cdp_url };
}

/**
 * Short-lived presence probe: is the challenge still on the live page?
 * Used by recheck (manual-captcha path) and snapshot-independent verification.
 */
export async function probeHumanVerification(
  request: HumanVerificationRequest,
): Promise<{ ok: true; probe: HumanVerificationProbeResult } | { ok: false; error: string }> {
  const cdp = resolveRelayCdpUrl(request);
  if (!cdp.ok) return cdp;
  const opened = await openCdpPageClient({ cdpUrl: cdp.cdpUrl, domain: request.domain, preferredUrl: request.page_url });
  if (!opened.ok) return opened;
  try {
    const value = await opened.client.evaluate(buildHumanVerificationProbeExpr());
    const probe = parseProbeValue(value);
    if (!probe) return { ok: false, error: "PROBE_FAILED: unreadable probe result." };
    return { ok: true, probe };
  } catch (err) {
    return { ok: false, error: `PROBE_FAILED: ${(err as Error).message}` };
  } finally {
    opened.client.close();
  }
}

// ─── Hold sessions (memory-only) ─────────────────────────────────────────────

export type HoldReleaseReason = "user_release" | "fail_closed" | "cancelled" | "max_duration";

interface HoldSession {
  request_id: string;
  client: CdpPageClient;
  point: { x: number; y: number };
  started_at_ms: number;
  last_heartbeat_at_ms: number;
  failTimer: ReturnType<typeof setTimeout>;
  maxTimer: ReturnType<typeof setTimeout>;
  released: boolean;
  release_reason?: HoldReleaseReason;
}

/**
 * One live hold per request. Memory-only by design — a hold is live user
 * presence and can never be persisted, resumed, or replayed.
 */
const holdSessions = new Map<string, HoldSession>();

export function hasLiveHoldSession(requestId: string): boolean {
  const hold = holdSessions.get(requestId);
  return !!hold && !hold.released;
}

/** Single owner for releasing a hold — idempotent; first reason wins. */
function releaseHold(hold: HoldSession, reason: HoldReleaseReason): void {
  if (hold.released) return;
  hold.released = true;
  hold.release_reason = reason;
  clearTimeout(hold.failTimer);
  clearTimeout(hold.maxTimer);
  // Immediate release — no delay on any path (fail-closed must be instant).
  try {
    releaseAtPoint((method, p) => hold.client.send(method, p), hold.point);
  } catch {
    /* connection may already be gone — closing below */
  }
}

function disposeHold(requestId: string): void {
  const hold = holdSessions.get(requestId);
  if (!hold) return;
  holdSessions.delete(requestId);
  hold.client.close();
}

export interface StartHoldResult {
  ok: boolean;
  /** Stable error code for the route layer. */
  code?: "BROWSER_SESSION_NOT_READY" | "CDP_FAILED" | "CONTROL_NOT_FOUND" | "CHALLENGE_NOT_PRESENT" | "HOLD_ALREADY_ACTIVE";
  message?: string;
}

/**
 * Begin mirroring a live user hold: re-locate the challenge control on the
 * live page, move the pointer realistically to it, dispatch mousePressed, and
 * arm the fail-closed timer. The press stays down only while heartbeats arrive.
 *
 * onAutoRelease is invoked (once) if the hold ends without an explicit
 * endHoldSession call — fail-closed silence or the max-duration ceiling — so
 * the lifecycle layer can record it.
 */
export async function startHoldSession(
  request: HumanVerificationRequest,
  onAutoRelease?: (reason: HoldReleaseReason) => void,
): Promise<StartHoldResult> {
  const existing = holdSessions.get(request.request_id);
  if (existing && !existing.released) {
    return { ok: false, code: "HOLD_ALREADY_ACTIVE", message: "A live hold is already active for this request." };
  }
  if (existing) disposeHold(request.request_id);

  const cdp = resolveRelayCdpUrl(request);
  if (!cdp.ok) return { ok: false, code: "BROWSER_SESSION_NOT_READY", message: cdp.error };

  const opened = await openCdpPageClient({ cdpUrl: cdp.cdpUrl, domain: request.domain, preferredUrl: request.page_url });
  if (!opened.ok) return { ok: false, code: "CDP_FAILED", message: opened.error };
  const { client } = opened;

  // Re-locate the challenge control LIVE — geometry is function-scoped only.
  let probe: HumanVerificationProbeResult | null;
  try {
    probe = parseProbeValue(await client.evaluate(buildHumanVerificationProbeExpr()));
  } catch (err) {
    client.close();
    return { ok: false, code: "CDP_FAILED", message: `PROBE_FAILED: ${(err as Error).message}` };
  }
  if (!probe || !probe.present) {
    client.close();
    return {
      ok: false,
      code: "CHALLENGE_NOT_PRESENT",
      message: "No human-verification challenge is present on the live page. Take a fresh antigen_snapshot.",
    };
  }
  if (!probe.control_box) {
    client.close();
    return {
      ok: false,
      code: "CONTROL_NOT_FOUND",
      message: "The challenge control could not be located on the live page — refresh and retry.",
    };
  }

  const sendCdp = (method: string, p: Record<string, unknown>) => client.send(method, p);
  const state = makePointerRuntimeState({
    current_x: probe.vw / 2,
    current_y: probe.vh / 2,
    viewport_width: probe.vw,
    viewport_height: probe.vh,
    browser_session_id: request.browser_session_id,
    interaction_mode: resolvePointerTimingMode(),
  });

  let point: { x: number; y: number };
  try {
    point = await movePointerToBox(state, probe.control_box, sendCdp, sleep, {
      debugLabel: "human_presence_hold",
      purpose: "button_click",
    });
    await pressAtPoint(sendCdp, point, state.interaction_mode, sleep);
  } catch (err) {
    client.close();
    return { ok: false, code: "CDP_FAILED", message: `POINTER_DISPATCH_FAILED: ${(err as Error).message}` };
  }

  registerHoldSession({ request_id: request.request_id, client, point, onAutoRelease });
  return { ok: true };
}

/**
 * Arms the live hold's timers and registers it. Split out of startHoldSession
 * so the fail-closed state machine (heartbeat re-arm, silence release, max-
 * duration ceiling, idempotent release) is directly testable with a fake CDP
 * client — the press itself has already been dispatched by the caller.
 */
export function registerHoldSession(params: {
  request_id: string;
  client: CdpPageClient;
  point: { x: number; y: number };
  onAutoRelease?: (reason: HoldReleaseReason) => void;
}): void {
  const { request_id, client, point, onAutoRelease } = params;
  const nowMs = Date.now();
  const hold: HoldSession = {
    request_id,
    client,
    point,
    started_at_ms: nowMs,
    last_heartbeat_at_ms: nowMs,
    failTimer: setTimeout(() => {
      releaseHold(hold, "fail_closed");
      onAutoRelease?.("fail_closed");
    }, HOLD_FAIL_CLOSED_MS),
    maxTimer: setTimeout(() => {
      releaseHold(hold, "max_duration");
      onAutoRelease?.("max_duration");
    }, HOLD_MAX_DURATION_MS),
    released: false,
  };
  holdSessions.set(request_id, hold);
}

/**
 * Live user heartbeat: re-arms the fail-closed timer. Returns whether the
 * browser hold is still down (false ⇒ it was already released fail-closed).
 */
export function heartbeatHoldSession(requestId: string): { holding: boolean } {
  const hold = holdSessions.get(requestId);
  if (!hold || hold.released) return { holding: false };
  hold.last_heartbeat_at_ms = Date.now();
  clearTimeout(hold.failTimer);
  hold.failTimer = setTimeout(() => {
    releaseHold(hold, "fail_closed");
  }, HOLD_FAIL_CLOSED_MS);
  return { holding: true };
}

export interface EndHoldResult {
  hold_state: "released" | "released_fail_closed" | "no_hold";
  held_ms?: number;
  /** Present when the post-release probe ran. */
  challenge_present?: boolean;
  probe_error?: string;
}

/**
 * User released (or the UI cancelled): release in the browser immediately,
 * then probe (on the SAME connection) whether the challenge cleared.
 * Idempotent — a fail-closed hold reports released_fail_closed.
 */
export async function endHoldSession(requestId: string): Promise<EndHoldResult> {
  const hold = holdSessions.get(requestId);
  if (!hold) return { hold_state: "no_hold" };

  const wasFailClosed = hold.released && hold.release_reason !== "user_release";
  releaseHold(hold, "user_release");
  const heldMs = Date.now() - hold.started_at_ms;

  // Post-release settle + presence probe on the same connection.
  let challengePresent: boolean | undefined;
  let probeError: string | undefined;
  try {
    await sleep(POST_ACTION_PROBE_DELAY_MS);
    const probe = parseProbeValue(await hold.client.evaluate(buildHumanVerificationProbeExpr()));
    if (probe) challengePresent = probe.present;
    else probeError = "PROBE_FAILED: unreadable probe result.";
  } catch (err) {
    probeError = `PROBE_FAILED: ${(err as Error).message}`;
  } finally {
    disposeHold(requestId);
  }

  return {
    hold_state: wasFailClosed ? "released_fail_closed" : "released",
    held_ms: heldMs,
    ...(challengePresent !== undefined ? { challenge_present: challengePresent } : {}),
    ...(probeError ? { probe_error: probeError } : {}),
  };
}

/** Cancel any live hold for the request (user cancel / expiry). Fail-closed. */
export function cancelHoldSession(requestId: string): void {
  const hold = holdSessions.get(requestId);
  if (!hold) return;
  releaseHold(hold, "cancelled");
  disposeHold(requestId);
}

export interface ConfirmPresenceResult {
  ok: boolean;
  code?: "BROWSER_SESSION_NOT_READY" | "CDP_FAILED" | "CONTROL_NOT_FOUND" | "CHALLENGE_NOT_PRESENT";
  message?: string;
  challenge_present?: boolean;
}

/**
 * checkbox_human: mirror a single realistic click into the live challenge
 * control, caused by the user's confirmation tap in the Aegis UI. Then probe
 * whether the challenge cleared.
 */
export async function confirmPresenceClick(request: HumanVerificationRequest): Promise<ConfirmPresenceResult> {
  const cdp = resolveRelayCdpUrl(request);
  if (!cdp.ok) return { ok: false, code: "BROWSER_SESSION_NOT_READY", message: cdp.error };

  const opened = await openCdpPageClient({ cdpUrl: cdp.cdpUrl, domain: request.domain, preferredUrl: request.page_url });
  if (!opened.ok) return { ok: false, code: "CDP_FAILED", message: opened.error };
  const { client } = opened;

  try {
    const probe = parseProbeValue(await client.evaluate(buildHumanVerificationProbeExpr()));
    if (!probe || !probe.present) {
      return {
        ok: false,
        code: "CHALLENGE_NOT_PRESENT",
        message: "No human-verification challenge is present on the live page. Take a fresh antigen_snapshot.",
      };
    }
    if (!probe.control_box) {
      return {
        ok: false,
        code: "CONTROL_NOT_FOUND",
        message: "The challenge control could not be located on the live page — refresh and retry.",
      };
    }

    const sendCdp = (method: string, p: Record<string, unknown>) => client.send(method, p);
    const state = makePointerRuntimeState({
      current_x: probe.vw / 2,
      current_y: probe.vh / 2,
      viewport_width: probe.vw,
      viewport_height: probe.vh,
      browser_session_id: request.browser_session_id,
      interaction_mode: resolvePointerTimingMode(),
    });
    await clickBoxWithPointer(state, probe.control_box, sendCdp, sleep, {
      debugLabel: "human_presence_confirm",
      purpose: "button_click",
    });

    await sleep(POST_ACTION_PROBE_DELAY_MS);
    const after = parseProbeValue(await client.evaluate(buildHumanVerificationProbeExpr()));
    return { ok: true, challenge_present: after ? after.present : true };
  } catch (err) {
    return { ok: false, code: "CDP_FAILED", message: `CONFIRM_FAILED: ${(err as Error).message}` };
  } finally {
    client.close();
  }
}

// ─── Test support ─────────────────────────────────────────────────────────────

export function clearHoldSessionsForTests(): void {
  for (const [id] of holdSessions) {
    cancelHoldSession(id);
  }
  holdSessions.clear();
}
