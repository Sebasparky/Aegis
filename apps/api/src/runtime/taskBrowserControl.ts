import { chromium } from "playwright";
import type { ObservationDryRunOpenSummary } from "@aegis/types";
import { buildMinimalOpenObservation } from "./agentSafeObservation.js";
import { extractPageTextSignals } from "../lib/loginDiagnostics.js";
import {
  makePointerRuntimeState,
  clickPointWithPointer,
  renderPersistentPointerCursor,
} from "./nativePointerRuntime.js";
import { getLoadedPointerTraces } from "./pointerProfileLoader.js";

export interface TaskBrowserControlResult {
  current_url: string;
  snapshot: ObservationDryRunOpenSummary;
  /** @internal — stripped from API responses; used by the click handler for login diagnostics */
  _page_text_signals?: string[];
}

function safeDisconnectFromCdp(browser: unknown): void {
  try {
    if (typeof (browser as any)?.disconnect === "function") {
      (browser as any).disconnect();
    }
  } catch {
    // cleanup errors must not propagate — operation result takes priority
  }
}

async function getActivePage(browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>) {
  const ctx = browser.contexts()[0];
  if (!ctx) {
    const newCtx = await browser.newContext();
    return newCtx.newPage();
  }
  const pages = ctx.pages();
  return pages.at(-1) ?? ctx.newPage();
}

export async function connectAndNavigate(cdp_url: string, url: string): Promise<TaskBrowserControlResult> {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    browser = await chromium.connectOverCDP(cdp_url);
  } catch (err) {
    const e = new Error(`Failed to connect to task browser via CDP: ${(err as Error).message}`) as Error & { code: string };
    e.code = "CDP_CONNECT_FAILED";
    throw e;
  }
  try {
    const page = await getActivePage(browser);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch (err) {
      const e = new Error(`Navigation failed: ${(err as Error).message}`) as Error & { code: string };
      e.code = "NAVIGATION_FAILED";
      throw e;
    }
    const snapshot = await buildMinimalOpenObservation(page);
    return { current_url: page.url(), snapshot };
  } finally {
    safeDisconnectFromCdp(browser);
  }
}

export async function connectAndObserve(cdp_url: string): Promise<TaskBrowserControlResult> {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    browser = await chromium.connectOverCDP(cdp_url);
  } catch (err) {
    const e = new Error(`Failed to connect to task browser via CDP: ${(err as Error).message}`) as Error & { code: string };
    e.code = "CDP_CONNECT_FAILED";
    throw e;
  }
  try {
    const page = await getActivePage(browser);
    const snapshot = await buildMinimalOpenObservation(page);
    return { current_url: page.url(), snapshot };
  } finally {
    safeDisconnectFromCdp(browser);
  }
}

export interface PointerNavOptions {
  pointer_state?: { x: number; y: number; initialized: boolean };
  browser_session_id?: string;
  debug_overlay?: boolean;
}

export interface NavigateWithPointerResult extends TaskBrowserControlResult {
  final_pointer?: { x: number; y: number };
  pointer_source?: "viewport_center" | "saved_state";
  nav_mode: "page_level_nav_marker_direct_goto" | "direct_fallback";
}

/**
 * Navigates to a URL while moving the persistent debug cursor to a page-level
 * nav marker (top-center of the viewport) before the goto.
 *
 * CDP page input cannot click Chrome browser chrome (address bar). V1 moves the
 * pointer to a viewport-level marker at y=24 (inside the page, near the top),
 * performs direct page.goto, then rehydrates the cursor on the new page.
 *
 * nav_mode: "page_level_nav_marker_direct_goto" — pointer moved to marker, goto did nav.
 * nav_mode: "direct_fallback" — pointer prep failed; goto still ran, no final_pointer.
 *
 * page.goto failures are never swallowed — NAVIGATION_FAILED propagates normally.
 */
export async function connectAndNavigateWithPointer(
  cdp_url: string,
  url: string,
  pointerOpts?: PointerNavOptions,
): Promise<NavigateWithPointerResult> {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    browser = await chromium.connectOverCDP(cdp_url);
  } catch (err) {
    const e = new Error(`Failed to connect to task browser via CDP: ${(err as Error).message}`) as Error & { code: string };
    e.code = "CDP_CONNECT_FAILED";
    throw e;
  }
  try {
    const page = await getActivePage(browser);
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    const navMarker = { x: Math.round(vp.width / 2), y: 24 };

    let pointerFailed = false;
    let markerSendCdp: ((method: string, params: Record<string, unknown>) => void) | undefined;
    let navMarkerReached = false;
    let pointer_source: "viewport_center" | "saved_state" = "viewport_center";

    // Pointer-prep: narrowly scoped — only CDP session creation and marker movement.
    // page.goto runs outside this catch and is never swallowed.
    try {
      const cdpSession = await page.context().newCDPSession(page);
      const sendCdp = (method: string, params: Record<string, unknown>) => {
        void cdpSession.send(method as any, params);
      };
      markerSendCdp = sendCdp;
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

      const ps = pointerOpts?.pointer_state;
      pointer_source = ps ? "saved_state" : "viewport_center";
      const state = makePointerRuntimeState({
        current_x: ps ? ps.x : vp.width / 2,
        current_y: ps ? ps.y : vp.height / 2,
        viewport_width: vp.width,
        viewport_height: vp.height,
        browser_session_id: pointerOpts?.browser_session_id,
      });

      if (process.env.ANTIGEN_CDP_DIAGNOSTICS === "true" || process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true") {
        const logKey = ps ? "loaded" : "initialized";
        console.log(`[PointerState] ${logKey}`, {
          browser_session_id: pointerOpts?.browser_session_id,
          x: Math.round(state.current_x),
          y: Math.round(state.current_y),
          surface: "navigation",
        });
      }

      await clickPointWithPointer(state, navMarker, sendCdp, sleep, {
        debugOverlay: pointerOpts?.debug_overlay,
        debugLabel: "nav_marker",
        templateTraces: getLoadedPointerTraces(),
        purpose: "button_click",
      });

      if (process.env.ANTIGEN_CDP_DIAGNOSTICS === "true" || process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true") {
        console.log("[PointerNav] pointer pre-navigation marker", {
          browser_session_id: pointerOpts?.browser_session_id,
          x: navMarker.x,
          y: navMarker.y,
          url,
        });
      }

      navMarkerReached = true;
    } catch (pointerErr) {
      pointerFailed = true;
      if (process.env.ANTIGEN_CDP_DIAGNOSTICS === "true" || process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true") {
        console.log("[PointerNav] pointer-backed navigation failed, using direct fallback", {
          browser_session_id: pointerOpts?.browser_session_id,
          error: (pointerErr as Error).message,
        });
      }
    }

    // Navigation always runs — pointer failure does not prevent it.
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch (err) {
      const e = new Error(`Navigation failed: ${(err as Error).message}`) as Error & { code: string };
      e.code = "NAVIGATION_FAILED";
      throw e;
    }

    // Rehydrate the cursor on the new page (DOM overlay is destroyed on navigation).
    if (navMarkerReached && markerSendCdp && pointerOpts?.debug_overlay) {
      try {
        renderPersistentPointerCursor(markerSendCdp, navMarker, { label: "post_nav" });
      } catch {
        // Cursor rehydration is non-fatal.
      }
    }

    const snapshot = await buildMinimalOpenObservation(page);

    if (!pointerFailed) {
      return {
        current_url: page.url(),
        snapshot,
        final_pointer: navMarker,
        pointer_source,
        nav_mode: "page_level_nav_marker_direct_goto",
      };
    }
    return {
      current_url: page.url(),
      snapshot,
      nav_mode: "direct_fallback",
    };
  } finally {
    safeDisconnectFromCdp(browser);
  }
}

export async function connectAndClick(cdp_url: string, selector: string): Promise<TaskBrowserControlResult> {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    browser = await chromium.connectOverCDP(cdp_url);
  } catch (err) {
    const e = new Error(`Failed to connect to task browser via CDP: ${(err as Error).message}`) as Error & { code: string };
    e.code = "CDP_CONNECT_FAILED";
    throw e;
  }
  try {
    const page = await getActivePage(browser);
    try {
      await page.locator(selector).first().click({ timeout: 5_000 });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const e = new Error(`Selector not found or not clickable: ${msg}`) as Error & { code: string };
      e.code = msg.toLowerCase().includes("timeout") ? "SELECTOR_NOT_FOUND" : "CLICK_FAILED";
      throw e;
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    const _page_text_signals = await extractPageTextSignals(page);
    const snapshot = await buildMinimalOpenObservation(page);
    return { current_url: page.url(), snapshot, _page_text_signals };
  } finally {
    safeDisconnectFromCdp(browser);
  }
}
