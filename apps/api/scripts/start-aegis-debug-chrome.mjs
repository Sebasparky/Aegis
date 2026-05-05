#!/usr/bin/env node
/**
 * start-aegis-debug-chrome.mjs
 *
 * Launches Chrome with remote debugging enabled for Aegis agent sessions.
 *
 * Default (ephemeral): creates a fresh /tmp/aegis-agent-browser-<timestamp> profile.
 * The temp directory is deleted when Chrome exits or on Ctrl+C.
 * Chrome preferences disable password saving, autofill, card saving, and sync.
 *
 * Dev mode (--persistent-dev): uses ~/.aegis-chrome-debug-dev (NOT deleted on exit).
 * For local development only. Do NOT use for real credential injection testing.
 *
 * Usage:
 *   npm run chrome:agent             # ephemeral (default)
 *   npm run chrome:agent:dev         # persistent dev profile
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { createServer } from "net";

const PERSISTENT_DEV_FLAG = "--persistent-dev";
const isPersistentDev = process.argv.includes(PERSISTENT_DEV_FLAG);
const CDP_PORT = parseInt(process.env.AEGIS_CDP_PORT ?? "9222", 10);

// ── Chrome binary detection ────────────────────────────────────────────────────

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
];

const chromeBin = CHROME_PATHS.find((p) => existsSync(p));
if (!chromeBin) {
  console.error("[aegis] Chrome not found. Install Google Chrome or Chromium in /Applications.");
  console.error("[aegis] Searched:");
  CHROME_PATHS.forEach((p) => console.error(`  ${p}`));
  process.exit(1);
}

// ── Port availability check ────────────────────────────────────────────────────

async function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => { server.close(); resolve(false); });
    server.listen(port, "127.0.0.1");
  });
}

const portBusy = await isPortInUse(CDP_PORT);
if (portBusy) {
  console.error(`[aegis] ERROR: Port ${CDP_PORT} is already in use.`);
  console.error("[aegis] Another Chrome instance or process is already listening on this port.");
  console.error("[aegis] If you were previously using a persistent Chrome profile, close it first.");
  console.error(`[aegis] Check with: lsof -i :${CDP_PORT}`);
  console.error(`[aegis] To use a different port: AEGIS_CDP_PORT=9223 npm run chrome:agent`);
  process.exit(1);
}

// ── User-data-dir ──────────────────────────────────────────────────────────────

let userDataDir;

if (isPersistentDev) {
  userDataDir = join(homedir(), ".aegis-chrome-debug-dev");
  console.warn("[aegis] ⚠  WARNING: --persistent-dev mode.");
  console.warn("[aegis]    Session data will persist in:", userDataDir);
  console.warn("[aegis]    This mode is for local development ONLY.");
  console.warn("[aegis]    Do NOT use this for real credential injection testing.");
  console.warn("[aegis]    The session will remain authenticated after Chrome closes.");
} else {
  userDataDir = join(tmpdir(), `aegis-agent-browser-${Date.now()}`);
}

// Create profile directories
mkdirSync(join(userDataDir, "Default"), { recursive: true });

// ── Chrome Preferences: disable password saving, autofill, card saving, sync ──

const prefs = {
  profile: { password_manager_enabled: false },
  credentials_enable_service: false,
  credentials_enable_autosignin: false,
  autofill: {
    enabled: false,
    credit_card_enabled: false,
    profile_enabled: false,
  },
  payments: { can_make_payment: false },
  sync: { suppress_start: true, requested: false },
};

writeFileSync(
  join(userDataDir, "Default", "Preferences"),
  JSON.stringify(prefs, null, 2),
  "utf8",
);

// ── Chrome flags ───────────────────────────────────────────────────────────────

const chromeArgs = [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userDataDir}`,
  "--disable-save-password-bubble",
  "--password-store=basic",
  "--disable-sync",
  "--no-first-run",
  "--disable-default-apps",
  "--no-default-browser-check",
];

// ── Launch ─────────────────────────────────────────────────────────────────────

const chrome = spawn(chromeBin, chromeArgs, { stdio: "ignore", detached: false });

if (!isPersistentDev) {
  console.log("[aegis] Chrome launched — remote debugging on port", CDP_PORT);
  console.log("[aegis] CDP endpoint:  http://localhost:" + CDP_PORT);
  console.log("[aegis] User data dir:", userDataDir, " (EPHEMERAL — deleted on exit)");
  console.log("[aegis] Set AEGIS_PLAYWRIGHT_CDP_URL=http://localhost:" + CDP_PORT + " in your .env");
  console.log("[aegis] Press Ctrl+C to stop Chrome and clean up.");
} else {
  console.log("[aegis] Chrome launched (dev/persistent) — remote debugging on port", CDP_PORT);
  console.log("[aegis] CDP endpoint:  http://localhost:" + CDP_PORT);
  console.log("[aegis] User data dir:", userDataDir);
  console.log("[aegis] Set AEGIS_PLAYWRIGHT_CDP_URL=http://localhost:" + CDP_PORT + " in your .env");
}

// ── Cleanup ────────────────────────────────────────────────────────────────────

function cleanup() {
  if (isPersistentDev) return;
  try {
    rmSync(userDataDir, { recursive: true, force: true });
    console.log("[aegis] Ephemeral session cleaned up:", userDataDir);
  } catch {
    // Best-effort — ignore errors (e.g. dir already deleted or permissions issue)
  }
}

chrome.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  chrome.kill("SIGTERM");
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  chrome.kill("SIGTERM");
  cleanup();
  process.exit(0);
});
