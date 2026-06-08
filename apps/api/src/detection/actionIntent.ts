import type {
  ActionIntent,
  ActionIntentClassification,
  ActionReversibility,
  RiskLevel,
  RiskState,
} from "@aegis/types";

/**
 * Generic, site-agnostic classifier for what a browser action would DO.
 *
 * This is the single source of truth for action classification, shared by the
 * primary Antigen browser_click gate and the legacy sensitiveDetector. It reads
 * STRUCTURAL element metadata only (tag / kind / role / normalized name /
 * href path / bounded context labels) plus the action verb and page URL — never
 * field values, secrets, card data, credentials, or cookies. No site names.
 *
 * Reversible intents (navigation, cart_mutation, checkout_transition) are
 * clickable without a user prompt. Final/irreversible or identity-committing
 * intents (final_commit, publish_send, account_security_change,
 * high_liability_submit) are routed to the existing Aegis handoff tools. Type
 * actions into protected fields classify as protected_fill / payment_method_use.
 * Ambiguous commit-shaped buttons in a high-risk state fail closed (uncertain).
 */

export interface ActionIntentInput {
  action: "click" | "type";
  /** Visible accessible name / button label / element description. Structural, not a value. */
  text?: string;
  /** Pre-normalized name when available (antigen snapshot). */
  normalized_text?: string;
  /** Element role/kind/tag — structural only. */
  role?: string | null;
  kind?: string | null;
  tag?: string | null;
  /** Path portion of the element href (no query/secrets). */
  href_path?: string | null;
  /** Bounded disambiguation context (label/section) — never values. */
  context?: { label?: string; section?: string };
  /** Page URL (path/host only is used; never logged into responses). */
  url?: string;
  /** For type actions: structural field metadata only. */
  input_type?: string;
  autocomplete?: string;
  field_name?: string;
  placeholder?: string;
  /** Advisory current workflow risk state, if known. */
  risk_state?: RiskState;
}

function norm(s: string | undefined | null): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function result(
  action_intent: ActionIntent,
  reversibility: ActionReversibility,
  risk_level: RiskLevel,
  signals: string[],
  confidence: "high" | "low" = "high",
): ActionIntentClassification {
  return { action_intent, reversibility, risk_level, confidence, signals };
}

// ── Click verb patterns (whole-phrase / leading-token; site-agnostic) ────────

// Final purchase/payment commitment. Mirrors the spirit of the
// purchaseConfirmationHandoff allowlist; deliberately does NOT match "checkout".
const FINAL_COMMIT = [
  /\bplace\s+order\b/,
  /\bpay\s*(now|\$|\d)/,
  /^pay$/,
  /\bconfirm\s+(purchase|order|payment|booking)\b/,
  /\bcomplete\s+(purchase|order|payment|booking)\b/,
  /\bsubmit\s+(payment|order)\b/,
  /\bbuy(\s+now)?\b/,
  /\bauthori[sz]e\s+payment\b/,
];

// "Subscribe" is final_commit ONLY when monetary / paid-plan / checkout signals
// are present. A bare newsletter/update "Subscribe" is NOT a purchase commitment.
const SUBSCRIBE_TRIGGER = /\bsubscri(be|ption)\b/;
const PAID_SUBSCRIBE_SIGNAL =
  /(\$\s?\d|\d+\s?(usd|eur|gbp|cad)\b|\/\s?(mo|month|yr|year)\b|\bper\s+(month|year)\b|\bbill(ing|ed)\b|\btrial\b|\brenew(al|s|ed)?\b|\bpaid\b|\bplan\b|\bcheckout\b|\bcard\b|\bpayment\b|\bconfirm\s+purchase\b)/;

const PUBLISH_SEND_STRONG = [/\bpublish\b/, /\btweet\b/, /\bshare\s+(publicly|to\s+\w)/];
// "post" / "send" only count when on a button-like control, to avoid blocking
// navigation links labelled "Posts" etc.
const PUBLISH_SEND_BUTTON = [/^post\b/, /\bsend\b/, /\bpost\s+(now|comment|reply|update)\b/];

const ACCOUNT_SECURITY = [
  /\b(change|update|reset)\s+password\b/,
  /\bdelete\s+account\b/,
  /\bdeactivate\b/,
  /\bclose\s+account\b/,
  /\bremove\s+account\b/,
  /\b(disable|enable|turn\s+(on|off))\s+(2fa|two[-\s]?factor|mfa|authenticator)\b/,
  /\b(add|remove)\s+recovery\b/,
  /\bmanage\s+sessions\b/,
  /\brevoke\s+(access|app|token|session)\b/,
  /\bauthori[sz]e\b/, // OAuth grant ("Authorize")
  /\bconnect\s+(app|account|github|google|service)\b/,
];

const CHECKOUT_TRANSITION = [
  /\b(continue|proceed|go)\s+to\s+(checkout|payment|shipping)\b/,
  /\bcontinue\s+to\b/,
  /^check\s?out$/,
  /\bgo\s+to\s+cart\b/,
];

const CART_MUTATION = [
  /\badd\s+to\s+(cart|bag|basket)\b/,
  /\b(remove|delete)\s+(from\s+)?(cart|bag|basket|item)\b/,
  /\bupdate\s+(cart|bag|quantity|qty)\b/,
  /\bsave\s+for\s+later\b/,
  /\bmove\s+to\s+(cart|bag|wishlist)\b/,
];

// Generic commit-shaped labels that are only sensitive when the workflow is
// already near a commitment. Used for fail-closed "uncertain" classification.
const AMBIGUOUS_COMMIT = [/^continue$/, /^next$/, /^proceed$/, /^confirm$/, /^submit$/, /^done$/, /^agree$/, /^accept$/, /^ok$/];

const HIGH_LIABILITY_VERB = [/\b(submit|agree|accept|sign|consent|authori[sz]e|apply)\b/];
const HIGH_LIABILITY_CONTEXT =
  /\b(legal|consent|medical|health|patient|insurance|tax|irs|gov(ernment)?|loan|mortgage|liability|contract|claim|benefit|ssn|disclosure|hipaa|kyc)\b/;

const RISKY_STATES: ReadonlySet<RiskState> = new Set<RiskState>([
  "payment_required",
  "payment_method_available",
  "final_review",
  "commit_ready",
]);

function anyMatch(patterns: RegExp[], s: string): boolean {
  return patterns.some((re) => re.test(s));
}

function classifyClick(input: ActionIntentInput): ActionIntentClassification {
  const text = input.normalized_text ? norm(input.normalized_text) : norm(input.text);
  const kind = norm(input.kind);
  const ctx = `${norm(input.context?.label)} ${norm(input.context?.section)}`.trim();
  const url = norm(input.url);
  const hay = `${text} ${ctx} ${url}`;
  const buttonLike = kind === "button" || kind === "control" || kind === "summary";

  // 1. Final purchase/payment commitment — strongest, explicit verbs.
  if (anyMatch(FINAL_COMMIT, text)) {
    return result("final_commit", "final", "critical", ["final_commit_verb"]);
  }

  // 1b. Paid subscription commitment — subscribe + monetary/plan/checkout signal.
  //     Bare "Subscribe" (newsletter/updates) falls through to navigation.
  if (SUBSCRIBE_TRIGGER.test(text) && PAID_SUBSCRIBE_SIGNAL.test(hay)) {
    return result("final_commit", "final", "critical", ["paid_subscription_commit"]);
  }

  // 2. Account / security changes.
  if (anyMatch(ACCOUNT_SECURITY, hay)) {
    return result("account_security_change", "final", "high", ["account_security_phrase"]);
  }

  // 3. High-liability submission (needs both a submit-ish verb and a risky context).
  if (anyMatch(HIGH_LIABILITY_VERB, text) && HIGH_LIABILITY_CONTEXT.test(hay)) {
    return result("high_liability_submit", "final", "high", ["high_liability_context"]);
  }

  // 4. Publish / send under the user's identity.
  if (anyMatch(PUBLISH_SEND_STRONG, text) || (buttonLike && anyMatch(PUBLISH_SEND_BUTTON, text))) {
    return result("publish_send", "final", "high", ["publish_send_verb"]);
  }

  // 5. Checkout transition — reversible funnel step, NOT payment.
  if (anyMatch(CHECKOUT_TRANSITION, text)) {
    return result("checkout_transition", "reversible", "low", ["checkout_transition"]);
  }

  // 6. Cart mutation — reversible.
  if (anyMatch(CART_MUTATION, text)) {
    return result("cart_mutation", "reversible", "low", ["cart_mutation"]);
  }

  // 7. Fail closed: a generic commit-shaped button while the workflow is already
  //    near a commitment, or on a clearly payment-ish page, is treated as an
  //    uncertain high-risk action rather than a benign click.
  const nearCommit = input.risk_state !== undefined && RISKY_STATES.has(input.risk_state);
  const paymentishContext = /\b(payment|billing|order\s+review|review\s+order|place\s+your\s+order)\b/.test(hay);
  if (buttonLike && anyMatch(AMBIGUOUS_COMMIT, text) && (nearCommit || paymentishContext)) {
    return result("final_commit", "uncertain", "high", ["ambiguous_commit_high_risk_state"], "low");
  }

  // 8. Default: reversible navigation.
  return result("navigation", "reversible", "low", ["navigation_default"]);
}

function classifyType(input: ActionIntentInput): ActionIntentClassification {
  const inputType = norm(input.input_type);
  const autocomplete = norm(input.autocomplete);
  const name = norm(input.field_name);
  const placeholder = norm(input.placeholder);
  const fieldHay = `${name} ${placeholder}`;

  // Password / credential field → protected fill via secret injection.
  if (inputType === "password" || /\b(password|passwd|otp|one[-\s]?time|verification\s+code)\b/.test(fieldHay)) {
    return result("protected_fill", "reversible", "high", ["credential_field"]);
  }

  // Payment card fields → platform-controlled payment fill.
  if (
    autocomplete.startsWith("cc-") ||
    /\b(cc-|card[-\s]?number|cardnumber|cvv|cvc|security\s+code|expir)\b/.test(fieldHay) ||
    name.includes("card")
  ) {
    return result("payment_method_use", "reversible", "critical", ["payment_card_field"]);
  }

  // Identity / contact fields → protected profile fill.
  const profileAc = [
    "email",
    "tel",
    "name",
    "given-name",
    "family-name",
    "street-address",
    "address-line1",
    "address-line2",
    "postal-code",
    "country-name",
  ];
  if (
    profileAc.some((a) => autocomplete === a || autocomplete.startsWith(a)) ||
    /\b(email|phone|tel|first[-\s]?name|last[-\s]?name|full[-\s]?name|address|street|city|state|zip|postal)\b/.test(fieldHay)
  ) {
    return result("protected_fill", "reversible", "medium", ["profile_field"]);
  }

  // Sensitive government identity fields → still protected fill, high risk.
  if (/\b(ssn|social\s+security|passport|government[-\s]?id|govt[-\s]?id|driver|license)\b/.test(fieldHay)) {
    return result("protected_fill", "reversible", "critical", ["government_id_field"]);
  }

  // Plain text field → benign.
  return result("navigation", "reversible", "low", ["plain_input"]);
}

export function classifyActionIntent(input: ActionIntentInput): ActionIntentClassification {
  return input.action === "type" ? classifyType(input) : classifyClick(input);
}
