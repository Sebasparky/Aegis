// Protected sessions must not use the user's normal browser profile.
// Each session gets a fresh isolated BrowserContext with no shared cookies or storage.

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { SessionController } from "./sessionController.js";

interface BrowserEntry {
  context: BrowserContext;
  page: Page;
  controller: SessionController;
}

let headlessBrowser: Browser | null = null;
let visibleBrowser: Browser | null = null;
const sessionContexts = new Map<string, BrowserEntry>();

async function getBrowser(headless: boolean): Promise<Browser> {
  if (headless) {
    if (!headlessBrowser) headlessBrowser = await chromium.launch({ headless: true });
    return headlessBrowser;
  }
  if (!visibleBrowser) visibleBrowser = await chromium.launch({ headless: false });
  return visibleBrowser;
}

export async function createBrowserSession(
  sessionId: string,
  mode: "headless" | "visible" = "headless"
): Promise<SessionController> {
  const browser = await getBrowser(mode !== "visible");
  const context = await browser.newContext();
  const page = await context.newPage();
  const controller = new SessionController(page, context);
  sessionContexts.set(sessionId, { context, page, controller });
  return controller;
}

export function getController(sessionId: string): SessionController | undefined {
  return sessionContexts.get(sessionId)?.controller;
}

export async function closeBrowserSession(sessionId: string): Promise<void> {
  const entry = sessionContexts.get(sessionId);
  if (entry) {
    await entry.context.close().catch(() => {});
    sessionContexts.delete(sessionId);
  }
}

async function cleanupAll(): Promise<void> {
  for (const entry of sessionContexts.values()) {
    await entry.context.close().catch(() => {});
  }
  sessionContexts.clear();
  await headlessBrowser?.close().catch(() => {});
  await visibleBrowser?.close().catch(() => {});
  headlessBrowser = null;
  visibleBrowser = null;
}

process.on("SIGINT", () => cleanupAll().finally(() => process.exit(0)));
process.on("SIGTERM", () => cleanupAll().finally(() => process.exit(0)));
process.on("exit", () => {
  for (const entry of sessionContexts.values()) {
    entry.context.close().catch(() => {});
  }
});
