import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { AegisRoute, RoutePreviewAsset } from "@aegis/types";
import { newId } from "../store/index.js";

const __filename = fileURLToPath(import.meta.url);
export const PREVIEW_DIR = join(dirname(__filename), "../../.data/route-previews");

export function resolveStartUrl(route: AegisRoute): string | null {
  if (route.start_url) return route.start_url;
  if (route.domain === "en.wikipedia.org") return "https://en.wikipedia.org/wiki/Main_Page";
  if (
    route.domain === "localhost" ||
    route.domain === "127.0.0.1" ||
    route.domain === "test.aegis.local"
  ) return null;
  return null;
}

export async function captureRouteStartPreview(route: AegisRoute): Promise<RoutePreviewAsset | null> {
  const startUrl = resolveStartUrl(route);
  if (!startUrl) return null;

  let browser: import("playwright").Browser | null = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

    // Redact sensitive fields before capturing (raw JS string — no DOM lib in Node tsconfig)
    await page.evaluate(`(function() {
      document.querySelectorAll('input[type="password"], input[autocomplete="current-password"], input[autocomplete="cc-number"], input[autocomplete="cc-csc"], input[autocomplete="one-time-code"]').forEach(function(el) {
        el.value = '';
        el.setAttribute('placeholder', '\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022');
      });
      document.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="password"]), textarea').forEach(function(el) {
        el.value = '';
      });
    })()`);

    const buf = await page.screenshot({ type: "png", fullPage: false });

    await mkdir(PREVIEW_DIR, { recursive: true });
    const filename = `${route.route_id}-start-${Date.now()}.png`;
    await writeFile(join(PREVIEW_DIR, filename), buf);

    return {
      asset_id: newId("rpa"),
      kind: "start_page",
      route_id: route.route_id,
      url_path: `/api/route-preview-assets/${filename}`,
      captured_at: new Date().toISOString(),
      width: 1280,
      height: 800,
      redaction_applied: true,
      source: "manual_capture",
    };
  } catch (err) {
    console.error("[routePreviewCapture] Capture failed:", err);
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore close errors */ }
    }
  }
}
