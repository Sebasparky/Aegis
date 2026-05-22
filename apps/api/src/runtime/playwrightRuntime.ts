import { chromium, type Page, type Locator } from "playwright";
import type { RouteLocator } from "@aegis/types";
import { routeRuns, routes, actionAuthorizations, paymentMethods } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { getReceiptRepository } from "../repositories/receiptRepository.js";
import { resolveRouteStepValue } from "../lib/secretResolution.js";
import { buildReceipt } from "../routes/route-runs.js";
import {
  createRuntimeSession,
  createRuntimeIntervention,
  createRuntimeCapabilityRelease,
  findMatchingCapabilityRelease,
  getRuntimeCapabilityReleasesForRun,
  runtimeSessions,
  runtimeEvents,
  getCoverageSummary,
  initialObservationModeState,
  activateProtectedObservationMode,
  type RuntimeEvent,
  type RuntimeEventType,
  type RuntimeEventSensitivity,
  type RuntimeCoverageStatus,
  type RuntimeSession,
  type RuntimeIntervention,
  type RuntimeCapabilityRelease,
  type RuntimeCapabilityType,
} from "./aegisRuntime.js";
import type { RuntimeInterventionType } from "@aegis/types";
import { newId } from "../store/index.js";
import type { RouteStep } from "@aegis/types";
import {
  SENSITIVE_URL_PATTERNS,
  scanPageForSensitivitySignals,
  buildAgentSafeObservationSnapshot,
} from "./agentSafeObservation.js";

// ─── Capability release constants ─────────────────────────────────────────────

const PAYMENT_ACTION_TYPES = new Set([
  "travel_booking", "payment", "purchase", "financial_action",
] as const);

// Buttons whose name/label includes these keywords trigger a payment_method release.
const PAYMENT_INTENT_KEYWORDS = [
  "pay", "book", "purchase", "submit payment", "place order", "confirm payment", "confirm booking",
];

function isPaymentIntentClick(step: RouteStep): boolean {
  const name = (step.target?.preferred_locator?.name ?? "").toLowerCase();
  return PAYMENT_INTENT_KEYWORDS.some((kw) => name.includes(kw));
}

// ─── Sensitive Workflow Observation Mode v1 ───────────────────────────────────

// ActionType values that trigger protected observation mode before page load.
const SENSITIVE_PERMISSIONS = new Set([
  "login", "payment", "purchase", "travel_booking", "financial_action",
  "identity_disclosure", "account_change", "destructive_action",
  "delete_account", "account_setting_change",
]);

// ─── Instrumentation script ───────────────────────────────────────────────────
// Injected before page navigation. Collects metadata-only events.
// NEVER reads input.value or stores field values.

const INSTRUMENTATION_SCRIPT = `
(function() {
  if (window.__aegisInstrumented) return;
  window.__aegisInstrumented = true;
  window.__aegisRuntimeEvents = [];

  function record(evt) { window.__aegisRuntimeEvents.push(evt); }

  function classifyField(el) {
    var type = (el.type || '').toLowerCase();
    var name = (el.name || '').toLowerCase();
    var id = (el.id || '').toLowerCase();
    var ac = (el.autocomplete || '').toLowerCase();
    var combined = ' ' + name + ' ' + id + ' ' + ac + ' ';

    if (type === 'password') return 'credential';
    if (/cc-number|cardnumber|card.number|cc-name/.test(combined)) return 'payment';
    if (/cc-csc|cvv|cvc|security.code|card.cvc/.test(combined)) return 'payment';
    if (/ssn|social.security|passport|license|dob|birthdate|date.of.birth/.test(combined)) return 'identity';
    if (/routing|account.number|bank.account/.test(combined)) return 'financial';
    return null;
  }

  function classifyButtonText(text) {
    var t = text.toLowerCase();
    if (/\\bpay\\b|purchase|place order|buy now|checkout/.test(t)) return 'payment';
    if (/\\btransfer\\b|\\bwire\\b|\\btrade\\b|\\bsell\\b|buy stock/.test(t)) return 'financial';
    if (/delete account|close account|delete my account/.test(t)) return 'destructive';
    if (/change password/.test(t)) return 'account_change';
    if (/sign in|log in|\\blogin\\b|sign-in/.test(t)) return 'credential';
    return null;
  }

  function getFieldHint(el) {
    // Safe metadata only — tag name, type, name/id/autocomplete/placeholder. No value ever.
    var parts = [el.tagName.toLowerCase()];
    if (el.type) parts.push('type=' + el.type);
    if (el.name) parts.push('name=' + el.name.slice(0, 40));
    if (el.id) parts.push('id=' + el.id.slice(0, 40));
    if (el.autocomplete && el.autocomplete !== 'off') parts.push('autocomplete=' + el.autocomplete.slice(0, 30));
    if (el.placeholder) parts.push('placeholder=' + el.placeholder.slice(0, 40));
    return parts.join(' ').slice(0, 120);
  }

  // focusin — sensitive field gained focus
  document.addEventListener('focusin', function(e) {
    var el = e.target;
    if (!el || el.tagName !== 'INPUT') return;
    var sensitivity = classifyField(el);
    if (!sensitivity) return;
    record({ event_type: 'sensitive_field_focus', sensitivity: sensitivity, page_url: location.href, element_hint: getFieldHint(el), timestamp: new Date().toISOString() });
  }, true);

  // input — value was changed; NEVER read .value
  document.addEventListener('input', function(e) {
    var el = e.target;
    if (!el || el.tagName !== 'INPUT') return;
    var sensitivity = classifyField(el);
    if (!sensitivity) return;
    record({ event_type: 'sensitive_field_input', sensitivity: sensitivity, page_url: location.href, element_hint: getFieldHint(el), timestamp: new Date().toISOString() });
  }, true);

  // click — sensitive button/link
  document.addEventListener('click', function(e) {
    var el = e.target;
    if (!el) return;
    // Walk up to first button/a/input
    var btn = el;
    while (btn && btn !== document.body && btn.tagName !== 'BUTTON' && btn.tagName !== 'A' && !(btn.tagName === 'INPUT' && btn.type === 'submit')) {
      btn = btn.parentElement;
    }
    if (!btn || btn === document.body) return;
    var text = (btn.textContent || btn.value || '').trim().slice(0, 80);
    var sensitivity = classifyButtonText(text);
    if (!sensitivity) return;
    record({ event_type: 'sensitive_button_click', sensitivity: sensitivity, page_url: location.href, element_hint: text, timestamp: new Date().toISOString() });
  }, true);

  // submit — form submission
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form) return;
    var hasPassword = !!form.querySelector('input[type="password"]');
    var sensitivity = hasPassword ? 'credential' : 'unknown_sensitive';
    var hint = (form.id || form.name || (form.action ? form.action.split('?')[0] : '') || 'form').slice(0, 80);
    record({ event_type: 'sensitive_form_submit', sensitivity: sensitivity, page_url: location.href, element_hint: hint, timestamp: new Date().toISOString() });
  }, true);
})();
`;


// ─── Coverage windows ─────────────────────────────────────────────────────────
//
// Coverage windows use browser-side timestamps obtained via page.evaluate(() => Date.now())
// so that window boundaries and event timestamps share the same clock source.
// Never use Node's Date.now() for window boundaries — cross-context clock drift
// or async scheduling can cause events to be incorrectly matched.

interface CoverageWindow {
  sensitivity: RuntimeEventSensitivity;
  eventTypes: Set<RuntimeEventType>;
  openMs: number;   // browser epoch ms (from page.evaluate(() => Date.now()))
  closeMs: number;  // openMs + durationMs
  reason: string;
}

// nowMs must be a browser-side timestamp obtained via page.evaluate(() => Date.now())
// immediately before calling this function — do not pass Node's Date.now().
function openCoverageWindow(
  windows: CoverageWindow[],
  sensitivity: RuntimeEventSensitivity,
  eventTypes: RuntimeEventType[],
  nowMs: number,
  durationMs: number,
  reason: string
): void {
  windows.push({
    sensitivity,
    eventTypes: new Set(eventTypes),
    openMs: nowMs,
    closeMs: nowMs + durationMs,
    reason,
  });
}

function matchesCoverageWindow(
  windows: CoverageWindow[],
  eventType: RuntimeEventType,
  sensitivity: RuntimeEventSensitivity,
  timestampMs: number
): CoverageWindow | undefined {
  return windows.find(
    (w) =>
      w.sensitivity === sensitivity &&
      w.eventTypes.has(eventType) &&
      timestampMs >= w.openMs &&
      timestampMs <= w.closeMs
  );
}

// ─── Severity mapping ─────────────────────────────────────────────────────────

function computeSeverity(
  sensitivity: RuntimeEventSensitivity,
  eventType: RuntimeEventType
): "info" | "warning" | "high" | "critical" {
  if (sensitivity === "payment" || sensitivity === "financial" || sensitivity === "identity" || sensitivity === "destructive") {
    return "critical";
  }
  if (sensitivity === "credential") {
    return eventType === "sensitive_field_focus" ? "high" : "high";
  }
  if (sensitivity === "account_change") return "high";
  if (sensitivity === "unknown_sensitive") return "warning";
  return "info";
}

// ─── Locator helpers ──────────────────────────────────────────────────────────

function buildLocator(page: Page, loc: RouteLocator): Locator {
  switch (loc.type) {
    case "role":        return page.getByRole(loc.role as any, { name: loc.name });
    case "label":       return page.getByLabel(loc.name!);
    case "placeholder": return page.getByPlaceholder(loc.name!);
    case "testid":      return page.getByTestId(loc.name!);
    case "css":         return page.locator(loc.value ?? loc.name!);
    case "xpath":       return page.locator(`xpath=${loc.value ?? loc.name!}`);
    default:            return page.locator(loc.name!);
  }
}

async function tryLocator(page: Page, target: import("@aegis/types").ElementTarget): Promise<Locator> {
  for (const loc of [target.preferred_locator, ...target.fallback_locators]) {
    try {
      const l = buildLocator(page, loc);
      await l.waitFor({ timeout: 2000 });
      return l;
    } catch {
      // try next
    }
  }
  return buildLocator(page, target.preferred_locator);
}

// ─── Event collection and conversion ─────────────────────────────────────────

interface RawPageEvent {
  event_type: string;
  sensitivity: string;
  page_url: string;
  element_hint: string;
  timestamp: string;
}

async function collectRawPageEvents(page: Page): Promise<RawPageEvent[]> {
  try {
    return await page.evaluate(() => (globalThis as any).__aegisRuntimeEvents ?? []);
  } catch {
    return [];
  }
}

// ─── Capability release helpers ───────────────────────────────────────────────

function requiredCapabilityForEvent(
  event: { sensitivity: string; event_type: string },
  actionType?: string
): RuntimeCapabilityType | undefined {
  if (event.sensitivity === "credential") return "login_credential";
  if (event.sensitivity === "payment" || event.sensitivity === "financial") return "payment_method";
  if (event.sensitivity === "identity") return "identity_profile";
  // unknown_sensitive form submits in payment/travel routes require a payment_method release.
  if (
    event.sensitivity === "unknown_sensitive" &&
    event.event_type === "sensitive_form_submit" &&
    actionType &&
    PAYMENT_ACTION_TYPES.has(actionType as any)
  ) {
    return "payment_method";
  }
  return undefined;
}

function buildCapabilityReleaseSummary(releases: RuntimeCapabilityRelease[]) {
  return {
    releases_created: releases.length,
    login_credential_releases: releases.filter((r) => r.capability_type === "login_credential").length,
    payment_method_releases: releases.filter((r) => r.capability_type === "payment_method").length,
    identity_profile_releases: releases.filter((r) => r.capability_type === "identity_profile").length,
    raw_secret_revealed_to_agent: false as const,
  };
}

function convertPageEvents(
  rawEvents: RawPageEvent[],
  coverageWindows: CoverageWindow[],
  meta: { runtime_session_id: string; run_id?: string; user_id: string; domain: string },
  actionType?: string
): RuntimeEvent[] {
  const now = new Date().toISOString();
  return rawEvents.map((raw) => {
    const eventType = raw.event_type as RuntimeEventType;
    const sensitivity = raw.sensitivity as RuntimeEventSensitivity;
    const timestampMs = raw.timestamp ? Date.parse(raw.timestamp) : Date.now();

    const requiredCapability = requiredCapabilityForEvent(
      { sensitivity: raw.sensitivity, event_type: raw.event_type },
      actionType
    );

    let coverage_status: RuntimeCoverageStatus;
    let reason: string;
    let matchedRelease: RuntimeCapabilityRelease | undefined = undefined;

    if (requiredCapability) {
      // Capability-required path: timing windows are NOT the coverage basis.
      // A release must exist — if not, the event is not_covered regardless of timing.
      matchedRelease = meta.run_id
        ? findMatchingCapabilityRelease({
            run_id: meta.run_id,
            user_id: meta.user_id,
            domain: meta.domain,
            capability_type: requiredCapability,
          })
        : undefined;
      if (matchedRelease) {
        coverage_status = "covered_by_aegis";
        reason = `Capability release ${matchedRelease.capability_release_id} (${requiredCapability}) granted by Antigen for this run.`;
      } else {
        coverage_status = "not_covered_by_aegis";
        reason = `Sensitive event (${sensitivity}) requires ${requiredCapability} capability release — none found for this run.`;
      }
    } else {
      // No named capability required.
      // unknown_sensitive high/critical events: conservative — do not grant coverage via timing alone.
      const severity = computeSeverity(sensitivity, eventType);
      const isUnknownSensitiveHighRisk =
        (sensitivity as string) === "unknown_sensitive" &&
        (severity === "high" || severity === "critical");

      if (isUnknownSensitiveHighRisk) {
        coverage_status = "not_covered_by_aegis";
        reason = `Sensitive event (unknown_sensitive, ${severity}) — timing-window coverage withheld for high/critical risk without a capability release.`;
      } else {
        // Lower-risk events with no capability requirement may use timing windows.
        const matched = matchesCoverageWindow(coverageWindows, eventType, sensitivity, timestampMs);
        if (matched) {
          coverage_status = "covered_by_aegis";
          reason = matched.reason;
        } else if (severity === "high" || severity === "critical") {
          coverage_status = "not_covered_by_aegis";
          reason = `Sensitive event (${sensitivity}) detected outside an Antigen-controlled action window.`;
        } else {
          coverage_status = "unknown";
          reason = `Sensitive event detected; coverage could not be determined.`;
        }
      }
    }

    return {
      event_id: newId("rtevent"),
      runtime_session_id: meta.runtime_session_id,
      run_id: meta.run_id,
      user_id: meta.user_id,
      domain: meta.domain,
      page_url: raw.page_url,
      event_type: eventType,
      sensitivity,
      coverage_status,
      severity: computeSeverity(sensitivity, eventType),
      element_hint: raw.element_hint,
      reason,
      created_at: raw.timestamp || now,
      capability_type_required: requiredCapability,
      capability_release_id: matchedRelease?.capability_release_id,
      capability_release_present: requiredCapability !== undefined
        ? matchedRelease !== undefined
        : undefined,
    };
  });
}

// ─── Intervention helpers ─────────────────────────────────────────────────────

function mapEventToInterventionType(eventType: RuntimeEventType): RuntimeInterventionType {
  switch (eventType) {
    case "sensitive_button_click":  return "blocked_uncovered_sensitive_click";
    case "sensitive_form_submit":   return "blocked_uncovered_sensitive_submit";
    case "sensitive_field_input":   return "blocked_uncovered_sensitive_input";
    default:                        return "failed_uncovered_sensitive_event";
  }
}

// ─── Main execution function ──────────────────────────────────────────────────

export async function executeRouteRunWithPlaywright(runId: string): Promise<RuntimeSession> {
  const run = routeRuns.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  if (run.status === "pending_approval") {
    throw Object.assign(new Error("Run requires user approval before Playwright execution."), { code: "APPROVAL_REQUIRED" });
  }
  if (run.status !== "pending") {
    throw Object.assign(new Error(`Run is not in pending state (status: ${run.status}).`), { code: "INVALID_STATE" });
  }

  const route = routes.get(run.route_id);
  if (!route) throw new Error(`Route not found: ${run.route_id}`);
  if (!route.start_url) throw new Error(`Route ${run.route_id} does not have a start_url — required for Playwright runtime.`);

  const session = createRuntimeSession({
    run_id: runId,
    user_id: run.user_id,
    domain: run.domain,
    start_url: route.start_url,
  });

  run.status = "running";
  run.started_at = new Date().toISOString();
  routeRuns.set(runId, run);
  schedulePersist();

  session.status = "running";
  session.updated_at = new Date().toISOString();
  runtimeSessions.set(session.runtime_session_id, session);

  // Derive action type from the authorization for capability release decisions.
  const authorization = run.authorization_id
    ? actionAuthorizations.get(run.authorization_id)
    : undefined;
  const actionType = authorization?.action?.action_type as string | undefined;

  // ── Observation mode: activate based on route permissions ────────────────
  for (const perm of (route.required_permissions ?? [])) {
    if (SENSITIVE_PERMISSIONS.has(perm)) {
      activateProtectedObservationMode(
        session.runtime_session_id,
        "required_permission_sensitive",
        `permission:${perm}`
      );
    }
  }
  if (route.sensitivity_level === "sensitive" && session.observation_mode?.mode !== "protected_observation") {
    activateProtectedObservationMode(
      session.runtime_session_id,
      "route_marked_sensitive",
      "sensitivity_level:sensitive"
    );
  }

  const coverageWindows: CoverageWindow[] = [];
  const COVERAGE_DURATION_MS = 2500;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.addInitScript(INSTRUMENTATION_SCRIPT);
    await page.goto(route.start_url, { waitUntil: "domcontentloaded" });

    // For violation demo routes: trigger the violation event via page.evaluate
    // AFTER goto() returns (DOM is ready, instrumentation listeners are installed)
    // but BEFORE any route step executes or coverage window opens.
    // This is deterministic: addInitScript cannot be used because document.body
    // does not exist during the init phase. No password value is set or read —
    // the password field is structural metadata only.
    if (route.start_url.includes("violation=1")) {
      await page.evaluate(
        `(function() {
          var form = document.createElement("form");
          form.style.display = "none";
          var pwd = document.createElement("input");
          pwd.type = "password";
          form.appendChild(pwd);
          document.body.appendChild(form);
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          document.body.removeChild(form);
        })()`
      );
    }

    // ── Observation mode: URL + DOM sensitivity scan ──────────────────────
    const pageSignals = await scanPageForSensitivitySignals(page);
    for (const { signal, reason } of pageSignals) {
      activateProtectedObservationMode(session.runtime_session_id, reason, signal);
    }
    // Initial observation snapshot (after DOM load and scan)
    await buildAgentSafeObservationSnapshot(
      page, session.runtime_session_id, runId, run.user_id, run.domain
    ).catch(() => {});

    for (const step of route.steps) {
      if (step.action === "fill" && step.value_policy) {
        const vp = step.value_policy;

        if (vp.type === "pass_field" || vp.type === "secret_ref") {
          // Credential fill — open coverage window using browser-side timestamp,
          // then resolve the secret via KMS vault (never exposed to agent).
          const credBrowserNow = await page.evaluate(() => Date.now());
          openCoverageWindow(
            coverageWindows,
            "credential",
            ["sensitive_field_focus", "sensitive_field_input"],
            credBrowserNow,
            COVERAGE_DURATION_MS,
            `Antigen Playwright runtime filling ${vp.type === "secret_ref" ? "secret credential" : "pass field"} via KMS vault — secret resolved server-side, never exposed to agent.`
          );

          const resolved = await resolveRouteStepValue(run, step);
          const locator = await tryLocator(page, step.target);
          await locator.fill(resolved.value);

          run.credential_used = true;
          run.secret_values_revealed_to_agent = false;
          run.pass_ids_used = Array.from(new Set([...(run.pass_ids_used ?? []), resolved.pass_id]));
          routeRuns.set(runId, run);
          schedulePersist();

          // Create login_credential release only for secret_ref (password) fills.
          // pass_field (username) is not a secret capability — no release needed.
          // capability_ref = pass_id (the vault pass identifier, not the secret value).
          if (vp.type === "secret_ref" && resolved.pass_id) {
            if (!findMatchingCapabilityRelease({
              run_id: run.run_id,
              user_id: run.user_id,
              domain: run.domain,
              capability_type: "login_credential",
              capability_ref: resolved.pass_id,
            })) {
              createRuntimeCapabilityRelease({
                run_id: run.run_id,
                authorization_id: run.authorization_id,
                authorization_hash: run.authorization_hash,
                user_id: run.user_id,
                domain: run.domain,
                capability_type: "login_credential",
                capability_ref: resolved.pass_id,
                task_category: "login",
                route_id: route.route_id,
                route_step_id: step.step_id,
                released_to: "aegis_playwright_runtime",
                raw_secret_revealed_to_agent: false,
              });
            }
          }

        } else if (vp.type === "safe_literal" || vp.type === "enum_selection") {
          // Non-secret literal — use value directly, no KMS resolution needed.
          const locator = await tryLocator(page, step.target);
          await locator.fill(vp.value ?? "");

        } else if (vp.type === "runtime_variable" && step.variable_binding) {
          // Runtime variable bound at run creation time.
          const locator = await tryLocator(page, step.target);
          await locator.fill(step.variable_binding);
        }
        // user_approval_required and sensitive_redacted: no-op — no value to fill.

      } else if (step.action === "click") {
        // For payment/travel routes, create a payment_method release before the click
        // only when the button name indicates a payment submission intent.
        if (actionType && PAYMENT_ACTION_TYPES.has(actionType as any) && isPaymentIntentClick(step)) {
          const userPaymentMethod =
            Array.from(paymentMethods.values()).find(
              (pm) => pm.user_id === run.user_id && pm.is_default && pm.status === "active"
            ) ??
            Array.from(paymentMethods.values()).find(
              (pm) => pm.user_id === run.user_id && pm.status === "active"
            );
          if (userPaymentMethod) {
            if (!findMatchingCapabilityRelease({
              run_id: run.run_id,
              user_id: run.user_id,
              domain: run.domain,
              capability_type: "payment_method",
              capability_ref: userPaymentMethod.payment_method_id,
            })) {
              createRuntimeCapabilityRelease({
                run_id: run.run_id,
                authorization_id: run.authorization_id,
                authorization_hash: run.authorization_hash,
                user_id: run.user_id,
                domain: run.domain,
                capability_type: "payment_method",
                capability_ref: userPaymentMethod.payment_method_id,
                task_category: actionType,
                route_id: route.route_id,
                route_step_id: step.step_id,
                constraints: {
                  max_amount_usd: authorization?.constraints?.max_amount_usd,
                  currency: authorization?.constraints?.currency,
                  allowed_payment_instrument_types: authorization?.constraints?.allowed_payment_instrument_types,
                  allowed_domains: authorization?.constraints?.allowed_domains,
                },
                released_to: "aegis_playwright_runtime",
                raw_secret_revealed_to_agent: false,
              });
            }
          }
          // If no payment method found, no release is created.
          // Any payment submit will have no matching release → not_covered_by_aegis.
        }

        // Get browser-side timestamp immediately before opening coverage windows.
        // This ensures window boundaries and event timestamps share the same clock.
        const clickBrowserNow = await page.evaluate(() => Date.now());

        // Open coverage windows for every sensitivity a button click or form submit could produce.
        // Windows are time-bounded from the browser's clock and only opened when Antigen
        // explicitly executes a click step — not weakening global coverage.
        const clickReason = "Button click / form submit executed by Antigen Playwright runtime under route control.";
        const buttonSensitivities: RuntimeEventSensitivity[] = [
          "payment", "financial", "credential", "destructive", "account_change",
        ];
        for (const s of buttonSensitivities) {
          openCoverageWindow(coverageWindows, s, ["sensitive_button_click", "sensitive_form_submit"], clickBrowserNow, COVERAGE_DURATION_MS, clickReason);
        }
        // Form submits on pages without a password field are classified as "unknown_sensitive"
        openCoverageWindow(coverageWindows, "unknown_sensitive", ["sensitive_form_submit"], clickBrowserNow, COVERAGE_DURATION_MS, clickReason);

        const locator = await tryLocator(page, step.target);
        await locator.click();

        // Post-click snapshot (non-blocking — failure does not affect the run)
        if (session.status === "running") {
          await buildAgentSafeObservationSnapshot(
            page, session.runtime_session_id, runId, run.user_id, run.domain
          ).catch(() => {});
        }
      }
    }

    // Wait for success navigation (matches any /success URL for demo routes)
    await page.waitForURL(/\/success/, { timeout: 10000 }).catch(() => {});

    // Collect page events and convert with coverage classification
    const rawEvents = await collectRawPageEvents(page);
    const events = convertPageEvents(rawEvents, coverageWindows, {
      runtime_session_id: session.runtime_session_id,
      run_id: runId,
      user_id: run.user_id,
      domain: run.domain,
    }, actionType);

    // Store in Map and on session
    for (const ev of events) {
      runtimeEvents.set(ev.event_id, ev);
    }
    session.runtime_events = events;

    // ── Violation check ───────────────────────────────────────────────────────
    // If any high/critical-severity sensitive events occurred outside an Antigen
    // coverage window, block the run and record an intervention receipt.
    // Authorization stays "active" — the action did not safely complete.
    const uncoveredSensitiveEvents = events.filter(
      (e) => e.coverage_status === "not_covered_by_aegis"
    );

    if (uncoveredSensitiveEvents.length > 0) {
      const interventions: RuntimeIntervention[] = uncoveredSensitiveEvents.map((e) =>
        createRuntimeIntervention({
          runtime_session_id: session.runtime_session_id,
          run_id: runId,
          user_id: run.user_id,
          domain: run.domain,
          type: e.capability_type_required
            ? "blocked_sensitive_action_without_capability_release"
            : mapEventToInterventionType(e.event_type),
          sensitivity: e.sensitivity,
          event_type: e.event_type,
          page_url: e.page_url,
          element_hint: e.element_hint,
          reason: e.capability_type_required
            ? `Sensitive event (${e.sensitivity}) requires ${e.capability_type_required} capability release — none found for this run — run blocked.`
            : `Uncovered sensitive ${e.event_type} (${e.sensitivity}) outside Antigen-controlled window — run blocked.`,
          created_at: new Date().toISOString(),
          capability_type_required: e.capability_type_required,
          capability_release_present: e.capability_release_present,
        })
      );

      // Recompute summary now that interventions are registered.
      session.coverage_summary = getCoverageSummary(session.runtime_session_id);

      const violationMsg =
        `VIOLATION_BLOCKED: ${interventions.length} uncovered sensitive event(s) detected outside Antigen-controlled windows.`;
      const violationNow = new Date().toISOString();

      run.status = "failed";
      run.completed_at = violationNow;
      run.error = violationMsg;
      routeRuns.set(runId, run);
      schedulePersist();

      const violationReceipt = buildReceipt(run, "failed", violationMsg, "aegis_playwright");
      violationReceipt.runtime_coverage_summary = session.coverage_summary;
      violationReceipt.runtime_interventions = interventions;
      const violationCapReleases = getRuntimeCapabilityReleasesForRun(run.run_id);
      violationReceipt.runtime_capability_releases = violationCapReleases;
      violationReceipt.capability_release_summary = buildCapabilityReleaseSummary(violationCapReleases);
      violationReceipt.observation_mode_summary = session.observation_mode ?? initialObservationModeState();
      if (run.authorization_id) {
        const auth = actionAuthorizations.get(run.authorization_id);
        violationReceipt.authorization_context = {
          authorization_id: run.authorization_id,
          authorization_hash: run.authorization_hash!,
          passport_id: auth?.passport_id,
          passport_hash: auth?.passport_hash,
        };
      }
      await getReceiptRepository().createReceipt(violationReceipt);
      // Authorization stays "active" — violation blocked successful completion.

      session.status = "failed";
      session.error = violationMsg;
      session.updated_at = violationNow;
      runtimeSessions.set(session.runtime_session_id, session);

      return session;  // finally block closes browser
    }
    // ── End violation check ───────────────────────────────────────────────────

    session.coverage_summary = getCoverageSummary(session.runtime_session_id);

    const now = new Date().toISOString();
    run.status = "completed";
    run.completed_at = now;
    routeRuns.set(runId, run);
    schedulePersist();

    const receipt = buildReceipt(run, "completed", undefined, "aegis_playwright");
    receipt.runtime_coverage_summary = session.coverage_summary;
    const successCapReleases = getRuntimeCapabilityReleasesForRun(run.run_id);
    receipt.runtime_capability_releases = successCapReleases;
    receipt.capability_release_summary = buildCapabilityReleaseSummary(successCapReleases);
    receipt.observation_mode_summary = session.observation_mode ?? initialObservationModeState();
    if (run.authorization_id) {
      const auth = actionAuthorizations.get(run.authorization_id);
      receipt.authorization_context = {
        authorization_id: run.authorization_id,
        authorization_hash: run.authorization_hash!,
        passport_id: auth?.passport_id,
        passport_hash: auth?.passport_hash,
      };
    }
    await getReceiptRepository().createReceipt(receipt);

    // Mark the authorization fulfilled after the receipt is committed.
    if (run.authorization_id) {
      const auth = actionAuthorizations.get(run.authorization_id);
      if (auth) {
        const fulfilledAuth = {
          ...auth,
          status: "fulfilled" as const,
          fulfillment: {
            execution_receipt_id: receipt.receipt_id,
            fulfilled_at: now,
          },
        };
        actionAuthorizations.set(run.authorization_id, fulfilledAuth);
        schedulePersist();
      }
    }

    session.status = "completed";
    session.completed_at = now;
    session.updated_at = now;
    runtimeSessions.set(session.runtime_session_id, session);

  } catch (err: any) {
    const errorMsg = err?.message ?? "Unknown Playwright runtime error.";
    console.error("[playwright-runtime] Execution failed for run", runId, "—", errorMsg);

    const now = new Date().toISOString();
    run.status = "failed";
    run.completed_at = now;
    run.error = errorMsg;
    routeRuns.set(runId, run);
    schedulePersist();

    // Attempt to collect any partial events even on failure
    try {
      const rawEvents = await collectRawPageEvents(page);
      if (rawEvents.length > 0) {
        const events = convertPageEvents(rawEvents, coverageWindows, {
          runtime_session_id: session.runtime_session_id,
          run_id: runId,
          user_id: run.user_id,
          domain: run.domain,
        }, actionType);
        for (const ev of events) runtimeEvents.set(ev.event_id, ev);
        session.runtime_events = events;
        session.coverage_summary = getCoverageSummary(session.runtime_session_id);
      }
    } catch {
      // ignore collection errors during failure handling
    }

    try {
      const receipt = buildReceipt(run, "failed", errorMsg, "aegis_playwright");
      if (session.coverage_summary) {
        receipt.runtime_coverage_summary = session.coverage_summary;
      }
      const catchCapReleases = getRuntimeCapabilityReleasesForRun(run.run_id);
      if (catchCapReleases.length > 0) {
        receipt.runtime_capability_releases = catchCapReleases;
        receipt.capability_release_summary = buildCapabilityReleaseSummary(catchCapReleases);
      }
      receipt.observation_mode_summary = session.observation_mode ?? initialObservationModeState();
      if (run.authorization_id) {
        const auth = actionAuthorizations.get(run.authorization_id);
        receipt.authorization_context = {
          authorization_id: run.authorization_id,
          authorization_hash: run.authorization_hash!,
          passport_id: auth?.passport_id,
          passport_hash: auth?.passport_hash,
        };
      }
      await getReceiptRepository().createReceipt(receipt);
      // Authorization stays "active" on failure — the action did not complete.
    } catch (receiptErr) {
      console.error("[playwright-runtime] Failed to create failure receipt:", receiptErr);
    }

    session.status = "failed";
    session.error = errorMsg;
    session.updated_at = now;
    runtimeSessions.set(session.runtime_session_id, session);

  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return session;
}
