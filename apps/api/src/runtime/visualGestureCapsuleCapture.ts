// ─── Visual Gesture Capsule — M1C redacted screenshot capture ─────────────────
//
// Connects an existing VisualGestureCapsule (M1A lifecycle) to the existing
// redacted screenshot pipeline (screenshotRedaction.ts) and stores the resulting
// frame through the M1B memory-only frame store. This is the slice that PRODUCES
// the bytes the frame store has, until now, only accepted from callers.
//
// Backend-only. NO CDP gesture relay, NO tap/press_hold dispatch, NO endpoints,
// NO agent-api wiring, NO humanPresenceRelay.ts changes. Gated behind
// ANTIGEN_VISUAL_GESTURE_CAPSULE (default off): flag-off returns `flag_disabled`
// BEFORE any capture/viewport call, so it is byte-identical when the flag is off.
//
// Bytes discipline (mirrors M1B): the success result carries ONLY the safe-view
// polling metadata (availability + timestamps). It NEVER carries `png_base64`,
// viewport dimensions, or coordinates — nothing an agent-facing surface could
// misuse. The PNG flows only into the internal frame store; the safe view stays
// byte-free and coord-free.
//
// Capture and viewport reads are two distinct INJECTABLE seams so unit tests can
// exercise the helper without real Chromium. `screenshotRedaction.ts` is NOT
// modified for this slice — its capture primitive does not return viewport dims,
// so the viewport is read separately.

import { resolveSnapshotCdpTarget } from "./cdpTargetSelection.js";
import { captureRedactedScreenshot } from "./screenshotRedaction.js";
import {
  getVisualGestureCapsule,
  isTerminalVisualGestureStatus,
  isVisualGestureCapsuleEnabled,
  storeVisualGestureCapsuleScreenshotFrame,
} from "./visualGestureCapsule.js";

/**
 * Capture seam. Returns redacted PNG bytes (base64) on success, or a fail-closed
 * marker. `redaction_mismatch` distinguishes a protected-field redaction failure
 * (a value may be visible) from a generic capture failure. Never returns dims.
 */
export interface VgcCaptureFn {
  (args: { cdpUrl: string; targetId?: string; expectedUrl?: string }): Promise<
    { ok: true; png_base64: string } | { ok: false; redaction_mismatch?: boolean; error?: string }
  >;
}

/**
 * Viewport-read seam. Returns the CSS viewport size and — when available — the
 * document scroll offset (`scrollX`/`scrollY`) and layout extent (`layoutW`/
 * `layoutH` = documentElement scrollWidth/scrollHeight), or null on any failure.
 * The scroll/layout fields are optional so legacy readers (and tests) that only
 * report size keep working; the relay's staleness guard falls back to size-only
 * when they are absent.
 */
export interface VgcReadViewportFn {
  (args: { cdpUrl: string; targetId?: string }): Promise<
    | {
        width: number;
        height: number;
        scrollX?: number;
        scrollY?: number;
        layoutW?: number;
        layoutH?: number;
      }
    | null
  >;
}

export type CaptureVisualGestureCapsuleScreenshotFrameResult =
  | {
      ok: true;
      capsule_id: string;
      /** A live, redacted frame is now held. Bytes are never exposed here. */
      screenshot_available: true;
      /** Capture metadata only (mirrors the safe view) — never bytes. */
      screenshot_captured_at: string;
      /** Frame freshness deadline (mirrors the safe view) — never bytes. */
      screenshot_expires_at: string;
    }
  | {
      ok: false;
      reason:
        | "flag_disabled"
        | "not_found"
        | "terminal"
        | "capture_failed"
        | "redaction_failed"
        | "invalid_viewport"
        | "store_failed";
      error?: string;
    };

export interface CaptureVisualGestureCapsuleScreenshotFrameInput {
  capsuleId: string;
  cdpUrl: string;
  /** Optional preferred CDP page target id (else the resolver's best target). */
  targetId?: string;
  /** Optional expected page URL the capture should match (advisory). */
  expectedUrl?: string;
  /** Injectable for tests; defaults to the real redacted-capture reader. */
  capture?: VgcCaptureFn;
  /** Injectable for tests; defaults to the real CDP viewport reader. */
  readViewport?: VgcReadViewportFn;
}

/**
 * Capture a redacted viewport screenshot for a capsule and store it in the M1B
 * frame store. Internal/backend-only — never wired into endpoints in this slice.
 *
 * Order is deliberate: flag → capsule → terminal → capture → viewport → store.
 * Flag-off short-circuits BEFORE any capture/viewport call (no CDP touched). Any
 * capture/redaction/viewport failure stores NOTHING — the frame store is only
 * ever reached with a successful PNG and a valid viewport.
 */
export async function captureVisualGestureCapsuleScreenshotFrame(
  input: CaptureVisualGestureCapsuleScreenshotFrameInput,
): Promise<CaptureVisualGestureCapsuleScreenshotFrameResult> {
  // 1. Flag gate FIRST — never call capture/viewport when off.
  if (!isVisualGestureCapsuleEnabled()) return { ok: false, reason: "flag_disabled" };

  // 2/3. Resolve capsule (lazy-expiring); refuse missing/terminal.
  const capsule = getVisualGestureCapsule(input.capsuleId);
  if (!capsule) return { ok: false, reason: "not_found" };
  if (isTerminalVisualGestureStatus(capsule.status)) return { ok: false, reason: "terminal" };

  const capture = input.capture ?? defaultVgcCapture;
  const readViewport = input.readViewport ?? defaultVgcReadViewport;

  // 4. Redacted capture. Fail-closed: store nothing on any non-ok result.
  const shot = await capture({
    cdpUrl: input.cdpUrl,
    ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
    ...(input.expectedUrl !== undefined ? { expectedUrl: input.expectedUrl } : {}),
  });
  if (!shot.ok) {
    return {
      ok: false,
      reason: shot.redaction_mismatch ? "redaction_failed" : "capture_failed",
      ...(shot.error ? { error: shot.error } : {}),
    };
  }

  // 5. Viewport read. Invalid/missing dims store nothing.
  const vp = await readViewport({
    cdpUrl: input.cdpUrl,
    ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
  });
  if (
    !vp ||
    !Number.isFinite(vp.width) ||
    vp.width <= 0 ||
    !Number.isFinite(vp.height) ||
    vp.height <= 0
  ) {
    return { ok: false, reason: "invalid_viewport" };
  }

  // 6. Store through the M1B frame store (its own flag/missing/terminal/invalid
  //    guards are a backstop; we don't re-derive its reasons here). Scroll/layout
  //    metadata is forwarded when the reader supplied it (the store keeps only
  //    finite values), enabling the relay's scroll/layout staleness guard.
  const stored = storeVisualGestureCapsuleScreenshotFrame(input.capsuleId, {
    png_base64: shot.png_base64,
    viewport_css_width: vp.width,
    viewport_css_height: vp.height,
    ...(vp.scrollX !== undefined ? { scroll_x: vp.scrollX } : {}),
    ...(vp.scrollY !== undefined ? { scroll_y: vp.scrollY } : {}),
    ...(vp.layoutW !== undefined ? { layout_w: vp.layoutW } : {}),
    ...(vp.layoutH !== undefined ? { layout_h: vp.layoutH } : {}),
  });
  if (!stored.ok) return { ok: false, reason: "store_failed" };

  // 7. Safe metadata only — no bytes, dims, or coords.
  return {
    ok: true,
    capsule_id: input.capsuleId,
    screenshot_available: true,
    screenshot_captured_at: stored.frame.captured_at,
    screenshot_expires_at: stored.frame.expires_at,
  };
}

// ─── Default production readers (thin, fail-safe) ─────────────────────────────
//
// Only reached when callers omit the seams. No endpoint wiring exists in M1C, so
// these are exercised only by future wiring / optional integration tests — kept
// minimal and fail-safe (never throw, never log secrets).

/**
 * Default capture: resolve the live page target from `cdpUrl` and reuse
 * `captureRedactedScreenshot`. No protected-field args are passed — opaque HV
 * walls have no Antigen-filled values; a later milestone's endpoint wiring can
 * supply session-scoped protected fields. Maps `base64` → `png_base64` and
 * propagates `redaction_mismatch`.
 */
export const defaultVgcCapture: VgcCaptureFn = async ({ cdpUrl }) => {
  const resolved = await resolveSnapshotCdpTarget(cdpUrl);
  if (!resolved) return { ok: false, error: "cdp_target_unavailable" };
  const shot = await captureRedactedScreenshot({
    browserWsUrl: resolved.browserWsUrl,
    pageTargetId: resolved.target.id,
  });
  if (!shot.ok) {
    return {
      ok: false,
      ...(shot.redaction_mismatch ? { redaction_mismatch: true } : {}),
      error: "SCREENSHOT_REDACTION_FAILED",
    };
  }
  return { ok: true, png_base64: shot.base64 };
};

/**
 * Default viewport reader: minimal raw-WS `Runtime.evaluate` against the resolved
 * browser WS + page target. Reads `window.innerWidth/innerHeight` (CSS viewport
 * size), `window.scrollX/scrollY` (document scroll offset), and
 * `documentElement.scrollWidth/scrollHeight` (layout extent) — all structural
 * geometry, no value reads, no DOM mutation. Returns null on any transport/parse/
 * shape failure. Scroll/layout are best-effort: size is required, the rest are
 * passed through only when finite so the staleness guard can use them.
 */
export const defaultVgcReadViewport: VgcReadViewportFn = async ({ cdpUrl }) => {
  const resolved = await resolveSnapshotCdpTarget(cdpUrl);
  if (!resolved) return null;
  // Lazy import keeps `ws` out of the module's static surface (parity with the
  // redaction primitive, which also imports `ws` at runtime).
  const { default: WebSocket } = await import("ws");
  const EXPR = `(function(){var d=document.documentElement||{};return {vw:window.innerWidth,vh:window.innerHeight,sx:window.scrollX,sy:window.scrollY,lw:d.scrollWidth,lh:d.scrollHeight};})()`;

  return await new Promise<{
    width: number;
    height: number;
    scrollX?: number;
    scrollY?: number;
    layoutW?: number;
    layoutH?: number;
  } | null>((resolve) => {
    let settled = false;
    let ws: import("ws").WebSocket | null = null;
    let msgId = 1;
    const pending = new Map<number, (r: Record<string, unknown> | undefined, e?: unknown) => void>();

    const finish = (
      value: {
        width: number;
        height: number;
        scrollX?: number;
        scrollY?: number;
        layoutW?: number;
        layoutH?: number;
      } | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 8_000);

    try {
      ws = new WebSocket(resolved.browserWsUrl);
    } catch {
      return finish(null);
    }

    const send = (method: string, p: Record<string, unknown> = {}, sid?: string) =>
      new Promise<Record<string, unknown> | undefined>((res, rej) => {
        const id = msgId++;
        pending.set(id, (r, e) => (e ? rej(e) : res(r)));
        const message: Record<string, unknown> = { id, method, params: p };
        if (sid) message.sessionId = sid;
        ws?.send(JSON.stringify(message));
      });

    ws.on("open", () => {
      void (async () => {
        const attach = await send("Target.attachToTarget", {
          targetId: resolved.target.id,
          flatten: true,
        });
        const sessionId = (attach?.sessionId as string) ?? null;
        if (!sessionId) return finish(null);
        const evalRes = await send(
          "Runtime.evaluate",
          { expression: EXPR, returnByValue: true },
          sessionId,
        );
        const val = (evalRes?.result as Record<string, unknown> | undefined)?.value as
          | { vw?: number; vh?: number; sx?: number; sy?: number; lw?: number; lh?: number }
          | undefined;
        const width = typeof val?.vw === "number" ? val.vw : NaN;
        const height = typeof val?.vh === "number" ? val.vh : NaN;
        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
          return finish(null);
        }
        // Scroll/layout are best-effort: forward only finite values (scroll may be
        // 0; layout extents must be > 0). Size already validated above.
        const fin = (n: unknown): number | undefined =>
          typeof n === "number" && Number.isFinite(n) ? n : undefined;
        const layoutW = typeof val?.lw === "number" && val.lw > 0 ? val.lw : undefined;
        const layoutH = typeof val?.lh === "number" && val.lh > 0 ? val.lh : undefined;
        return finish({
          width,
          height,
          ...(fin(val?.sx) !== undefined ? { scrollX: fin(val?.sx) } : {}),
          ...(fin(val?.sy) !== undefined ? { scrollY: fin(val?.sy) } : {}),
          ...(layoutW !== undefined ? { layoutW } : {}),
          ...(layoutH !== undefined ? { layoutH } : {}),
        });
      })().catch(() => finish(null));
    });

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const id = msg.id as number | undefined;
      if (id === undefined) return;
      const cb = pending.get(id);
      if (!cb) return;
      pending.delete(id);
      if (msg.error) cb(undefined, msg.error);
      else cb(msg.result as Record<string, unknown> | undefined);
    });

    ws.on("error", () => finish(null));
  });
};
