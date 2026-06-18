import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import {
  computeProfileKey,
  persistentProfileExists,
  ensurePersistentProfileDir,
} from "./browserProfilePersistence.js";
import { createServer } from "net";
import type { TaskBrowserSession, TaskBrowserSessionStatus, ActionIntent, RiskState } from "@aegis/types";
import { newId, MOCK_USER_ID } from "../store/index.js";
import { clearProtectedIframeRedactions } from "./protectedIframeRedaction.js";

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
  // Backoff: poll quickly at first (Chrome's CDP endpoint usually comes up well
  // under a second, so a flat 250ms interval wastes ~125ms on average), then
  // settle to 250ms. Total budget unchanged.
  const backoffMs = [50, 100, 150, 200];
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // Chrome not ready yet
    }
    const delay = backoffMs[attempt] ?? 250;
    attempt += 1;
    await new Promise((r) => setTimeout(r, delay));
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

// Like findAvailablePort, but also recycles ports held by tracked terminal sessions.
// If a port is in use but belongs to a closed/failed/expired session, kill any remaining
// process and wait briefly for the OS to reclaim the port before moving on.
async function findAvailablePortWithRecycle(ports: number[]): Promise<number | null> {
  for (const port of ports) {
    if (!(await isPortInUse(port))) return port;
    const session = findSessionByPort(port);
    if (session && (session.status === "closed" || session.status === "failed" || session.status === "expired")) {
      const proc = taskBrowserProcesses.get(session.browser_session_id);
      if (proc) {
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        taskBrowserProcesses.delete(session.browser_session_id);
      }
      const freed = await waitForPortFree(port, 1500);
      if (freed) return port;
    }
  }
  return null;
}

// Kills lingering processes for all terminal sessions and expires time-based ones.
// Returns the count of processes killed so the caller can decide whether to pause.
function sweepTerminalSessions(): number {
  expireInactiveTaskBrowserSessions();
  let killed = 0;
  for (const [id, session] of taskBrowserSessions.entries()) {
    if (session.status === "closed" || session.status === "failed" || session.status === "expired") {
      const proc = taskBrowserProcesses.get(id);
      if (proc) {
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        taskBrowserProcesses.delete(id);
        killed++;
      }
    }
  }
  return killed;
}

// Safe diagnostic view for the port-status endpoint — never exposes PIDs, profiles, or secrets.
export async function getPortStatusForDiagnostics(): Promise<{
  port_range: string;
  occupied_count: number;
  available_count: number;
  ports: Array<{ port: number; in_use: boolean; session_id: string | null; session_status: string | null; has_tracked_process: boolean }>;
  sessions: Array<{ session_id: string; status: string; port: number; mode: string; created_at: string; expires_at: string; closed_at?: string; cleanup_complete?: boolean; has_tracked_process: boolean }>;
}> {
  const ports = await Promise.all(
    ALL_CDP_PORTS.map(async (port) => {
      const session = findSessionByPort(port);
      return {
        port,
        in_use: await isPortInUse(port),
        session_id: session?.browser_session_id ?? null,
        session_status: session?.status ?? null,
        has_tracked_process: session ? taskBrowserProcesses.has(session.browser_session_id) : false,
      };
    }),
  );
  const sessions = Array.from(taskBrowserSessions.values()).map((s) => ({
    session_id: s.browser_session_id,
    status: s.status,
    port: s.cdp_port,
    mode: s.mode,
    created_at: s.created_at,
    expires_at: s.expires_at,
    ...(s.closed_at ? { closed_at: s.closed_at } : {}),
    ...(s.cleanup_complete !== undefined ? { cleanup_complete: s.cleanup_complete } : {}),
    has_tracked_process: taskBrowserProcesses.has(s.browser_session_id),
  }));
  const occupied_count = ports.filter((p) => p.in_use).length;
  return {
    port_range: `${DEFAULT_CDP_PORT}–${ALTERNATE_CDP_PORTS[ALTERNATE_CDP_PORTS.length - 1]}`,
    occupied_count,
    available_count: ports.length - occupied_count,
    ports,
    sessions,
  };
}

// ─── Orphan process detection ─────────────────────────────────────────────────

/**
 * Parses `ps -eo pid,args` output and returns PIDs whose command line contains
 * the Aegis ephemeral-profile marker. Exported so tests can verify parsing logic
 * without invoking `ps` itself.
 */
export function parseAegisOrphanPids(psOutput: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    if (line.includes("aegis-agent-browser")) {
      const pid = parseInt(line.trim().split(/\s+/)[0], 10);
      if (!isNaN(pid) && pid > 0) pids.push(pid);
    }
  }
  return pids;
}

function findAegisOrphanPids(): number[] {
  try {
    const output = execSync("ps -eo pid,args", { timeout: 3000, encoding: "utf8" });
    return parseAegisOrphanPids(output);
  } catch {
    return [];
  }
}

/**
 * Finds and kills Chrome processes that carry the Aegis ephemeral-profile marker
 * (`--user-data-dir=…/aegis-agent-browser-…`) but are no longer tracked by this
 * process instance. Safe to call at startup (when Maps are empty) and before
 * allocating a new port.
 *
 * Never touches processes whose PID is already in `taskBrowserProcesses`.
 * Never touches Chrome processes that do not have the Aegis profile marker.
 */
export async function cleanupOrphanedBrowserProcesses(): Promise<{
  orphans_found: number;
  orphans_killed: number;
  ports_freed: number;
}> {
  const allAegisPids = findAegisOrphanPids();

  const trackedPids = new Set(
    [...taskBrowserProcesses.values()].map((p) => p.pid).filter((pid): pid is number => pid != null),
  );
  const untrackedPids = allAegisPids.filter((pid) => !trackedPids.has(pid));

  let killed = 0;
  for (const pid of untrackedPids) {
    try {
      process.kill(pid, "SIGTERM");
      killed++;
    } catch {
      // Process may have already exited — ignore.
    }
  }

  if (killed > 0) {
    await new Promise<void>((r) => setTimeout(r, 1000));
  }

  const availableCount = (
    await Promise.all(ALL_CDP_PORTS.map(async (p) => ((await isPortInUse(p)) ? 0 : 1)))
  ).reduce((a: number, b: number) => a + b, 0);

  console.log(
    `[TaskBrowser] Orphan cleanup: found=${untrackedPids.length} killed=${killed} ports_available=${availableCount}`,
  );
  return { orphans_found: untrackedPids.length, orphans_killed: killed, ports_freed: availableCount };
}

/**
 * Gracefully closes every tracked task browser session. Called on API shutdown.
 * Idempotent — safe to call multiple times (subsequent calls skip already-closed sessions).
 */
export async function closeAllTaskBrowserSessions(): Promise<void> {
  const ids = [...taskBrowserSessions.keys()];
  await Promise.allSettled(
    ids.map(async (id) => {
      const session = taskBrowserSessions.get(id);
      if (!session || session.status === "closed" || session.status === "expired") return;
      const proc = taskBrowserProcesses.get(id);
      closingTaskBrowserSessions.add(id);
      try {
        if (proc) {
          try { proc.kill("SIGTERM"); } catch { /* ignore */ }
          await waitForProcessExit(proc, 2000);
          if (proc.exitCode === null) {
            try { proc.kill("SIGKILL"); } catch { /* ignore */ }
          }
        }
        taskBrowserProcesses.delete(id);
        if (!session.persistent_profile_enabled) {
          safeCleanupDir(session.user_data_dir);
        }
        session.status = "expired";
        session.closed_at = new Date().toISOString();
        taskBrowserSessions.set(id, session);
      } finally {
        closingTaskBrowserSessions.delete(id);
      }
    }),
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CreateTaskBrowserOptions {
  user_id?: string;
  delegation_id?: string;
  debug_visible?: boolean;
  runtime_mode?: "local_runtime_endpoint" | "compatibility_bridge";
  /** Opt-in: preserve the profile directory across session close/reopen. Default: false (ephemeral). */
  persistent_profile?: boolean;
}

interface LaunchChromeProfileOpts {
  persistent_profile_enabled: boolean;
  profile_key?: string;
  profile_state?: "fresh" | "reused";
}

export interface CreateTaskBrowserResult {
  session: TaskBrowserSession;
  reused_existing?: true;
  port_auto_selected?: true;
  requires_browser_reconnect?: true;
  user_message: string;
  mode: "headless" | "visible";
}

// Extracted Chrome launch logic — creates a session on any given port.
async function launchChrome(
  opts: CreateTaskBrowserOptions,
  cdpPort: number,
  profileOpts: LaunchChromeProfileOpts = { persistent_profile_enabled: false },
): Promise<TaskBrowserSession> {
  const chromeBin = findChromeBinary();
  if (!chromeBin) {
    throw Object.assign(
      new Error("Chrome not found. Install Google Chrome or Chromium in /Applications."),
      { code: "CHROME_NOT_FOUND" },
    );
  }

  // Dev-only: ANTIGEN_BROWSER_HEADLESS=false launches a visible browser for manual verification.
  // Production default remains headless. Do not expose this setting via agent tools or API responses.
  const debug_visible = opts.debug_visible === true || process.env.ANTIGEN_BROWSER_HEADLESS === "false";
  const mode: "headless" | "visible" = debug_visible ? "visible" : "headless";
  const userId = opts.user_id ?? MOCK_USER_ID;
  const browser_session_id = newId("tbsess");

  // Persistent sessions reuse a stable profile dir scoped to user+delegation.
  // Ephemeral sessions use a fresh /tmp dir deleted on close.
  // Note: ephemeral: true refers to the browser PROCESS (always killed on close).
  // persistent_profile_enabled refers to the profile DIRECTORY (optionally preserved).
  const user_data_dir = (profileOpts.persistent_profile_enabled && profileOpts.profile_key)
    ? ensurePersistentProfileDir(profileOpts.profile_key)
    : join(tmpdir(), `aegis-agent-browser-${browser_session_id}`);

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
    mode,
    debug_visible,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    ...(opts.runtime_mode ? { runtime_mode: opts.runtime_mode } : {}),
    persistent_profile_enabled: profileOpts.persistent_profile_enabled,
    ...(profileOpts.profile_state !== undefined ? { profile_state: profileOpts.profile_state } : {}),
  };
  taskBrowserSessions.set(browser_session_id, session);

  try {
    // For ephemeral sessions, create the dir now.
    // For persistent sessions, ensurePersistentProfileDir already created Default/.
    if (!profileOpts.persistent_profile_enabled) {
      mkdirSync(join(user_data_dir, "Default"), { recursive: true });
    }

    // ALWAYS write Preferences — enforces no-save policy on both fresh and reused profiles.
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
      ...(debug_visible ? [] : ["--headless=new"]),
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
        // Preserve persistent profile dirs even on crash — cookies/storage should survive.
        if (!profileOpts.persistent_profile_enabled) {
          safeCleanupDir(user_data_dir);
        }
      }
      taskBrowserProcesses.delete(browser_session_id);
    });

    await waitForCdpReady(cdpPort);

    updateStatus(session, "ready");
    // Metadata-only launch log so QA can prove headed vs headless from API logs.
    // No user_data_dir, PIDs, cookies, storage, page values, or secrets.
    console.log(
      `[TaskBrowser] launched browser_session_id=${browser_session_id}` +
        ` mode=${mode} headless_arg=${!debug_visible}` +
        ` cdp_url=${cdp_url} port=${cdpPort}` +
        ` delegation_id=${opts.delegation_id ?? "(none)"}` +
        ` persistent_profile=${profileOpts.persistent_profile_enabled === true}`,
    );
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
    // Only clean up ephemeral profiles on launch failure.
    if (!profileOpts.persistent_profile_enabled) {
      safeCleanupDir(user_data_dir);
    }

    throw err;
  }
}

const DEFAULT_CDP_PORT = 9222;
const ALTERNATE_CDP_PORTS = [
  9223, 9224, 9225, 9226, 9227, 9228, 9229, 9230,
  9231, 9232, 9233, 9234, 9235, 9236, 9237, 9238,
  9239, 9240, 9241, 9242, 9243, 9244, 9245, 9246,
  9247, 9248, 9249, 9250,
];
export const ALL_CDP_PORTS = [DEFAULT_CDP_PORT, ...ALTERNATE_CDP_PORTS];

export async function createTaskBrowserSession(
  opts: CreateTaskBrowserOptions = {},
): Promise<CreateTaskBrowserResult> {
  const debug_visible = opts.debug_visible === true || process.env.ANTIGEN_BROWSER_HEADLESS === "false";
  const mode: "headless" | "visible" = debug_visible ? "visible" : "headless";

  // Resolve persistent profile opts before launching Chrome.
  // Persistence is opt-in (persistent_profile: true). Default is ephemeral.
  const persistent_profile_enabled = opts.persistent_profile === true;
  let profileOpts: LaunchChromeProfileOpts;
  if (persistent_profile_enabled) {
    const userId = opts.user_id ?? MOCK_USER_ID;
    const profileKey = computeProfileKey(userId, opts.delegation_id);
    profileOpts = {
      persistent_profile_enabled: true,
      profile_key: profileKey,
      profile_state: persistentProfileExists(profileKey) ? "reused" : "fresh",
    };
  } else {
    profileOpts = { persistent_profile_enabled: false };
  }

  // Sweep expired/terminal sessions and kill any lingering processes before scanning ports.
  const killed = sweepTerminalSessions();
  if (killed > 0) {
    // Give the OS a brief window to reclaim ports from just-killed processes.
    await new Promise<void>((r) => setTimeout(r, 300));
  }

  const portBusy = await isPortInUse(DEFAULT_CDP_PORT);

  if (!portBusy) {
    const session = await launchChrome(opts, DEFAULT_CDP_PORT, profileOpts);
    return { session, user_message: "Started a fresh Antigen task browser session.", mode };
  }

  const existing = findSessionByPort(DEFAULT_CDP_PORT);

  // Case A: known ready session with live CDP — reuse without spawning Chrome
  if (existing && existing.status === "ready" && await isCdpAlive(DEFAULT_CDP_PORT)) {
    return { session: existing, reused_existing: true, user_message: "Reusing the active Antigen task browser session.", mode: existing.mode };
  }

  // Case B: known stale session (closed, expired, or failed) — recycle and try same port.
  // Includes "closed" because close() may return before the OS fully releases the port.
  if (existing && (existing.status === "closed" || existing.status === "expired" || existing.status === "failed")) {
    const proc = taskBrowserProcesses.get(existing.browser_session_id);
    if (proc) {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      taskBrowserProcesses.delete(existing.browser_session_id);
    }
    existing.status = "closed";
    existing.closed_at ??= new Date().toISOString();
    taskBrowserSessions.set(existing.browser_session_id, existing);

    const freed = await waitForPortFree(DEFAULT_CDP_PORT, 1500);
    if (freed) {
      const session = await launchChrome(opts, DEFAULT_CDP_PORT, profileOpts);
      return { session, user_message: "Started a fresh Antigen task browser session.", mode };
    }
    // Port still busy after recycle — fall through to alternate ports below
  }

  // Case C: unknown process on default port (or stale port still busy after recycle).
  // Do not reuse or inject secrets into an untracked browser.
  if (!existing) {
    console.log("[TaskBrowser] Port 9222 occupied by unknown process — launching on alternate port");
  }

  // Use recycle-aware scan so alternate ports held by terminal sessions can be freed.
  const altPort = await findAvailablePortWithRecycle(ALTERNATE_CDP_PORTS);
  if (altPort !== null) {
    const session = await launchChrome(opts, altPort, profileOpts);
    return { session, port_auto_selected: true, requires_browser_reconnect: true, user_message: "Started a fresh Antigen task browser session.", mode };
  }

  // Case D: all ports exhausted — attempt orphan cleanup once before giving up.
  console.warn("[TaskBrowser] All ports exhausted — attempting orphan cleanup before NO_PORTS_AVAILABLE");
  await cleanupOrphanedBrowserProcesses();

  const retryPort = await findAvailablePortWithRecycle(ALL_CDP_PORTS);
  if (retryPort !== null) {
    const session = await launchChrome(opts, retryPort, profileOpts);
    const altSelected = retryPort !== DEFAULT_CDP_PORT;
    return {
      session,
      ...(altSelected ? { port_auto_selected: true as const, requires_browser_reconnect: true as const } : {}),
      user_message: "Started a fresh Antigen task browser session after orphan cleanup.",
      mode,
    };
  }

  // Still no port available — return a clear error with a remediation hint.
  const portRange = `9222–${ALTERNATE_CDP_PORTS[ALTERNATE_CDP_PORTS.length - 1]}`;
  const trackedOccupied = ALL_CDP_PORTS
    .map((p) => ({ port: p, session: findSessionByPort(p) }))
    .filter((x) => x.session)
    .map((x) => ({ session_id: x.session!.browser_session_id, status: x.session!.status, port: x.port }));

  console.error(`[TaskBrowser] All ports ${portRange} still occupied after orphan cleanup`, {
    tracked_occupied: trackedOccupied.length,
    total_sessions: taskBrowserSessions.size,
  });
  throw Object.assign(
    new Error(
      `Antigen could not start a secure browser session — all ports ${portRange} are occupied and orphan cleanup did not free any. ` +
        `Call POST /api/internal/runtime-browser-sessions/cleanup-orphans or restart the API.`,
    ),
    {
      code: "NO_PORTS_AVAILABLE",
      occupied_port_range: portRange,
      tracked_occupied_sessions: trackedOccupied,
    },
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

/**
 * Internal-only: resolve the live CDP base URL for a browser session id, with no
 * user_id ownership gate. Mirrors the raw-map lookup challengeInjection.ts uses to
 * derive a session's cdp_url from a stored browser_session_id link. Callers (e.g.
 * the Visual Gesture Capsule routes) own the linkage record authoritatively and
 * use this to keep cdp_url server-side — the return value must NEVER be echoed to
 * an agent, UI, or any response body.
 */
export function getTaskBrowserSessionCdpUrl(browserSessionId: string): string | undefined {
  return taskBrowserSessions.get(browserSessionId)?.cdp_url;
}

/** Records the URL most recently navigated to in this session. Used by CDP injection to select
 *  the active page target rather than falling back to an arbitrary or stale target. */
export function setTaskBrowserSessionCurrentUrl(id: string, currentUrl: string): void {
  const session = taskBrowserSessions.get(id);
  if (session) {
    session.current_url = currentUrl;
    taskBrowserSessions.set(id, session);
  }
}

// Monotonic ordering of advisory workflow risk states. Risk state only moves
// forward — observing a cart action after checkout never regresses to cart_ready.
const RISK_STATE_ORDER: RiskState[] = [
  "browsing",
  "cart_ready",
  "checkout_started",
  "shipping_info_filled",
  "payment_required",
  "payment_method_available",
  "final_review",
  "commit_ready",
];

function riskRank(state: RiskState | undefined): number {
  if (!state) return 0;
  const idx = RISK_STATE_ORDER.indexOf(state);
  return idx < 0 ? 0 : idx;
}

/**
 * Advances the session's advisory risk state based on an observed action intent.
 * Coarse and monotonic — used only to sharpen ambiguous classification and for
 * enum-only trace context. No values, no secrets. Best-effort: a missing session
 * is a no-op.
 */
export function advanceRiskState(id: string, actionIntent: ActionIntent): void {
  const session = taskBrowserSessions.get(id);
  if (!session) return;
  let next: RiskState | undefined;
  switch (actionIntent) {
    case "cart_mutation":
      next = "cart_ready";
      break;
    case "checkout_transition":
      next = "checkout_started";
      break;
    case "payment_method_use":
      next = "payment_method_available";
      break;
    case "final_commit":
      next = "commit_ready";
      break;
    default:
      next = undefined;
  }
  if (next && riskRank(next) > riskRank(session.risk_state)) {
    session.risk_state = next;
    taskBrowserSessions.set(id, session);
  }
}

/** Advances risk state to shipping_info_filled when an address profile field is filled. */
export function markShippingInfoFilled(id: string): void {
  const session = taskBrowserSessions.get(id);
  if (!session) return;
  if (riskRank("shipping_info_filled") > riskRank(session.risk_state)) {
    session.risk_state = "shipping_info_filled";
    taskBrowserSessions.set(id, session);
  }
}

/** Returns the saved browser-internal pointer position for this session, or undefined if
 *  the session does not exist, does not belong to the user, or has no saved pointer state. */
export function getTaskBrowserSessionPointerState(
  id: string,
  userId: string,
): TaskBrowserSession["pointer_state"] {
  const session = taskBrowserSessions.get(id);
  if (!session || session.user_id !== userId) return undefined;
  return session.pointer_state;
}

/** Persists the browser-internal pointer position for this session. Coordinates only — no secrets. */
export function setTaskBrowserSessionPointerState(
  id: string,
  userId: string,
  pointerState: NonNullable<TaskBrowserSession["pointer_state"]>,
): void {
  const session = taskBrowserSessions.get(id);
  if (!session || session.user_id !== userId) return;
  session.pointer_state = pointerState;
  taskBrowserSessions.set(id, session);
}

export interface TaskBrowserSessionForReuse {
  browser_session_id: string;
  cdp_url: string;
}

/** Returns CDP metadata for a ready task browser session owned by userId. Returns undefined if
 *  the session does not exist, does not belong to the user, or is not in 'ready' status. */
export function getTaskBrowserSessionForReuse(
  browser_session_id: string,
  userId: string,
): TaskBrowserSessionForReuse | undefined {
  const session = taskBrowserSessions.get(browser_session_id);
  if (!session) return undefined;
  if (session.user_id !== userId) return undefined;
  if (session.status !== "ready") return undefined;
  return { browser_session_id: session.browser_session_id, cdp_url: session.cdp_url };
}

/** Returns the first ready task browser session matching the given delegation_id and userId.
 *  Used by get_runtime_browser_endpoint to reuse an existing runtime before provisioning a new one. */
export function findReadySessionByDelegationId(
  delegation_id: string,
  userId: string,
): TaskBrowserSession | undefined {
  for (const session of taskBrowserSessions.values()) {
    if (
      session.delegation_id === delegation_id &&
      session.user_id === userId &&
      session.status === "ready"
    ) {
      return session;
    }
  }
  return undefined;
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

    // Persistent profile dirs are intentionally preserved across close — cookies/storage survive.
    // Ephemeral profile dirs are deleted (best-effort).
    if (!session.persistent_profile_enabled) {
      safeCleanupDir(session.user_data_dir);
    }
    // For persistent sessions, dir stays by design — treat as clean (not a cleanup failure).
    const dirStillExists = session.persistent_profile_enabled
      ? false
      : existsSync(session.user_data_dir);

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
    // Drop any protected-iframe redaction registry entry for this session (hygiene).
    clearProtectedIframeRedactions(id);
  }
}


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
        if (!session.persistent_profile_enabled) {
          safeCleanupDir(session.user_data_dir);
        }
        session.status = "expired";
        session.cleanup_complete = true;
        taskBrowserSessions.set(session.browser_session_id, session);
      }
    }
  }
}

/** Test-only helper — insert a ChildProcess into the private tracking map.
 *  Never reference from agent-facing code or API responses. */
export function _testOnlyInsertTrackedProcess(sessionId: string, proc: ChildProcess): void {
  taskBrowserProcesses.set(sessionId, proc);
}

/** Test-only helper — clear the private process tracking map between tests. */
export function _testOnlyClearTrackedProcesses(): void {
  taskBrowserProcesses.clear();
}
