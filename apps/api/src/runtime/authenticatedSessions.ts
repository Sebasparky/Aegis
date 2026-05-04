import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  AuthenticatedSessionHandle,
  AuthenticatedSessionLoginRequest,
  AuthenticatedSessionObserveResult,
  AuthenticatedSessionCapability,
} from "@aegis/types";
import type { AgentDelegation } from "@aegis/types";
import { newId, MOCK_USER_ID, aegisVaultPasses } from "../store/index.js";
import { getVaultRepository } from "../repositories/vaultRepository.js";
import { getKmsProvider, type KmsContext } from "../lib/kms.js";
import { recordKmsAuditEvent } from "../lib/kmsAudit.js";
import {
  buildAgentSafeObservationSnapshot,
  buildMinimalOpenObservation,
  scanPageForSensitivitySignals,
} from "./agentSafeObservation.js";

// ─── Internal record (holds Playwright refs — never exposed to agents) ─────────

interface AuthenticatedSessionRecord {
  session_id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

// ─── In-memory Maps (not persisted — Playwright refs cannot be serialized) ────

export const authenticatedSessionHandles = new Map<string, AuthenticatedSessionHandle>();
const authenticatedSessionRecords = new Map<string, AuthenticatedSessionRecord>();

// ─── Challenge detection heuristics ──────────────────────────────────────────

const CHALLENGE_TEXT_PATTERNS = [
  "two-factor",
  "2fa",
  "verification code",
  "passkey",
  "captcha",
  "security check",
  "verify your identity",
  "one-time password",
  "authenticator app",
];

const CHALLENGE_URL_PATTERNS = [
  /\/two-factor/i,
  /\/2fa/i,
  /\/challenge/i,
  /recaptcha/i,
  /hcaptcha/i,
  /\/mfa\b/i,
];

async function detectChallenges(page: Page): Promise<string | null> {
  const url = page.url();
  for (const pattern of CHALLENGE_URL_PATTERNS) {
    if (pattern.test(url)) {
      return `Challenge URL detected: ${url}`;
    }
  }

  const found = await page.evaluate(`(function() {
    var text = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();
    var patterns = ${JSON.stringify(CHALLENGE_TEXT_PATTERNS)};
    for (var i = 0; i < patterns.length; i++) {
      if (text.indexOf(patterns[i]) >= 0) return patterns[i];
    }
    if (document.querySelector('img[src*="recaptcha"], img[src*="hcaptcha"]')) {
      return 'captcha-image';
    }
    return null;
  })()`).catch(() => null) as string | null;

  return found;
}

// ─── Private credential resolution ───────────────────────────────────────────

// Decrypts the login credential for a given user+domain from the KMS vault.
// The resolved password is used only inside this module — never returned to callers.
async function resolveAuthSessionCredential(
  userId: string,
  domain: string,
  sessionId: string,
  passId?: string,
): Promise<{ username: string; password: string; pass_id: string }> {
  const vaultRepo = getVaultRepository();

  let pass = passId
    ? (aegisVaultPasses.get(passId) ?? await vaultRepo.getVaultPass(passId))
    : Array.from(aegisVaultPasses.values()).find((p) => p.user_id === userId && p.domain === domain);

  if (!pass) {
    throw new Error(`No vault pass found for user ${userId} on domain ${domain}.`);
  }
  if (pass.user_id !== userId) {
    throw new Error(`Pass ${pass.pass_id} does not belong to user ${userId}.`);
  }

  const blob = await vaultRepo.getEncryptedSecret(pass.secret_ref);
  if (!blob) {
    throw new Error(`Secret not available in vault for pass ${pass.pass_id}.`);
  }

  const kms = getKmsProvider();
  const kmsContext: KmsContext = {
    user_id: pass.user_id,
    pass_id: pass.pass_id,
    domain: pass.domain,
    purpose: "login_password",
  };

  let decrypted: string;
  try {
    decrypted = await kms.decryptSecret(blob, kmsContext);
    recordKmsAuditEvent({
      operation: "resolve_secret_for_runtime",
      provider: kms.provider,
      user_id: pass.user_id,
      pass_id: pass.pass_id,
      domain: pass.domain,
      run_id: `authsession:${sessionId}`,
      success: true,
    });
  } catch (err) {
    recordKmsAuditEvent({
      operation: "resolve_secret_for_runtime",
      provider: kms.provider,
      user_id: pass.user_id,
      pass_id: pass.pass_id,
      domain: pass.domain,
      run_id: `authsession:${sessionId}`,
      success: false,
      error_code: err instanceof Error ? err.message.split(":")[0] : "DECRYPT_ERROR",
    });
    throw err;
  }

  return { username: pass.username ?? "", password: decrypted, pass_id: pass.pass_id };
}

// ─── Fill form helper ─────────────────────────────────────────────────────────

async function tryFill(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      const count = await loc.count();
      if (count > 0) {
        await loc.fill(value);
        return true;
      }
    } catch {
      // try next selector
    }
  }
  return false;
}

// ─── Exported session management ─────────────────────────────────────────────

export function createAuthenticatedSession(
  req: AuthenticatedSessionLoginRequest,
  delegation: AgentDelegation,
): AuthenticatedSessionHandle {
  const now = new Date();
  const sessionId = newId("authsess");
  const isLocalhost = req.domain === "localhost";

  const handle: AuthenticatedSessionHandle = {
    session_id: sessionId,
    user_id: delegation.user_id,
    delegation_id: delegation.id,
    domain: req.domain,
    login_url: req.login_url,
    task_summary: req.task_summary,
    status: isLocalhost ? "pending_approval" : "manual_step_required",
    capabilities: [],
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
    raw_credentials_revealed_to_agent: false,
    manual_step_reason: isLocalhost
      ? undefined
      : "Automated login is not supported for this domain in v1. Only localhost is supported.",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
  };

  authenticatedSessionHandles.set(sessionId, handle);
  return handle;
}

export function getAuthenticatedSessionHandle(
  sessionId: string,
  userId: string,
): AuthenticatedSessionHandle | undefined {
  const handle = authenticatedSessionHandles.get(sessionId);
  if (!handle || handle.user_id !== userId) return undefined;
  return handle;
}

// Fire-and-forget: transitions handle to login_in_progress immediately,
// then launches Playwright async login. Attach .catch() on the call site.
export function executeLoginForAuthenticatedSession(sessionId: string): Promise<void> {
  const handle = authenticatedSessionHandles.get(sessionId);
  if (!handle) {
    return Promise.reject(new Error(`Session ${sessionId} not found.`));
  }

  handle.status = "login_in_progress";

  // Launch async work — caller must not await this and must attach .catch()
  const work = (async () => {
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;

    try {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext();
      page = await context.newPage();

      authenticatedSessionRecords.set(sessionId, { session_id: sessionId, browser, context, page });

      await page.goto(handle.login_url, { waitUntil: "domcontentloaded" });

      // Check for challenge on login page before even filling credentials
      const preChallenge = await detectChallenges(page);
      if (preChallenge) {
        handle.status = "manual_step_required";
        handle.manual_step_reason = `Login challenge detected before credential fill: ${preChallenge}`;
        return;
      }

      const credential = await resolveAuthSessionCredential(
        handle.user_id,
        handle.domain,
        sessionId,
        (handle as AuthenticatedSessionHandle & { pass_id?: string }).pass_id,
      );

      // Fill username
      const usernameSelectors = [
        'input[autocomplete="username"]',
        'input[name="username"]',
        'input[type="email"]',
        'input[name="email"]',
        'input[autocomplete="email"]',
        'input:not([type="password"]):not([type="submit"]):not([type="hidden"]):not([type="checkbox"])',
      ];
      const usernameFilled = await tryFill(page, usernameSelectors, credential.username);
      if (!usernameFilled && credential.username) {
        console.warn(`[auth-session] Could not fill username field for session ${sessionId}`);
      }

      // Fill password
      const passwordSelectors = [
        'input[type="password"]',
        'input[autocomplete="current-password"]',
        'input[name="password"]',
      ];
      const passwordFilled = await tryFill(page, passwordSelectors, credential.password);
      if (!passwordFilled) {
        throw new Error("Could not find a password input field on the login page.");
      }

      // Click submit
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
        'button:has-text("Login")',
        'button:has-text("Sign In")',
      ];
      let submitted = false;
      for (const sel of submitSelectors) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.count() > 0) {
            await loc.click();
            submitted = true;
            break;
          }
        } catch {
          // try next
        }
      }
      if (!submitted) {
        throw new Error("Could not find a submit button on the login page.");
      }

      await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});

      // Check for challenge after login attempt
      const postChallenge = await detectChallenges(page);
      if (postChallenge) {
        handle.status = "manual_step_required";
        handle.manual_step_reason = `Login challenge detected after credential submit: ${postChallenge}`;
        return;
      }

      // Login succeeded — mark authenticated
      handle.status = "authenticated";
      handle.capabilities = ["authenticated_observation", "safe_navigation"] as AuthenticatedSessionCapability[];
      handle.initial_observation = await buildMinimalOpenObservation(page);
    } catch (err) {
      handle.status = "failed";
      handle.manual_step_reason = err instanceof Error ? err.message : "Login failed.";
      // Close browser on failure (keep it open for manual_step_required cases)
      if (browser) {
        await browser.close().catch(() => {});
        authenticatedSessionRecords.delete(sessionId);
      }
    }
  })();

  return work;
}

export async function observeAuthenticatedSession(
  sessionId: string,
  userId: string,
): Promise<AuthenticatedSessionObserveResult> {
  const handle = authenticatedSessionHandles.get(sessionId);
  if (!handle) throw Object.assign(new Error("Session not found."), { code: "SESSION_NOT_FOUND", status: 404 });
  if (handle.user_id !== userId) throw Object.assign(new Error("Forbidden."), { code: "FORBIDDEN", status: 403 });

  const record = authenticatedSessionRecords.get(sessionId);
  if (!record) {
    throw Object.assign(new Error("No active browser session. The session may have expired or failed."), {
      code: "SESSION_BROWSER_UNAVAILABLE",
      status: 409,
    });
  }

  const pageUrl = record.page.url();
  const signals = await scanPageForSensitivitySignals(record.page);

  if (signals.length > 0) {
    const snapshot = await buildAgentSafeObservationSnapshot(
      record.page,
      sessionId,
      undefined,
      userId,
      handle.domain,
    );
    return {
      session_id: sessionId,
      status: handle.status,
      page_url: pageUrl,
      protected_snapshot: snapshot,
      raw_cookies_revealed_to_agent: false,
      raw_storage_revealed_to_agent: false,
    };
  }

  const openSummary = await buildMinimalOpenObservation(record.page);
  return {
    session_id: sessionId,
    status: handle.status,
    page_url: pageUrl,
    open_summary: openSummary,
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
  };
}

export async function navigateAuthenticatedSession(
  sessionId: string,
  userId: string,
  url: string,
): Promise<AuthenticatedSessionObserveResult> {
  const handle = authenticatedSessionHandles.get(sessionId);
  if (!handle) throw Object.assign(new Error("Session not found."), { code: "SESSION_NOT_FOUND", status: 404 });
  if (handle.user_id !== userId) throw Object.assign(new Error("Forbidden."), { code: "FORBIDDEN", status: 403 });

  if (handle.status !== "authenticated") {
    throw Object.assign(
      new Error(`Session status is '${handle.status}'; must be 'authenticated' to navigate.`),
      { code: "SESSION_NOT_AUTHENTICATED", status: 400 },
    );
  }
  if (!handle.capabilities.includes("safe_navigation")) {
    throw Object.assign(new Error("safe_navigation capability is not available for this session."), {
      code: "CAPABILITY_NOT_GRANTED",
      status: 403,
    });
  }

  // Enforce same-domain navigation only
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw Object.assign(new Error("Invalid URL."), { code: "INVALID_URL", status: 400 });
  }

  const targetHostname = parsedUrl.hostname;
  if (targetHostname !== handle.domain) {
    throw Object.assign(
      new Error(
        `Cross-domain navigation blocked. Session domain is '${handle.domain}', target is '${targetHostname}'.`,
      ),
      { code: "CROSS_DOMAIN_NAVIGATION_BLOCKED", status: 400 },
    );
  }

  const record = authenticatedSessionRecords.get(sessionId);
  if (!record) {
    throw Object.assign(new Error("No active browser session."), { code: "SESSION_BROWSER_UNAVAILABLE", status: 409 });
  }

  await record.page.goto(url, { waitUntil: "domcontentloaded" });

  return observeAuthenticatedSession(sessionId, userId);
}

export function rejectAuthenticatedSession(sessionId: string): void {
  const handle = authenticatedSessionHandles.get(sessionId);
  if (!handle) return;
  handle.status = "failed";
  handle.manual_step_reason = "Rejected by user.";
  const record = authenticatedSessionRecords.get(sessionId);
  if (record) {
    record.browser.close().catch(() => {});
    authenticatedSessionRecords.delete(sessionId);
  }
}

export async function closeAuthenticatedSession(sessionId: string): Promise<void> {
  const handle = authenticatedSessionHandles.get(sessionId);
  if (handle) handle.status = "expired";
  const record = authenticatedSessionRecords.get(sessionId);
  if (record) {
    await record.browser.close().catch(() => {});
    authenticatedSessionRecords.delete(sessionId);
  }
}
