import type { Page } from "playwright";
import type {
  AgentSafeObservationSnapshot,
  AgentSafeObservationElement,
  AgentSafeElementKind,
  ObservationDryRunOpenSummary,
  DelegationTrustTaskCategory,
} from "@aegis/types";
import {
  getObservationModeState,
  initialObservationModeState,
  storeObservationSnapshot,
  type RuntimeObservationActivationReason,
} from "./aegisRuntime.js";
import { newId } from "../store/index.js";

// ─── Sensitivity constants ────────────────────────────────────────────────────

// URL path patterns that indicate a sensitive page context.
export const SENSITIVE_URL_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /\/login\b/i,       signal: "url:/login" },
  { pattern: /\/signin\b/i,      signal: "url:/signin" },
  { pattern: /\/sign-in\b/i,     signal: "url:/sign-in" },
  { pattern: /\/checkout\b/i,    signal: "url:/checkout" },
  { pattern: /\/payment\b/i,     signal: "url:/payment" },
  { pattern: /\/billing\b/i,     signal: "url:/billing" },
  { pattern: /\/demo-login\b/i,  signal: "url:/demo-login" },
  { pattern: /\/demo-travel\b/i, signal: "url:/demo-travel" },
  { pattern: /\/transfer\b/i,    signal: "url:/transfer" },
  { pattern: /\/booking\b/i,     signal: "url:/booking" },
];

// Task categories that require protected observation from the start.
export const SENSITIVE_TASK_CATEGORIES = new Set<DelegationTrustTaskCategory>([
  "login",
  "credential_fill",
  "purchase",
  "payment",
  "travel_booking",
  "financial_action",
  "identity_disclosure",
  "account_change",
  "destructive_action",
]);

export function isSensitiveTaskCategory(taskCategory?: string): boolean {
  if (!taskCategory) return false;
  return SENSITIVE_TASK_CATEGORIES.has(taskCategory as DelegationTrustTaskCategory);
}

export function urlLooksSensitive(url: string): { signal: string; reason: RuntimeObservationActivationReason } | undefined {
  for (const { pattern, signal } of SENSITIVE_URL_PATTERNS) {
    if (pattern.test(url)) return { signal, reason: "sensitive_url_detected" };
  }
  return undefined;
}

// ─── Page sensitivity scan ───────────────────────────────────────────────────

// Scans URL and DOM for sensitivity signals. Returns signals with reasons.
// Uses raw JS string for page.evaluate() to avoid DOM type errors in Node tsconfig.
// All page.evaluate() calls caught silently — never fails the caller.
export async function scanPageForSensitivitySignals(page: Page): Promise<Array<{
  signal: string;
  reason: RuntimeObservationActivationReason;
}>> {
  const results: Array<{ signal: string; reason: RuntimeObservationActivationReason }> = [];

  const currentUrl = page.url();
  for (const { pattern, signal } of SENSITIVE_URL_PATTERNS) {
    if (pattern.test(currentUrl)) {
      results.push({ signal, reason: "sensitive_url_detected" });
    }
  }

  const domSignals = await page.evaluate(`(function() {
    var signals = [];
    if (document.querySelectorAll('input[type="password"]').length > 0) {
      signals.push('input:type=password');
    }
    var paymentAcs = ['cc-number','cc-csc','cc-exp','cc-exp-month','cc-exp-year'];
    for (var i = 0; i < paymentAcs.length; i++) {
      if (document.querySelector('input[autocomplete="' + paymentAcs[i] + '"]')) {
        signals.push('autocomplete:' + paymentAcs[i]);
      }
    }
    var credAcs = ['current-password','new-password','one-time-code'];
    for (var j = 0; j < credAcs.length; j++) {
      if (document.querySelector('input[autocomplete="' + credAcs[j] + '"]')) {
        signals.push('autocomplete:' + credAcs[j]);
      }
    }
    var labels = Array.from(document.querySelectorAll('label, legend, [aria-label]'));
    var sensitiveTerms = ['password','credit card','card number','cvv','security code','social security','ssn','passport','routing number','bank account'];
    var seenTerms = {};
    for (var k = 0; k < labels.length; k++) {
      var txt = (labels[k].textContent || '').toLowerCase();
      for (var m = 0; m < sensitiveTerms.length; m++) {
        if (!seenTerms[sensitiveTerms[m]] && txt.indexOf(sensitiveTerms[m]) >= 0) {
          signals.push('label:' + sensitiveTerms[m].replace(/ /g, '_'));
          seenTerms[sensitiveTerms[m]] = true;
        }
      }
    }
    return signals;
  })()`).catch(() => []) as string[];

  for (const signal of domSignals) {
    results.push({ signal, reason: "sensitive_dom_detected" });
  }

  return results;
}

// ─── Protected observation snapshot ──────────────────────────────────────────

// Builds an agent-safe observation snapshot of the current page.
// NEVER includes raw password/credential values — only boolean filled state.
// Conservative: uncertain classifications → value_redacted: true.
// Only used when protected_observation mode is active.
export async function buildAgentSafeObservationSnapshot(
  page: Page,
  sessionId: string,
  runId: string | undefined,
  userId: string,
  domain: string
): Promise<AgentSafeObservationSnapshot> {
  const modeState = getObservationModeState(sessionId) ?? initialObservationModeState();
  const pageUrl = page.url();
  const now = new Date().toISOString();

  type RawElement = {
    kind: AgentSafeElementKind;
    role: string | null;
    label: string | null;
    text: string | null;
    placeholder: string | null;
    input_type: string | null;
    sensitive: boolean;
    sensitivity: string | null;
    filled: boolean;
  };

  // Raw JS IIFE string — avoids DOM type errors in Node tsconfig.
  // NEVER reads .value from sensitive/password inputs — only boolean filled state.
  const rawElements = await page.evaluate(`(function() {
    var MAX_ELEMENTS = 100;

    function classifySensitivity(el) {
      var type = (el.type || '').toLowerCase();
      var name = (el.name || '').toLowerCase();
      var id = (el.id || '').toLowerCase();
      var ac = (el.autocomplete || '').toLowerCase();
      var ph = (el.placeholder || '').toLowerCase();
      var combined = ' ' + name + ' ' + id + ' ' + ac + ' ' + ph + ' ';
      if (type === 'password' || /current-password|new-password|one-time-code/.test(ac)) return 'credential';
      if (/cc-number|cardnumber|card.number|cc-name/.test(combined)) return 'payment';
      if (/cc-csc|cvv|cvc|security.code|card.cvc/.test(combined)) return 'payment';
      if (/cc-exp/.test(ac)) return 'payment';
      if (/ssn|social.security|passport|license|dob|birthdate|date.of.birth/.test(combined)) return 'identity';
      if (/routing|account.number|bank.account|account_number/.test(combined)) return 'financial';
      if (/password|passcode|pin |secret|token|key/.test(combined)) return 'credential';
      if (/card|payment|billing|checkout/.test(combined)) return 'payment';
      return null;
    }

    function classifyButton(text) {
      var t = text.toLowerCase();
      if (/\\bpay\\b|purchase|place order|buy now|checkout|confirm booking|confirm payment|submit payment/.test(t)) return 'payment';
      if (/\\btransfer\\b|\\bwire\\b|\\btrade\\b|\\bsell\\b|buy stock/.test(t)) return 'financial';
      if (/delete account|close account|delete my account/.test(t)) return 'destructive';
      if (/change password|reset password/.test(t)) return 'account_change';
      if (/sign in|log in|\\blogin\\b|sign-in/.test(t)) return 'credential';
      return null;
    }

    function getLabel(el) {
      var ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.slice(0, 80);
      var id = el.getAttribute('id');
      if (id) {
        try {
          var escaped = CSS.escape ? CSS.escape(id) : id.replace(/[^\\w-]/g, '\\\\$&');
          var lbl = document.querySelector('label[for="' + escaped + '"]');
          if (lbl) return (lbl.textContent || '').trim().slice(0, 80);
        } catch(e) {}
      }
      var parentLabel = el.closest('label');
      if (parentLabel) return (parentLabel.textContent || '').trim().slice(0, 80);
      return null;
    }

    var selector = 'input, textarea, select, button, a[href], [role="button"], [role="link"]';
    var els = Array.from(document.querySelectorAll(selector)).slice(0, MAX_ELEMENTS);
    var results = [];

    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var tag = el.tagName.toLowerCase();
      var kind = 'other';
      var sensitive = false;
      var sensitivity = null;
      var filled = false;
      var text = null;
      var inputType = null;
      var placeholder = null;
      var role = el.getAttribute('role') || null;

      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        kind = 'field';
        inputType = el.type || null;
        placeholder = el.placeholder ? el.placeholder.slice(0, 80) : null;
        if (tag === 'input') {
          sensitivity = classifySensitivity(el);
          sensitive = !!sensitivity;
        }
        // Only .value.length boolean — never store the actual value
        filled = el.value.length > 0;
      } else if (tag === 'button' || role === 'button' || (tag === 'input' && el.type === 'submit')) {
        kind = 'button';
        text = (el.textContent || '').trim().slice(0, 80) || (el.value || '').slice(0, 80);
        sensitivity = classifyButton(text || '');
        if (sensitivity) sensitive = true;
      } else if (tag === 'a' || role === 'link') {
        kind = 'link';
        text = (el.textContent || '').trim().slice(0, 80);
      }

      var derivedRole = role || (tag === 'button' ? 'button' : tag === 'a' ? 'link' : tag === 'input' ? 'textbox' : null);

      results.push({
        kind: kind,
        role: derivedRole,
        label: getLabel(el),
        text: text,
        placeholder: placeholder,
        input_type: inputType,
        sensitive: sensitive,
        sensitivity: sensitivity,
        filled: filled,
      });
    }

    return results;
  })()`).catch(() => []) as RawElement[];

  const elements: AgentSafeObservationElement[] = rawElements.map((raw, idx) => {
    const elementId = `el_${String(idx + 1).padStart(3, '0')}`;

    let requiredCapability: "login_credential" | "payment_method" | "identity_profile" | undefined;
    if (raw.sensitivity === 'credential') requiredCapability = 'login_credential';
    else if (raw.sensitivity === 'payment' || raw.sensitivity === 'financial') requiredCapability = 'payment_method';
    else if (raw.sensitivity === 'identity') requiredCapability = 'identity_profile';

    let allowedActions: AgentSafeObservationElement['allowed_actions'];
    let reason: string | undefined;

    if (raw.kind === 'field') {
      if (raw.sensitive) {
        allowedActions = ['read', 'request_fill'];
        reason = `Sensitive field (${raw.sensitivity ?? 'unknown'}) — value protected by Antigen capability release.`;
      } else {
        allowedActions = ['read', 'fill'];
      }
    } else if (raw.kind === 'button') {
      if (raw.sensitive) {
        allowedActions = ['read', 'request_click'];
        reason = `Sensitive action button (${raw.sensitivity ?? 'unknown'}) — must go through Antigen route step.`;
      } else {
        allowedActions = ['read', 'click'];
      }
    } else if (raw.kind === 'link') {
      allowedActions = ['read', 'click'];
    } else {
      allowedActions = ['read'];
    }

    const el: AgentSafeObservationElement = {
      element_id: elementId,
      kind: raw.kind,
      sensitive: raw.sensitive,
      filled: raw.filled,
      allowed_actions: allowedActions,
    };

    if (raw.role) el.role = raw.role;
    if (raw.label) el.label = raw.label;
    if (raw.text) el.text = raw.text;
    if (raw.placeholder) el.placeholder = raw.placeholder;
    if (raw.input_type) el.input_type = raw.input_type;
    if (raw.sensitivity) el.sensitivity = raw.sensitivity as AgentSafeObservationElement['sensitivity'];
    if (requiredCapability) el.required_capability = requiredCapability;
    if (raw.sensitive) el.value_redacted = true;
    if (reason) el.reason = reason;

    return el;
  });

  const sensitiveCount = elements.filter((e) => e.sensitive).length;
  const redactedCount = elements.filter((e) => e.value_redacted).length;
  const capSet = new Set(
    elements
      .map((e) => e.required_capability)
      .filter((c): c is "login_credential" | "payment_method" | "identity_profile" => c !== undefined)
  );

  const snapshot: AgentSafeObservationSnapshot = {
    snapshot_id: newId("obssnap"),
    runtime_session_id: sessionId,
    run_id: runId,
    user_id: userId,
    domain,
    page_url: pageUrl,
    created_at: now,
    observation_mode: modeState,
    elements,
    summary: {
      total_elements: elements.length,
      sensitive_elements: sensitiveCount,
      redacted_values: redactedCount,
      required_capabilities: Array.from(capSet),
    },
  };

  storeObservationSnapshot(sessionId, snapshot);
  return snapshot;
}

// ─── Minimal open observation ─────────────────────────────────────────────────

// Returns a small page summary for non-sensitive pages.
// No input values, no full DOM, no sensitive field content, no screenshots.
export async function buildMinimalOpenObservation(page: Page): Promise<ObservationDryRunOpenSummary> {
  const result = await page.evaluate(`(function() {
    var title = document.title ? document.title.slice(0, 120) : undefined;

    var headingEls = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 5);
    var headings = headingEls.map(function(h) { return (h.textContent || '').trim().slice(0, 100); }).filter(Boolean);

    var linkEls = Array.from(document.querySelectorAll('a[href]')).slice(0, 5);
    var links = linkEls.map(function(a) { return (a.textContent || '').trim().slice(0, 80); }).filter(Boolean);

    var buttonEls = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).slice(0, 10);
    var sensitiveButtonPatterns = /\\bpay\\b|purchase|place order|buy now|checkout|confirm booking|confirm payment|submit payment|transfer|sign in|log in|\\blogin\\b|delete account|change password/i;
    var buttons = [];
    for (var i = 0; i < buttonEls.length; i++) {
      var t = (buttonEls[i].textContent || buttonEls[i].value || '').trim().slice(0, 80);
      if (t && !sensitiveButtonPatterns.test(t)) {
        buttons.push(t);
        if (buttons.length >= 5) break;
      }
    }

    var forms = document.querySelectorAll('form').length;

    return { title: title, headings: headings, links: links, buttons: buttons, forms: forms };
  })()`).catch(() => ({ title: undefined, headings: [], links: [], buttons: [], forms: 0 })) as {
    title?: string;
    headings: string[];
    links: string[];
    buttons: string[];
    forms: number;
  };

  return {
    ...(result.title ? { page_title: result.title } : {}),
    headings: result.headings,
    links_sample: result.links,
    buttons_sample: result.buttons,
    forms_detected: result.forms,
  };
}
