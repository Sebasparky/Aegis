import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  AuthenticatedSessionHandle,
  AuthenticatedSessionLoginDiagnostics,
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

const FAILED_LOGIN_TEXT_PATTERNS = [
  "incorrect username or password",
  "invalid username or password",
  "unable to sign in",
  "sign in to continue",
  "login required",
  "authentication failed",
  "wrong password",
];

const LOGIN_URL_PATH_PATTERNS = [
  /\/login\b/i,
  /\/signin\b/i,
  /\/sign-in\b/i,
  /\/session\b/i,
  /\/sessions\b/i,
  /\/auth\b/i,
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

// ─── Fill / click helpers ─────────────────────────────────────────────────────

async function tryFill(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) {
        await loc.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
        await loc.fill(value);
        return true;
      }
    } catch {
      // try next selector
    }
  }
  return false;
}

async function tryClick(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) {
        await loc.click();
        return true;
      }
    } catch {
      // try next selector
    }
  }
  return false;
}

// ─── Login success verification ───────────────────────────────────────────────

// Verifies that login actually succeeded by checking negative and positive signals.
// A form submit with no challenge is not sufficient — positive evidence is required.
async function verifyAuthenticatedSession(args: {
  page: Page;
  domain: string;
  expectedUsername?: string;
}): Promise<{ authenticated: boolean; reason: string; evidence: string[] }> {
  const { page, domain, expectedUsername } = args;
  const evidence: string[] = [];

  // Fast path: still on a login URL
  const currentUrl = page.url();
  for (const pattern of LOGIN_URL_PATH_PATTERNS) {
    if (pattern.test(currentUrl)) {
      return {
        authenticated: false,
        reason: `Still on a login URL after submit: ${currentUrl}`,
        evidence: ["url_is_login_path"],
      };
    }
  }
  evidence.push("url_not_login_path");

  // Single DOM round-trip: all generic signals in one evaluate call
  type DomCheck = {
    hasPasswordField: boolean;
    hasLoginForm: boolean;
    hasSignInPrimaryNav: boolean;
    failedLoginText: string | null;
    hasAccountMenuSignal: boolean;
    usernameVisible: boolean;
  };

  const dom = await page.evaluate(`(function() {
    var text = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();

    var pwFields = document.querySelectorAll('input[type="password"]');
    var hasPasswordField = false;
    for (var i = 0; i < pwFields.length; i++) {
      var s = window.getComputedStyle(pwFields[i]);
      if (s.display !== 'none' && s.visibility !== 'hidden') { hasPasswordField = true; break; }
    }

    var hasLoginForm = false;
    var forms = document.querySelectorAll('form');
    for (var f = 0; f < forms.length; f++) {
      if (forms[f].querySelector('input[type="password"]')) { hasLoginForm = true; break; }
    }

    var hasSignInPrimaryNav = false;
    var navLinks = document.querySelectorAll('header a, nav a, [role="navigation"] a');
    for (var n = 0; n < navLinks.length; n++) {
      var t = (navLinks[n].textContent || '').trim().toLowerCase();
      if (t === 'sign in' || t === 'log in' || t === 'login' || t === 'signin') {
        hasSignInPrimaryNav = true; break;
      }
    }

    var failedPatterns = ${JSON.stringify(FAILED_LOGIN_TEXT_PATTERNS)};
    var failedLoginText = null;
    for (var p = 0; p < failedPatterns.length; p++) {
      if (text.indexOf(failedPatterns[p]) >= 0) { failedLoginText = failedPatterns[p]; break; }
    }

    var hasAccountMenuSignal = false;
    var interactives = document.querySelectorAll('a, button, [role="menuitem"]');
    for (var a = 0; a < interactives.length; a++) {
      var lt = (interactives[a].textContent || '').trim().toLowerCase();
      var la = (interactives[a].getAttribute('aria-label') || '').toLowerCase();
      if (/sign out|log out|logout|your profile|account settings/.test(lt) ||
          /sign out|log out|your account|profile/.test(la)) {
        hasAccountMenuSignal = true; break;
      }
    }

    var usernameVisible = false;
    var expectedUsername = ${JSON.stringify(expectedUsername ?? null)};
    if (expectedUsername) {
      usernameVisible = text.indexOf(expectedUsername.toLowerCase()) >= 0;
    }

    return {
      hasPasswordField: hasPasswordField,
      hasLoginForm: hasLoginForm,
      hasSignInPrimaryNav: hasSignInPrimaryNav,
      failedLoginText: failedLoginText,
      hasAccountMenuSignal: hasAccountMenuSignal,
      usernameVisible: usernameVisible,
    };
  })()`).catch(() => ({
    hasPasswordField: false,
    hasLoginForm: false,
    hasSignInPrimaryNav: false,
    failedLoginText: null as string | null,
    hasAccountMenuSignal: false,
    usernameVisible: false,
  })) as DomCheck;

  // Hard negative: explicit failed-login message
  if (dom.failedLoginText) {
    return {
      authenticated: false,
      reason: "Failed-login message detected on page.",
      evidence: [`failed_login_text: ${dom.failedLoginText}`],
    };
  }

  if (dom.hasPasswordField) evidence.push("negative: visible_password_field");
  if (dom.hasLoginForm) evidence.push("negative: login_form_present");
  if (dom.hasSignInPrimaryNav) evidence.push("negative: sign_in_in_nav");
  if (dom.hasAccountMenuSignal) evidence.push("positive: account_menu_signal");
  if (dom.usernameVisible) evidence.push("positive: username_visible_in_page");

  // GitHub-specific: requires at least one positive signal + no hard negative
  if (domain === "github.com") {
    // Fast positive: landing on github.com home/dashboard with no sign-in link is strong evidence
    const isOnGitHubHome = currentUrl === "https://github.com/" || currentUrl === "https://github.com";
    if (isOnGitHubHome) {
      const homeEvidence = await page.evaluate(`(function() {
        var text = (document.body && document.body.innerText) ? document.body.innerText : '';
        var hasDashboard = text.indexOf('Dashboard') >= 0;
        var hasSignInLink = !!document.querySelector('a[href="/login"]');
        return { hasDashboard: hasDashboard, hasSignInLink: hasSignInLink };
      })()`).catch(() => ({ hasDashboard: false, hasSignInLink: false })) as { hasDashboard: boolean; hasSignInLink: boolean };

      if (homeEvidence.hasDashboard && !homeEvidence.hasSignInLink) {
        evidence.push("positive: github_dashboard_visible");
        return {
          authenticated: true,
          reason: "GitHub: home page with Dashboard content and no sign-in link — authenticated.",
          evidence,
        };
      }
    }

    if (dom.hasSignInPrimaryNav) {
      return {
        authenticated: false,
        reason: "GitHub primary nav still shows 'Sign in' — login did not succeed.",
        evidence,
      };
    }

    // Network-level check: /settings/profile redirects to login when unauthenticated.
    // Uses page.request (shares browser context cookies) — no page navigation.
    const profileResp = await page.request.fetch("https://github.com/settings/profile").catch(() => null);
    const profileFinalUrl = profileResp?.url() ?? "";
    if (/\/login|\/sessions/i.test(profileFinalUrl)) {
      evidence.push("negative: settings_profile_redirected_to_login");
      return {
        authenticated: false,
        reason: "GitHub: /settings/profile redirected to login — session is not authenticated.",
        evidence,
      };
    }
    if (profileFinalUrl) evidence.push("positive: settings_profile_accessible");

    const hasPositive = dom.hasAccountMenuSignal || dom.usernameVisible || !!profileFinalUrl;
    if (!hasPositive) {
      return {
        authenticated: false,
        reason: "GitHub: no positive authentication signals detected.",
        evidence,
      };
    }
    return { authenticated: true, reason: "GitHub: positive authentication signals confirmed.", evidence };
  }

  // Generic: any negative signal with no positive → inconclusive → not authenticated
  const negativeCount = [dom.hasPasswordField, dom.hasLoginForm, dom.hasSignInPrimaryNav].filter(Boolean).length;
  const positiveCount = [dom.hasAccountMenuSignal, dom.usernameVisible].filter(Boolean).length;

  if (negativeCount >= 1 && positiveCount === 0) {
    return {
      authenticated: false,
      reason: `Authentication inconclusive: ${negativeCount} negative signal(s), no positive signals.`,
      evidence,
    };
  }

  return {
    authenticated: true,
    reason: `Verification passed: no login URL, no failed-login text, ${negativeCount} negative, ${positiveCount} positive signal(s).`,
    evidence,
  };
}

// ─── Safe failure evidence extraction ────────────────────────────────────────

// Collects short UI-text snippets from alert/flash/banner elements.
// Single page.evaluate IIFE — never reads input values or credentials.
async function extractSafeLoginFailureEvidence(page: Page): Promise<string[]> {
  return await page.evaluate(`(function() {
    var MAX_SNIPPETS = 8;
    var MAX_LEN = 240;
    var seen = {};
    var results = [];

    function addSnippet(text) {
      if (!text) return;
      var t = text.replace(/\\s+/g, ' ').trim().slice(0, MAX_LEN);
      if (t.length < 3 || seen[t]) return;
      seen[t] = true;
      results.push(t);
    }

    function textOf(el) {
      // Never read input/textarea/select values
      if (!el || /^(input|textarea|select)$/i.test(el.tagName)) return '';
      var parts = [];
      el.childNodes.forEach(function(node) {
        if (node.nodeType === 3) {
          parts.push(node.textContent || '');
        } else if (node.nodeType === 1 && !/^(input|textarea|select)$/i.test(node.tagName)) {
          parts.push(textOf(node));
        }
      });
      return parts.join(' ');
    }

    // Alert and flash containers
    var selectors = [
      '[role="alert"]',
      '.flash-error', '.flash-warn', '.flash',
      '.js-flash-alert',
      '[aria-live]',
      '.error', '.alert', '.notice',
    ];
    selectors.forEach(function(sel) {
      try {
        document.querySelectorAll(sel).forEach(function(el) {
          addSnippet(textOf(el));
        });
      } catch(e) {}
    });

    // Parent containers around "Dismiss error" buttons
    try {
      document.querySelectorAll('button, [role="button"]').forEach(function(btn) {
        var t = (btn.textContent || '').trim().toLowerCase();
        if (t.indexOf('dismiss') >= 0 || t.indexOf('reload') >= 0) {
          var parent = btn.parentElement;
          if (parent) addSnippet(textOf(parent));
        }
      });
    } catch(e) {}

    // h1/h2 headings that look like error pages
    try {
      document.querySelectorAll('h1, h2').forEach(function(h) {
        var t = (h.textContent || '').trim().toLowerCase();
        if (/error|incorrect|invalid|denied|failed|blocked|problem|sorry/.test(t)) {
          addSnippet(h.textContent || '');
        }
      });
    } catch(e) {}

    return results.slice(0, 8);
  })()`).catch(() => []) as string[];
}

// ─── Strong failure evidence patterns (only these stop the settle loop early) ─

const STRONG_FAILURE_PATTERNS = [
  "incorrect username or password",
  "invalid username or password",
  "wrong password",
  "authentication failed",
  "rate limit",
  "too many attempts",
  "access denied",
  "account locked",
  "captcha",
  "security check",
  "verify your identity",
];

function isStrongFailureEvidence(snippets: string[]): boolean {
  const combined = snippets.join(" ").toLowerCase();
  return STRONG_FAILURE_PATTERNS.some(p => combined.includes(p));
}

// ─── Post-login settle loop ───────────────────────────────────────────────────

interface PostLoginSettleResult {
  authenticated: boolean;
  challenge_detected: boolean;
  challenge_reason?: string;
  failure_evidence: string[];
  url_transitions: string[];
  elapsed_ms: number;
  final_url: string;
}

// Polls after form submit until: challenge detected, strong failure evident,
// positive verification confirmed, or timeout. Allows redirect chains to complete.
async function waitForPostLoginSettle(
  page: Page,
  domain: string,
  expectedUsername: string | undefined,
  timeoutMs = 11000,
  pollIntervalMs = 400,
): Promise<PostLoginSettleResult> {
  const start = Date.now();
  const urlTransitions: string[] = [page.url()];
  let lastUrl = page.url();

  while (Date.now() - start < timeoutMs) {
    await new Promise<void>(r => setTimeout(r, pollIntervalMs));

    const currentUrl = page.url();
    if (currentUrl !== lastUrl) {
      urlTransitions.push(currentUrl);
      lastUrl = currentUrl;
    }

    // Challenge detection — stop immediately
    const challenge = await detectChallenges(page);
    if (challenge) {
      return {
        authenticated: false,
        challenge_detected: true,
        challenge_reason: challenge,
        failure_evidence: [],
        url_transitions: urlTransitions,
        elapsed_ms: Date.now() - start,
        final_url: currentUrl,
      };
    }

    // Only stop on clearly strong failure evidence — not generic reload/session banners
    const evidence = await extractSafeLoginFailureEvidence(page);
    if (evidence.length > 0 && isStrongFailureEvidence(evidence)) {
      return {
        authenticated: false,
        challenge_detected: false,
        failure_evidence: evidence,
        url_transitions: urlTransitions,
        elapsed_ms: Date.now() - start,
        final_url: currentUrl,
      };
    }

    // Positive verification — stop early on confirmed success
    const verification = await verifyAuthenticatedSession({ page, domain, expectedUsername });
    if (verification.authenticated) {
      return {
        authenticated: true,
        challenge_detected: false,
        failure_evidence: [],
        url_transitions: urlTransitions,
        elapsed_ms: Date.now() - start,
        final_url: currentUrl,
      };
    }
  }

  // Timeout — final verification pass
  const finalVerification = await verifyAuthenticatedSession({ page, domain, expectedUsername });
  return {
    authenticated: finalVerification.authenticated,
    challenge_detected: false,
    failure_evidence: [],
    url_transitions: urlTransitions,
    elapsed_ms: Date.now() - start,
    final_url: page.url(),
  };
}

// ─── Exported session management ─────────────────────────────────────────────

export function createAuthenticatedSession(
  req: AuthenticatedSessionLoginRequest,
  delegation: AgentDelegation,
): AuthenticatedSessionHandle {
  const now = new Date();
  const sessionId = newId("authsess");

  const handle: AuthenticatedSessionHandle = {
    session_id: sessionId,
    user_id: delegation.user_id,
    delegation_id: delegation.id,
    domain: req.domain,
    login_url: req.login_url,
    task_summary: req.task_summary,
    status: "pending_approval",
    capabilities: [],
    raw_cookies_revealed_to_agent: false,
    raw_storage_revealed_to_agent: false,
    raw_credentials_revealed_to_agent: false,
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

  // Initialize metadata-only diagnostics — no credential values ever stored here
  const diag: AuthenticatedSessionLoginDiagnostics = {
    attempted: true,
    started_at: new Date().toISOString(),
    credential_found: false,
    username_present: false,
    password_present: false,
    username_fill_attempted: false,
    username_fill_succeeded: false,
    password_fill_attempted: false,
    password_fill_succeeded: false,
    submit_attempted: false,
    submit_succeeded: false,
    verification_authenticated: false,
  };
  handle.login_diagnostics = diag;

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

      // Check for challenge on login page before filling credentials
      const preChallenge = await detectChallenges(page);
      if (preChallenge) {
        diag.challenge_detected = true;
        diag.challenge_reason = preChallenge;
        diag.completed_at = new Date().toISOString();
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
      diag.credential_found = true;
      diag.username_present = credential.username.length > 0;
      diag.password_present = credential.password.length > 0;

      // Fill username
      const usernameSelectors = [
        'input[autocomplete="username"]',
        'input[name="username"]',
        'input[type="email"]',
        'input[name="email"]',
        'input[autocomplete="email"]',
        'input:not([type="password"]):not([type="submit"]):not([type="hidden"]):not([type="checkbox"])',
      ];
      diag.username_fill_attempted = true;
      diag.username_fill_succeeded = await tryFill(page, usernameSelectors, credential.username);
      if (!diag.username_fill_succeeded && credential.username) {
        console.warn(`[auth-session] Could not fill username field for session ${sessionId}`);
      }

      // Fill password
      const passwordSelectors = [
        'input[type="password"]',
        'input[autocomplete="current-password"]',
        'input[name="password"]',
      ];
      diag.password_fill_attempted = true;
      diag.password_fill_succeeded = await tryFill(page, passwordSelectors, credential.password);
      if (!diag.password_fill_succeeded) {
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
      diag.submit_attempted = true;
      diag.submit_succeeded = await tryClick(page, submitSelectors);
      if (!diag.submit_succeeded) {
        throw new Error("Could not find a submit button on the login page.");
      }

      // Short initial DOM settle, then a polling loop to allow post-login redirect chains
      // to complete before running verification. GitHub and similar SSO flows redirect
      // multiple times before the session is established.
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});

      const settleResult = await waitForPostLoginSettle(page, handle.domain, credential.username);

      diag.post_submit_url = settleResult.final_url;
      diag.post_submit_wait_ms = settleResult.elapsed_ms;
      diag.post_submit_url_transitions = settleResult.url_transitions;
      diag.verification_authenticated = settleResult.authenticated;
      diag.completed_at = new Date().toISOString();

      console.info(`[auth-session] diagnostics`, {
        session_id: sessionId,
        domain: handle.domain,
        credential_found: diag.credential_found,
        username_present: diag.username_present,
        password_present: diag.password_present,
        username_fill_succeeded: diag.username_fill_succeeded,
        password_fill_succeeded: diag.password_fill_succeeded,
        submit_succeeded: diag.submit_succeeded,
        post_submit_url: diag.post_submit_url,
        post_submit_wait_ms: diag.post_submit_wait_ms,
        url_transitions: settleResult.url_transitions,
        verification_authenticated: diag.verification_authenticated,
        challenge_detected: settleResult.challenge_detected,
      });

      if (settleResult.challenge_detected) {
        diag.challenge_detected = true;
        diag.challenge_reason = settleResult.challenge_reason;
        handle.status = "manual_step_required";
        handle.manual_step_reason = `Login challenge detected after credential submit: ${settleResult.challenge_reason}`;
        return;
      }

      if (settleResult.authenticated) {
        handle.status = "authenticated";
        handle.capabilities = ["authenticated_observation", "safe_navigation"] as AuthenticatedSessionCapability[];
        handle.initial_observation = await buildMinimalOpenObservation(page);
        return;
      }

      // Not authenticated after settle — collect failure context
      diag.failure_evidence = settleResult.failure_evidence.length > 0
        ? settleResult.failure_evidence
        : await extractSafeLoginFailureEvidence(page);
      const firstEvidence = diag.failure_evidence[0];
      handle.status = "manual_step_required";
      handle.manual_step_reason = firstEvidence
        ? `Login success could not be verified after post-login settle. Page showed: "${firstEvidence}"`
        : "Login success could not be verified after post-login settle.";
    } catch (err) {
      diag.completed_at = new Date().toISOString();
      handle.status = "failed";
      handle.manual_step_reason = err instanceof Error ? err.message : "Login failed.";
      // Close browser on failure (keep open for manual_step_required to allow observation)
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

  // For manual_step_required with no browser record (edge case: session was closed before observe),
  // return a minimal response rather than an opaque 409.
  if (!record) {
    return {
      session_id: sessionId,
      status: handle.status,
      page_url: "",
      ...(handle.manual_step_reason ? { manual_step_reason: handle.manual_step_reason } : {}),
      raw_cookies_revealed_to_agent: false,
      raw_storage_revealed_to_agent: false,
    };
  }

  // Late upgrade: if still manual_step_required but browser is alive, re-run verification.
  // GitHub's redirect chain may have completed after the initial check froze the handle.
  if (handle.status === "manual_step_required") {
    try {
      const recheck = await verifyAuthenticatedSession({
        page: record.page,
        domain: handle.domain,
        expectedUsername: undefined,
      });
      if (recheck.authenticated) {
        handle.status = "authenticated";
        handle.manual_step_reason = undefined;
        handle.capabilities = ["authenticated_observation", "safe_navigation"] as AuthenticatedSessionCapability[];
        authenticatedSessionHandles.set(sessionId, handle);
      }
    } catch {
      // Non-fatal — continue with existing status
    }
  }

  const pageUrl = record.page.url();
  const signals = await scanPageForSensitivitySignals(record.page);
  const manualStepFields = handle.manual_step_reason
    ? { manual_step_reason: handle.manual_step_reason }
    : {};

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
      ...manualStepFields,
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
    ...manualStepFields,
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
