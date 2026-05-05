import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { createServer } from "net";
import type { TaskBrowserSession, TaskBrowserSessionStatus } from "@aegis/types";
import { newId, MOCK_USER_ID } from "../store/index.js";

// ─── Chrome binary detection ──────────────────────────────────────────────────

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
];

export function findChromeBinary(): string | undefined {
  return CHROME_PATHS.find((p) => existsSync(p));
}

// ─── In-memory Maps ───────────────────────────────────────────────────────────
// taskBrowserProcesses is private — never expose PIDs or process handles to agents

export const taskBrowserSessions = new Map<string, TaskBrowserSession>();
const taskBrowserProcesses = new Map<string, ChildProcess>();
// Tracks sessions being intentionally closed so the exit handler doesn't mark them failed.
const closingTaskBrowserSessions = new Set<string>();

// ─── Port availability ────────────────────────────────────────────────────────

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => { server.close(); resolve(false); });
    server.listen(port, "127.0.0.1");
  });
}

// ─── CDP readiness poll ───────────────────────────────────────────────────────

async function waitForCdpReady(port: number, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // Chrome not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Object.assign(new Error(`CDP not ready on port ${port} after ${timeoutMs}ms`), {
    code: "CDP_NOT_READY",
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeCleanupDir(userDataDir: string): void {
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // Best-effort — ignore errors (e.g. dir already deleted or permissions issue)
  }
}

// Resolves true when the process exits, false on timeout.
function waitForProcessExit(proc: ChildProcess, timeoutMs = 3000): Promise<boolean> {
  if (proc.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(result);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    proc.once("exit", () => done(true));
    proc.once("close", () => done(true));
  });
}

function updateStatus(session: TaskBrowserSession, status: TaskBrowserSessionStatus): void {
  session.status = status;
  taskBrowserSessions.set(session.browser_session_id, session);
}

// ─── Port conflict resolution helpers ────────────────────────────────────────

// Single-attempt CDP liveness check — used to verify a tracked session is still alive.
async function isCdpAlive(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://localhost:${port}/json/version`, { signal: controller.signal as RequestInit["signal"] });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

// Polls until port is free or timeout elapses. Used after SIGTERMing a stale session.
async function waitForPortFree(port: number, timeoutMs = 700): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Returns the first tracked session bound to the given port, or undefined.
function findSessionByPort(port: number): TaskBrowserSession | undefined {
  for (const s of taskBrowserSessions.values()) {
    if (s.cdp_port === port) return s;
  }
  return undefined;
}

// Returns the first available port from the list, or null if all are busy.
async function findAvailablePort(ports: number[]): Promise<number | null> {
  for (const port of ports) {
    if (!(await isPortInUse(port))) return port;
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CreateTaskBrowserOptions {
  user_id?: string;
  delegation_id?: string;
}

export interface CreateTaskBrowserResult {
  session: TaskBrowserSession;
  reused_existing?: true;
  port_auto_selected?: true;
  requires_browser_reconnect?: true;
  user_message: string;
}

// Extracted Chrome launch logic — creates a session on any given port.
async function launchChrome(
  opts: CreateTaskBrowserOptions,
  cdpPort: number,
): Promise<TaskBrowserSession> {
  const chromeBin = findChromeBinary();
  if (!chromeBin) {
    throw Object.assign(
      new Error("Chrome not found. Install Google Chrome or Chromium in /Applications."),
      { code: "CHROME_NOT_FOUND" },
    );
  }

  const userId = opts.user_id ?? MOCK_USER_ID;
  const browser_session_id = newId("tbsess");
  const user_data_dir = join(tmpdir(), `aegis-agent-browser-${browser_session_id}`);
  const cdp_url = `http://localhost:${cdpPort}`;
  const now = new Date();

  const session: TaskBrowserSession = {
    browser_session_id,
    user_id: userId,
    delegation_id: opts.delegation_id,
    status: "starting",
    cdp_url,
    cdp_port: cdpPort,
    user_data_dir,
    ephemeral: true,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
  };
  taskBrowserSessions.set(browser_session_id, session);

  try {
    mkdirSync(join(user_data_dir, "Default"), { recursive: true });

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
      join(user_data_dir, "Default", "Preferences"),
      JSON.stringify(prefs, null, 2),
      "utf8",
    );

    const chromeArgs = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${user_data_dir}`,
      "--disable-save-password-bubble",
      "--password-store=basic",
      "--disable-sync",
      "--no-first-run",
      "--disable-default-apps",
      "--no-default-browser-check",
    ];

    const chrome = spawn(chromeBin, chromeArgs, { stdio: "ignore", detached: false });
    taskBrowserProcesses.set(browser_session_id, chrome);

    chrome.on("exit", () => {
      // Only mark failed for genuine crashes — not for intentional closeTaskBrowserSession calls.
      if (!closingTaskBrowserSessions.has(browser_session_id)) {
        const current = taskBrowserSessions.get(browser_session_id);
        if (current && current.status === "ready") {
          current.status = "failed";
          current.error = "Chrome process exited unexpectedly";
          taskBrowserSessions.set(browser_session_id, current);
        }
        safeCleanupDir(user_data_dir);
      }
      taskBrowserProcesses.delete(browser_session_id);
    });

    await waitForCdpReady(cdpPort);

    updateStatus(session, "ready");
    return session;
  } catch (err: unknown) {
    session.status = "failed";
    session.error = err instanceof Error ? err.message : String(err);
    taskBrowserSessions.set(browser_session_id, session);

    // Kill Chrome if it was spawned
    const proc = taskBrowserProcesses.get(browser_session_id);
    if (proc) {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      taskBrowserProcesses.delete(browser_session_id);
    }
    safeCleanupDir(user_data_dir);

    throw err;
  }
}

const DEFAULT_CDP_PORT = 9222;
const ALTERNATE_CDP_PORTS = [9223, 9224, 9225, 9226, 9227, 9228, 9229, 9230];

export async function createTaskBrowserSession(
  opts: CreateTaskBrowserOptions = {},
): Promise<CreateTaskBrowserResult> {
  const portBusy = await isPortInUse(DEFAULT_CDP_PORT);

  if (!portBusy) {
    const session = await launchChrome(opts, DEFAULT_CDP_PORT);
    return { session, user_message: "Started a fresh Aegis task browser session." };
  }

  const existing = findSessionByPort(DEFAULT_CDP_PORT);

  // Case A: known ready session with live CDP — reuse without spawning Chrome
  if (existing && existing.status === "ready" && await isCdpAlive(DEFAULT_CDP_PORT)) {
    return { session: existing, reused_existing: true, user_message: "Reusing the active Aegis task browser session." };
  }

  // Case B: known stale session (expired or failed) — recycle and try same port
  if (existing && (existing.status === "expired" || existing.status === "failed")) {
    const proc = taskBrowserProcesses.get(existing.browser_session_id);
    if (proc) {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      taskBrowserProcesses.delete(existing.browser_session_id);
    }
    existing.status = "closed";
    existing.closed_at = new Date().toISOString();
    taskBrowserSessions.set(existing.browser_session_id, existing);

    const freed = await waitForPortFree(DEFAULT_CDP_PORT);
    if (freed) {
      const session = await launchChrome(opts, DEFAULT_CDP_PORT);
      return { session, user_message: "Started a fresh Aegis task browser session." };
    }
    // Port still busy after recycle — fall through to alternate ports below
  }

  // Case C: unknown process on default port (or stale port still busy after recycle)
  // Do not reuse or inject secrets into an untracked browser.
  if (!existing) {
    console.log("[TaskBrowser] Port 9222 occupied by unknown process — launching on alternate port");
  }

  const altPort = await findAvailablePort(ALTERNATE_CDP_PORTS);
  if (altPort !== null) {
    const session = await launchChrome(opts, altPort);
    return { session, port_auto_selected: true, requires_browser_reconnect: true, user_message: "Started a fresh Aegis task browser session." };
  }

  // Case D: no ports available in 9222–9230 range
  console.error("[TaskBrowser] All ports 9222–9230 occupied — cannot start task browser session");
  throw Object.assign(
    new Error("Aegis could not start a secure browser session. Please try again."),
    { code: "NO_PORTS_AVAILABLE" },
  );
}

export function getTaskBrowserSession(
  id: string,
  userId: string,
): TaskBrowserSession | undefined {
  const session = taskBrowserSessions.get(id);
  if (!session || session.user_id !== userId) return undefined;
  return session;
}

export async function closeTaskBrowserSession(id: string, userId: string): Promise<TaskBrowserSession> {
  const session = taskBrowserSessions.get(id);
  if (!session) throw Object.assign(new Error("Session not found."), { code: "NOT_FOUND" });
  if (session.user_id !== userId) throw Object.assign(new Error("Forbidden."), { code: "FORBIDDEN" });
  if (session.status === "closed") return session;

  const proc = taskBrowserProcesses.get(id);

  // Mark as intentionally closing so the exit handler does not set error/failed status.
  closingTaskBrowserSessions.add(id);

  try {
    // Send SIGTERM and wait for the process to exit or the port to free (whichever comes first).
    if (proc) {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      await Promise.race([
        waitForProcessExit(proc, 3000),
        waitForPortFree(session.cdp_port, 3000),
      ]);
    } else {
      await waitForPortFree(session.cdp_port, 3000);
    }

    // If the port is still occupied after SIGTERM, escalate to SIGKILL.
    let portBusy = await isPortInUse(session.cdp_port);
    if (portBusy && proc) {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      await waitForPortFree(session.cdp_port, 2000);
      portBusy = await isPortInUse(session.cdp_port);
    }

    taskBrowserProcesses.delete(id);

    // Clean profile directory (best-effort).
    safeCleanupDir(session.user_data_dir);
    const dirStillExists = existsSync(session.user_data_dir);

    // Set cleanup_complete only when the endpoint is actually gone and the profile is deleted.
    session.status = "closed";
    session.closed_at = new Date().toISOString();
    delete session.error;

    if (portBusy) {
      session.cleanup_complete = false;
      session.error = "Browser session close was requested, but the debugging endpoint is still active.";
    } else if (dirStillExists) {
      session.cleanup_complete = false;
      session.error = "Browser session closed, but profile cleanup did not complete.";
    } else {
      session.cleanup_complete = true;
    }

    taskBrowserSessions.set(id, session);
    return session;
  } finally {
    closingTaskBrowserSessions.delete(id);
  }
}

// TODO(v2): add closeAllTaskBrowserSessions() for cleanup on API shutdown
// Currently, ephemeral Chrome processes are cleaned up via the "exit" handler on each child process.

export function expireInactiveTaskBrowserSessions(): void {
  const now = new Date();
  for (const session of taskBrowserSessions.values()) {
    if (session.status === "ready" || session.status === "starting") {
      if (new Date(session.expires_at) < now) {
        const proc = taskBrowserProcesses.get(session.browser_session_id);
        if (proc) {
          try { proc.kill("SIGTERM"); } catch { /* ignore */ }
          taskBrowserProcesses.delete(session.browser_session_id);
        }
        safeCleanupDir(session.user_data_dir);
        session.status = "expired";
        session.cleanup_complete = true;
        taskBrowserSessions.set(session.browser_session_id, session);
      }
    }
  }
}
