import { chromium, type Browser } from "playwright";
import type { CredentialStepHandoffStatus, CredentialStepKind } from "@aegis/types";
import { extractPageTextSignals, classifyLoginOutcome } from "../lib/loginDiagnostics.js";

export interface HandoffSubmitHint {
  selector_hint?: string;
  button_text?: string;
}

export interface SubmitAndWaitParams {
  domain: string;
  cdpUrl: string;
  step_kind: CredentialStepKind;
  submit: HandoffSubmitHint;
}

export interface SubmitAndWaitResult {
  status: CredentialStepHandoffStatus;
  current_url?: string;
  page_title?: string;
  challenge_kind?: "totp" | "email_code" | "sms_code" | "captcha" | "unknown";
  signals_detected?: string[];
  blocked_reason?: string;
  next_action?: {
    recommended: "report_security_challenge" | "retry_login" | "stop_and_ask_user";
    reason: string;
  };
}

// Login-type button text (case-insensitive, full match after trimming)
const SUBMIT_ALLOWLIST = /^(sign\s?in|log\s?in|login|continue|next|verify|submit|log\s?on|sign\s?on)$/i;

// Payment / destructive button text (substring match — block any button containing these)
const SUBMIT_BLOCKLIST = /\b(pay|buy|purchase|place\s?order|subscribe|delete|remove|deactivate|transfer)\b/i;

function safeDisconnect(browser: Browser): void {
  try { (browser as unknown as { disconnect(): void }).disconnect(); } catch { /* ignore */ }
}

async function findPageForDomain(browser: Browser, domain: string) {
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      try {
        const h = new URL(page.url()).hostname;
        if (h === domain || h.endsWith(`.${domain}`)) return page;
      } catch { /* skip malformed */ }
    }
  }
  // Fallback: last open page
  return browser.contexts().flatMap((c) => c.pages()).at(-1);
}

function detectChallengeKind(signals: string[]): "totp" | "email_code" | "sms_code" | "captcha" | "unknown" {
  const s = signals.join(" ").toLowerCase();
  if (/authenticator|totp|google authenticator|authy/.test(s)) return "totp";
  if (/email|inbox|check your email|sent to|we sent/.test(s)) return "email_code";
  if (/sms|text message|phone/.test(s)) return "sms_code";
  if (/captcha|robot|cloudflare|prove you/.test(s)) return "captcha";
  return "unknown";
}

/**
 * Phase 2 of Credential Step Handoff: given that the field is already filled,
 * find the submit button, validate it, click it, wait for the page to settle,
 * then classify the outcome.
 *
 * Never exposes raw field values or page snapshots. Returns only safe metadata.
 */
export async function performSubmitAndWait(params: SubmitAndWaitParams): Promise<SubmitAndWaitResult> {
  const { domain, cdpUrl, step_kind, submit } = params;

  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (err) {
    return {
      status: "submit_failed",
      blocked_reason: `CDP connect failed: ${(err as Error).message}`,
      next_action: { recommended: "stop_and_ask_user", reason: "Could not connect to browser for submit phase." },
    };
  }

  try {
    const page = await findPageForDomain(browser, domain);
    if (!page) {
      return {
        status: "submit_failed",
        blocked_reason: "No open page found in the browser session.",
        next_action: { recommended: "stop_and_ask_user", reason: "Browser has no open pages." },
      };
    }

    const originalUrl = page.url();

    // ── Button finding ──────────────────────────────────────────────────────
    let buttonLocator;
    let foundViaSelector = false;

    if (submit.selector_hint) {
      buttonLocator = page.locator(submit.selector_hint).first();
      foundViaSelector = true;
    } else if (submit.button_text) {
      buttonLocator = page.getByRole("button", { name: submit.button_text, exact: false }).first();
    } else {
      // Default fallback — first visible submit button
      buttonLocator = page.locator("button[type='submit'], input[type='submit']").first();
    }

    // Get button text for validation
    let buttonText: string | null = null;
    try {
      buttonText = (await buttonLocator.textContent({ timeout: 2000 }))?.trim() ?? null;
      // input[type=submit] stores label in value, not textContent
      if (!buttonText) {
        buttonText = await buttonLocator.getAttribute("value", { timeout: 500 }).catch(() => null);
      }
    } catch { /* element may not be found yet */ }

    // Blocklist check (always enforced regardless of how button was found)
    if (buttonText && SUBMIT_BLOCKLIST.test(buttonText)) {
      return {
        status: "blocked_policy",
        blocked_reason: `Submit button text "${buttonText.slice(0, 60)}" is on the payment/destructive action blocklist. Only login-type submit actions are permitted.`,
        next_action: { recommended: "stop_and_ask_user", reason: "Handoff blocked by policy. Do not retry without user direction." },
      };
    }

    // Allowlist check — enforced when button was found by fallback (no explicit selector or text hint)
    if (!foundViaSelector && !submit.button_text) {
      if (buttonText && !SUBMIT_ALLOWLIST.test(buttonText)) {
        return {
          status: "blocked_policy",
          blocked_reason: `Default button text "${buttonText.slice(0, 60)}" is not on the login-type allowlist. Provide an explicit selector_hint or button_text to proceed.`,
          next_action: { recommended: "stop_and_ask_user", reason: "Button not recognized as a login-type action." },
        };
      }
    }

    // ── Click + Wait ────────────────────────────────────────────────────────
    try {
      await buttonLocator.click({ timeout: 3000 });
    } catch (err) {
      // Click failure — field was filled but submit did not happen
      const msg = (err as Error).message ?? "";
      return {
        status: "submit_failed",
        current_url: page.url(),
        blocked_reason: `Button click failed: ${msg.slice(0, 120)}`,
        next_action: { recommended: "stop_and_ask_user", reason: "Submit button could not be clicked. Check browser state." },
      };
    }

    // Wait for page to settle after submit
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});

    const currentUrl = page.url();
    const navigated = currentUrl !== originalUrl;
    const pageTitle = await page.title().catch(() => undefined);
    const signals = await extractPageTextSignals(page);
    const outcome = classifyLoginOutcome(signals);

    // Challenge takes priority over navigated/success classification
    if (outcome?.outcome === "manual_challenge_required") {
      return {
        status: "challenge_detected",
        current_url: currentUrl,
        page_title: pageTitle,
        challenge_kind: detectChallengeKind(signals),
        signals_detected: outcome.signals_detected,
        next_action: { recommended: "report_security_challenge", reason: outcome.user_message },
      };
    }

    if (navigated) {
      return {
        status: "navigated",
        current_url: currentUrl,
        page_title: pageTitle,
        ...(outcome?.signals_detected?.length ? { signals_detected: outcome.signals_detected } : {}),
      };
    }

    // No navigation — check failure signals
    if (outcome?.outcome === "invalid_credentials") {
      return {
        status: "invalid_credentials",
        current_url: currentUrl,
        page_title: pageTitle,
        signals_detected: outcome.signals_detected,
        next_action: { recommended: "retry_login", reason: outcome.user_message },
      };
    }

    if (outcome?.outcome === "captcha_required" || outcome?.outcome === "rate_limited") {
      return {
        status: "manual_step_required",
        current_url: currentUrl,
        page_title: pageTitle,
        signals_detected: outcome.signals_detected,
        next_action: { recommended: "stop_and_ask_user", reason: outcome.user_message },
      };
    }

    // No navigation, no recognized signal — classify as step_completed if page looks settled,
    // otherwise manual_step_required
    if (outcome === null) {
      return {
        status: "step_completed",
        current_url: currentUrl,
        page_title: pageTitle,
      };
    }

    return {
      status: "manual_step_required",
      current_url: currentUrl,
      page_title: pageTitle,
      ...(outcome.signals_detected?.length ? { signals_detected: outcome.signals_detected } : {}),
      next_action: { recommended: "stop_and_ask_user", reason: "Page did not navigate after submit. Check browser state." },
    };
  } catch (err) {
    return {
      status: "submit_failed",
      blocked_reason: (err as Error).message ?? "Submit phase encountered an unexpected error.",
      next_action: { recommended: "stop_and_ask_user", reason: "Submit phase failed." },
    };
  } finally {
    if (browser) safeDisconnect(browser);
  }
}
