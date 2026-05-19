import { chromium } from "playwright";
import type { ObservationDryRunOpenSummary } from "@aegis/types";
import { buildMinimalOpenObservation } from "./agentSafeObservation.js";

export interface TaskBrowserControlResult {
  current_url: string;
  snapshot: ObservationDryRunOpenSummary;
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
    (browser as any).disconnect();
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
    (browser as any).disconnect();
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
    const snapshot = await buildMinimalOpenObservation(page);
    return { current_url: page.url(), snapshot };
  } finally {
    (browser as any).disconnect();
  }
}
