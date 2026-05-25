import { writeFile, mkdir, rename, copyFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import type { AegisRoute, RoutePreviewAsset, RouteReplayAsset, RouteStep, RouteLocator } from "@aegis/types";
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

// ─── Replay Capture ───────────────────────────────────────────────────────────

const SENSITIVE_CLICK_RE = /\b(submit|confirm|pay|purchase|checkout|sign[\s-]?in|log[\s-]?in|transfer|delete|remove|download|buy|order|proceed|authorize|approve)\b/i;

export function classifyStepSafety(step: RouteStep): "safe" | "sensitive" {
  if (step.approval_required) return "sensitive";

  if (step.action === "fill") {
    if (step.value_policy?.type === "safe_literal" && step.value_policy.value !== undefined) return "safe";
    return "sensitive";
  }

  if (step.action === "click") {
    const text = `${step.intent} ${step.description}`;
    if (SENSITIVE_CLICK_RE.test(text)) return "sensitive";
    return "safe";
  }

  if (step.action === "navigate" || step.action === "read") return "safe";

  // Conservative default — unknown or ambiguous actions are treated as sensitive.
  return "sensitive";
}

function routeHash(route: AegisRoute): string {
  const input = `${route.route_id}:${route.version}:${route.steps.map(s => s.step_id).join(",")}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

async function resolveLocatorForReplay(
  page: import("playwright").Page,
  target: import("@aegis/types").ElementTarget,
): Promise<import("playwright").Locator | null> {
  const allLocators: RouteLocator[] = [target.preferred_locator, ...target.fallback_locators];
  for (const loc of allLocators) {
    try {
      let candidate: import("playwright").Locator;
      if (loc.type === "label" && loc.name) {
        candidate = page.getByLabel(loc.name).first();
      } else if (loc.type === "placeholder" && loc.value) {
        candidate = page.getByPlaceholder(loc.value).first();
      } else if (loc.type === "role" && loc.role) {
        const opts = loc.name ? { name: loc.name } : {};
        candidate = page.getByRole(loc.role as Parameters<typeof page.getByRole>[0], opts).first();
      } else if (loc.type === "css" && loc.value) {
        candidate = page.locator(loc.value).first();
      } else if (loc.type === "testid" && loc.value) {
        candidate = page.getByTestId(loc.value).first();
      } else {
        continue;
      }
      if (await candidate.count() > 0) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function captureRouteReplay(route: AegisRoute): Promise<RouteReplayAsset[] | null> {
  const startUrl = resolveStartUrl(route);
  if (!startUrl) return null;

  // Classify steps and determine replay_safety before launching browser.
  let firstSensitiveIdx = route.steps.findIndex(s => classifyStepSafety(s) === "sensitive");
  const safeSteps = firstSensitiveIdx === -1 ? route.steps : route.steps.slice(0, firstSensitiveIdx);
  const replaySafety: RouteReplayAsset["replay_safety"] =
    route.steps.length === 0 || firstSensitiveIdx === 0 ? "static_only" :
    firstSensitiveIdx === -1 ? "full" :
    "partial";
  const stopReason: string | undefined =
    replaySafety === "partial"
      ? `Stopped before: ${route.steps[firstSensitiveIdx].description}`
      : undefined;

  const hash = routeHash(route);
  const ts = Date.now();
  let browser: import("playwright").Browser | null = null;
  const tmpVideoDir = join(PREVIEW_DIR, `tmp-video-${route.route_id}-${ts}`);

  try {
    await mkdir(PREVIEW_DIR, { recursive: true });
    await mkdir(tmpVideoDir, { recursive: true });

    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      recordVideo: { dir: tmpVideoDir, size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 20000 });

    // Capture poster frame from the clean start page (before any fills).
    const posterBuf = await page.screenshot({ type: "png", fullPage: false });

    // Execute safe steps only.
    for (const step of safeSteps) {
      try {
        if (step.action === "fill" && step.value_policy?.type === "safe_literal" && step.value_policy.value !== undefined) {
          const locator = await resolveLocatorForReplay(page, step.target);
          if (locator) {
            await locator.fill(step.value_policy.value);
            await page.waitForTimeout(400);
          }
        } else if (step.action === "click") {
          const locator = await resolveLocatorForReplay(page, step.target);
          if (locator) {
            await locator.click();
            await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(800);
          }
        }
      } catch (stepErr) {
        // Step failed — do not abort entire capture, just skip this step.
        console.warn(`[routeReplayCapture] Step ${step.step_id} failed:`, stepErr);
      }
    }

    // Allow final page state to settle before closing.
    await page.waitForTimeout(500);

    // Closing the page finalizes the video recording.
    await page.close();
    const videoFile = page.video();
    let videoSrcPath: string | null = null;
    if (videoFile) {
      try { videoSrcPath = await videoFile.path(); } catch { /* no video produced */ }
    }
    await context.close();

    // Save poster PNG.
    const posterFilename = `${route.route_id}-poster-${ts}.png`;
    await writeFile(join(PREVIEW_DIR, posterFilename), posterBuf);

    // Move video to stable location if it was produced.
    let videoFilename: string | null = null;
    if (videoSrcPath) {
      videoFilename = `${route.route_id}-replay-${ts}.webm`;
      const destPath = join(PREVIEW_DIR, videoFilename);
      try {
        await rename(videoSrcPath, destPath);
      } catch (renameErr: any) {
        if (renameErr?.code === "EXDEV") {
          await copyFile(videoSrcPath, destPath);
          await unlink(videoSrcPath).catch(() => {});
        } else {
          throw renameErr;
        }
      }
    }

    const capturedAt = new Date().toISOString();
    const assets: RouteReplayAsset[] = [];

    const posterAsset: RouteReplayAsset = {
      asset_id: newId("rra"),
      route_id: route.route_id,
      route_hash: hash,
      kind: "poster_frame",
      url_path: `/api/route-preview-assets/${posterFilename}`,
      captured_at: capturedAt,
      width: 1280,
      height: 800,
      redaction_applied: true,
      source: "manual_capture",
      replay_safety: replaySafety,
      stop_reason: stopReason,
    };
    assets.push(posterAsset);

    if (videoFilename) {
      const videoAsset: RouteReplayAsset = {
        asset_id: newId("rra"),
        route_id: route.route_id,
        route_hash: hash,
        kind: "replay_video",
        url_path: `/api/route-preview-assets/${videoFilename}`,
        poster_url_path: posterAsset.url_path,
        captured_at: capturedAt,
        width: 1280,
        height: 800,
        redaction_applied: true,
        source: "manual_capture",
        replay_safety: replaySafety,
        stop_reason: stopReason,
      };
      assets.push(videoAsset);
    }

    return assets;
  } catch (err) {
    console.error("[routeReplayCapture] Replay capture failed:", err);
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    // Clean up tmp video dir (best-effort).
    try {
      const { rm } = await import("fs/promises");
      await rm(tmpVideoDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
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
