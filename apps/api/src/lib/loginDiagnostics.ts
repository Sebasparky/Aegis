import { randomUUID } from "crypto";
import type { Page } from "playwright";
import type { LoginOutcome, LoginOutcomeCode, StoredLoginDiagnostic } from "@aegis/types";

// In-memory store — bounded at 50 entries; oldest evicted on overflow
export const loginDiagnosticsStore = new Map<string, StoredLoginDiagnostic>();

function newDiagId(): string {
  return `ldiag_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// Targeted selectors — never touches input values, only notification/alert elements
const SIGNAL_SELECTORS = [
  '[role="alert"]',
  '[role="status"]',
  '[aria-live="assertive"]',
  '[aria-live="polite"]',
  ".flash-error",
  ".flash-warn",
  ".flash",
  ".error",
  ".notification",
  ".alert",
  "h1",
  "h2",
];

export async function extractPageTextSignals(page: Page): Promise<string[]> {
  try {
    return await page.evaluate((selectors: string[]) => {
      const texts: string[] = [];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const t = (el as HTMLElement).innerText?.trim();
          if (t && t.length > 0) texts.push(t.slice(0, 300));
        });
      }
      const title = document.title?.trim();
      if (title) texts.push(title.slice(0, 200));
      return texts.slice(0, 20);
    }, SIGNAL_SELECTORS);
  } catch {
    return [];
  }
}

type FailureCode = Exclude<LoginOutcomeCode, "login_success">;

const PATTERNS: Record<FailureCode, string[]> = {
  invalid_credentials: [
    "incorrect username or password",
    "incorrect password",
    "wrong password",
    "invalid credentials",
    "invalid username or password",
    "username or password is wrong",
    "password is incorrect",
    "login failed",
    "authentication failed",
    "sign in failed",
    "the password you entered",
    "wrong email or password",
    "email or password is incorrect",
  ],
  manual_challenge_required: [
    "two-factor",
    "two factor",
    "2fa",
    "verification code",
    "verify your identity",
    "enter the code",
    "check your email",
    "we sent a code",
    "passkey",
    "security key",
    "authenticator",
    "device verification",
    "additional verification",
    "confirm it's you",
  ],
  captcha_required: [
    "captcha",
    "i'm not a robot",
    "im not a robot",
    "prove you're human",
    "prove you are human",
    "cloudflare",
    "verify you are human",
    "complete the security check",
  ],
  rate_limited: [
    "too many attempts",
    "too many requests",
    "rate limit",
    "temporarily blocked",
    "account locked",
    "try again later",
    "wait before trying again",
    "account has been locked",
    "exceeded the number of",
  ],
  unknown_failure: [],
};

const USER_MESSAGES: Record<FailureCode, string> = {
  invalid_credentials:
    "The website rejected the saved credentials. The password in your vault may be incorrect or outdated.",
  manual_challenge_required:
    "The website requires an additional verification step (2FA, passkey, or device confirmation). Antigen cannot complete this step autonomously.",
  captcha_required:
    "The website is showing a CAPTCHA. Antigen cannot solve CAPTCHAs automatically.",
  rate_limited:
    "The website has temporarily blocked this login due to too many attempts. Wait before retrying.",
  unknown_failure:
    "The login did not succeed. The exact reason is unclear from the page content.",
};

const RECOMMENDED_ACTIONS: Record<FailureCode, string> = {
  invalid_credentials:
    "Update the saved credential in your vault with the correct password, then try again.",
  manual_challenge_required:
    "Complete the verification step manually in the browser, then resume the agent task.",
  captcha_required:
    "Complete the CAPTCHA manually in the browser, then resume the agent task.",
  rate_limited:
    "Wait a few minutes, then retry the login.",
  unknown_failure:
    "Check the browser to see what the website is showing, then retry if needed.",
};

// Signals that indicate a login page that did NOT navigate away to a dashboard
const LOGIN_PAGE_SIGNALS = ["sign in", "log in", "login", "sign-in", "log-in"];
const SUCCESS_SIGNALS = ["dashboard", "home feed", "welcome", "logged in", "signed in", "your profile", "account settings", "notifications"];

export function classifyLoginOutcome(signals: string[]): LoginOutcome | null {
  if (signals.length === 0) return null;
  const combined = signals.join(" ").toLowerCase();
  if (!combined.trim()) return null;

  // Check known failure patterns in priority order
  for (const code of ["invalid_credentials", "manual_challenge_required", "captcha_required", "rate_limited"] as FailureCode[]) {
    const matched = PATTERNS[code].filter((p) => combined.includes(p));
    if (matched.length > 0) {
      return {
        outcome: code,
        failure_reason: matched[0],
        user_message: USER_MESSAGES[code],
        recommended_action: RECOMMENDED_ACTIONS[code],
        signals_detected: matched,
        raw_secret_revealed_to_agent: false,
      };
    }
  }

  // If the page still looks like a login page and has content but no success signal,
  // classify as unknown_failure (e.g. generic "Something went wrong")
  const looksLikeLoginPage = LOGIN_PAGE_SIGNALS.some((s) => combined.includes(s));
  const looksLikeSuccess = SUCCESS_SIGNALS.some((s) => combined.includes(s));
  if (looksLikeLoginPage && !looksLikeSuccess && combined.length > 40) {
    return {
      outcome: "unknown_failure",
      user_message: USER_MESSAGES.unknown_failure,
      recommended_action: RECOMMENDED_ACTIONS.unknown_failure,
      signals_detected: [],
      raw_secret_revealed_to_agent: false,
    };
  }

  return null;
}

export function storeDiagnostic(
  base: Omit<StoredLoginDiagnostic, "diagnostic_id" | "detected_at">,
): StoredLoginDiagnostic {
  const diagnostic: StoredLoginDiagnostic = {
    ...base,
    diagnostic_id: newDiagId(),
    detected_at: new Date().toISOString(),
  };
  loginDiagnosticsStore.set(diagnostic.diagnostic_id, diagnostic);
  // Evict oldest entry when store exceeds 50
  if (loginDiagnosticsStore.size > 50) {
    const oldest = loginDiagnosticsStore.keys().next().value;
    if (oldest) loginDiagnosticsStore.delete(oldest);
  }
  return diagnostic;
}
