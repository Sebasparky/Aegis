import { chromium, type Browser } from "playwright";
import type { PurchaseConfirmationOutcome } from "@aegis/types";

export interface PurchaseConfirmationParams {
  domain: string;
  page_url: string;
  button_text: string;
  button_selector_hint?: string;
  cdpUrl: string;
}

export interface PurchaseConfirmationResult {
  outcome: PurchaseConfirmationOutcome;
  current_url?: string;
  page_title?: string;
  blocked_reason?: string;
}

// Final-action payment button text allowlist (v1 — stricter; "checkout" excluded).
// Matches full normalized text (after trim, toLowerCase). Allows "pay $12.99" style variants.
const PURCHASE_ALLOWLIST =
  /^(pay(\s+(now|\$[\d,.]+|\d+[\d,.]*(\s*(usd|eur|gbp|cad))?))?\s*|place\s+order|confirm\s+(purchase|order)|complete\s+(purchase|order)|submit\s+payment|subscribe(\s+now)?|confirm\s+order)$/i;

// Destructive / non-payment action blocklist — always enforced, substring match.
const PURCHASE_BLOCKLIST =
  /\b(delete|deactivate|close\s+account|transfer|withdraw|send\s+money|post|publish|cancel(\s+subscription)?|sign\s+out|log\s+out|remove\s+account)\b/i;

// Signals that indicate a successful payment/order confirmation.
const SUCCESS_SIGNALS = [
  "test payment submitted",
  "payment successful",
  "order confirmed",
  "order placed",
  "thank you for your order",
  "your order is confirmed",
  "payment complete",
  "purchase complete",
  "subscription confirmed",
  "payment accepted",
];

// Signals that indicate a payment failure.
const FAILURE_SIGNALS = [
  "payment declined",
  "card declined",
  "payment failed",
  "transaction failed",
  "insufficient funds",
  "your payment was not accepted",
  "unable to process",
];

function safeDisconnect(browser: Browser): void {
  try { (browser as unknown as { disconnect(): void }).disconnect(); } catch { /* ignore */ }
}

async function findPageForDomain(browser: Browser, domain: string, pageUrl: string) {
  // Prefer exact page_url match first
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      try {
        if (page.url() === pageUrl) return page;
      } catch { /* skip */ }
    }
  }
  // Then domain match
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      try {
        const h = new URL(page.url()).hostname;
        if (h === domain || h.endsWith(`.${domain}`)) return page;
      } catch { /* skip */ }
    }
  }
  // Fallback: last open page
  return browser.contexts().flatMap((c) => c.pages()).at(-1);
}

async function classifyOutcome(page: import("playwright").Page, originalUrl: string): Promise<PurchaseConfirmationOutcome> {
  const currentUrl = page.url();
  const navigated = currentUrl !== originalUrl;

  // URL-based: explicit confirmation path
  if (navigated && (currentUrl.includes("/stripe-confirmation") || currentUrl.includes("/confirmation") || currentUrl.includes("/order-confirmed"))) {
    return "submitted";
  }

  // Text-based signals
  let bodyText = "";
  try {
    bodyText = (await page.textContent("body", { timeout: 2000 }))?.toLowerCase() ?? "";
  } catch { /* ignore */ }

  for (const sig of SUCCESS_SIGNALS) {
    if (bodyText.includes(sig)) return "submitted";
  }
  for (const sig of FAILURE_SIGNALS) {
    if (bodyText.includes(sig)) return "failed";
  }

  // Navigation without recognized signal — still record as submitted if URL changed
  if (navigated) return "submitted";

  return "manual_step_required";
}

/**
 * Connect to the agent's browser via CDP, locate the approved payment button,
 * validate it against the allowlist/blocklist, click it once, wait for navigation,
 * and classify the outcome.
 *
 * Never fills fields. Never retries. Never solves 3DS. Never closes the browser.
 */
export async function executePurchaseConfirmation(
  params: PurchaseConfirmationParams,
): Promise<PurchaseConfirmationResult> {
  const { domain, page_url, button_text, button_selector_hint, cdpUrl } = params;

  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (err) {
    return {
      outcome: "failed",
      blocked_reason: `CDP connect failed: ${(err as Error).message}`,
    };
  }

  try {
    const page = await findPageForDomain(browser, domain, page_url);
    if (!page) {
      return {
        outcome: "failed",
        blocked_reason: "No open page found in the browser session.",
      };
    }

    // Domain mismatch check
    let currentHostname: string;
    try {
      currentHostname = new URL(page.url()).hostname;
    } catch {
      return { outcome: "failed", blocked_reason: "Could not determine current page hostname." };
    }
    if (currentHostname !== domain && !currentHostname.endsWith(`.${domain}`)) {
      return {
        outcome: "blocked_merchant_mismatch",
        current_url: page.url(),
        blocked_reason: `Current page hostname "${currentHostname}" does not match approved domain "${domain}".`,
      };
    }

    const originalUrl = page.url();

    // ── Button location ────────────────────────────────────────────────────────
    let buttonLocator;
    if (button_selector_hint) {
      buttonLocator = page.locator(button_selector_hint).first();
    } else {
      buttonLocator = page.getByRole("button", { name: button_text, exact: false }).first();
    }

    // Retrieve actual button text for validation
    let resolvedText: string | null = null;
    try {
      resolvedText = (await buttonLocator.textContent({ timeout: 2000 }))?.trim() ?? null;
      if (!resolvedText) {
        resolvedText = await buttonLocator.getAttribute("value", { timeout: 500 }).catch(() => null);
      }
    } catch { /* button may not yet be visible */ }

    const textForValidation = (resolvedText ?? button_text).trim();

    // Blocklist — always enforced
    if (PURCHASE_BLOCKLIST.test(textForValidation)) {
      return {
        outcome: "blocked_policy",
        current_url: page.url(),
        blocked_reason: `Button text "${textForValidation.slice(0, 60)}" is on the destructive/non-payment blocklist.`,
      };
    }

    // Allowlist — enforced when no explicit selector hint
    if (!button_selector_hint) {
      if (!PURCHASE_ALLOWLIST.test(textForValidation)) {
        return {
          outcome: "blocked_policy",
          current_url: page.url(),
          blocked_reason: `Button text "${textForValidation.slice(0, 60)}" is not on the payment action allowlist. Provide an explicit button_selector_hint or use an approved button text.`,
        };
      }
    }

    // ── Click ──────────────────────────────────────────────────────────────────
    try {
      await buttonLocator.click({ timeout: 3000 });
    } catch (err) {
      return {
        outcome: "failed",
        current_url: page.url(),
        blocked_reason: `Button click failed: ${((err as Error).message ?? "").slice(0, 120)}`,
      };
    }

    // Wait for navigation or page settle
    await page.waitForLoadState("domcontentloaded", { timeout: 6000 }).catch(() => {});

    const outcome = await classifyOutcome(page, originalUrl);
    const pageTitle = await page.title().catch(() => undefined);

    return { outcome, current_url: page.url(), page_title: pageTitle };
  } catch (err) {
    return {
      outcome: "failed",
      blocked_reason: (err as Error).message ?? "Purchase confirmation handoff encountered an unexpected error.",
    };
  } finally {
    if (browser) safeDisconnect(browser);
  }
}
