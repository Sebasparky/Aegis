import { chromium, type Page, type Locator } from "playwright";
import type { RouteLocator } from "@aegis/types";
import { routeRuns, routes, actionAuthorizations } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { getReceiptRepository } from "../repositories/receiptRepository.js";
import { resolveRouteStepValue } from "../lib/secretResolution.js";
import { buildReceipt } from "../routes/route-runs.js";
import {
  createRuntimeSession,
  runtimeSessions,
  runtimeEvents,
  getCoverageSummary,
  type RuntimeEvent,
  type RuntimeEventType,
  type RuntimeEventSensitivity,
  type RuntimeCoverageStatus,
  type RuntimeSession,
} from "./aegisRuntime.js";
import { newId } from "../store/index.js";

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

interface CoverageWindow {
  sensitivity: RuntimeEventSensitivity;
  eventTypes: Set<RuntimeEventType>;
  openMs: number;
  closeMs: number;
  reason: string;
}

function openCoverageWindow(
  windows: CoverageWindow[],
  sensitivity: RuntimeEventSensitivity,
  eventTypes: RuntimeEventType[],
  durationMs: number,
  reason: string
): void {
  const now = Date.now();
  windows.push({
    sensitivity,
    eventTypes: new Set(eventTypes),
    openMs: now,
    closeMs: now + durationMs,
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

function convertPageEvents(
  rawEvents: RawPageEvent[],
  coverageWindows: CoverageWindow[],
  meta: { runtime_session_id: string; run_id?: string; user_id: string; domain: string }
): RuntimeEvent[] {
  const now = new Date().toISOString();
  return rawEvents.map((raw) => {
    const eventType = raw.event_type as RuntimeEventType;
    const sensitivity = raw.sensitivity as RuntimeEventSensitivity;
    const timestampMs = raw.timestamp ? Date.parse(raw.timestamp) : Date.now();
    const matched = matchesCoverageWindow(coverageWindows, eventType, sensitivity, timestampMs);

    let coverage_status: RuntimeCoverageStatus;
    let reason: string;

    if (matched) {
      coverage_status = "covered_by_aegis";
      reason = matched.reason;
    } else {
      // High/critical uncovered events are flagged explicitly
      const severity = computeSeverity(sensitivity, eventType);
      if (severity === "high" || severity === "critical") {
        coverage_status = "not_covered_by_aegis";
        reason = `Sensitive event (${sensitivity}) detected outside an Aegis-controlled action window.`;
      } else {
        coverage_status = "unknown";
        reason = `Sensitive event detected; coverage could not be determined.`;
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
    };
  });
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

  const coverageWindows: CoverageWindow[] = [];
  const COVERAGE_DURATION_MS = 2500;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.addInitScript(INSTRUMENTATION_SCRIPT);
    await page.goto(route.start_url, { waitUntil: "domcontentloaded" });

    for (const step of route.steps) {
      if (step.action === "fill" && step.value_policy) {
        const vp = step.value_policy;

        // Open coverage window before filling — events during fill are Aegis-controlled
        const fillSensitivity: RuntimeEventSensitivity =
          vp.type === "secret_ref" ? "credential" : "credential";
        openCoverageWindow(
          coverageWindows,
          fillSensitivity,
          ["sensitive_field_focus", "sensitive_field_input"],
          COVERAGE_DURATION_MS,
          `Aegis Playwright runtime filling ${vp.type === "secret_ref" ? "secret credential" : "pass field"} via KMS vault — secret resolved server-side, never exposed to agent.`
        );

        const resolved = await resolveRouteStepValue(run, step);
        const locator = await tryLocator(page, step.target);
        await locator.fill(resolved.value);

        run.credential_used = true;
        run.secret_values_revealed_to_agent = false;
        run.pass_ids_used = Array.from(new Set([...(run.pass_ids_used ?? []), resolved.pass_id]));
        routeRuns.set(runId, run);
        schedulePersist();

      } else if (step.action === "click") {
        // Open coverage window before click — sensitive button click is Aegis-controlled
        openCoverageWindow(
          coverageWindows,
          "credential",
          ["sensitive_button_click", "sensitive_form_submit"],
          COVERAGE_DURATION_MS,
          "Button click / form submit executed by Aegis Playwright runtime under route control."
        );

        const locator = await tryLocator(page, step.target);
        await locator.click();
      }
    }

    // Wait for success navigation
    await page.waitForURL(/demo-login\/success|demo-login\//, { timeout: 10000 }).catch(() => {});

    // Collect page events and convert with coverage classification
    const rawEvents = await collectRawPageEvents(page);
    const events = convertPageEvents(rawEvents, coverageWindows, {
      runtime_session_id: session.runtime_session_id,
      run_id: runId,
      user_id: run.user_id,
      domain: run.domain,
    });

    // Store in Map and on session
    for (const ev of events) {
      runtimeEvents.set(ev.event_id, ev);
    }
    session.runtime_events = events;
    session.coverage_summary = getCoverageSummary(session.runtime_session_id);

    const now = new Date().toISOString();
    run.status = "completed";
    run.completed_at = now;
    routeRuns.set(runId, run);
    schedulePersist();

    const receipt = buildReceipt(run, "completed", undefined, "aegis_playwright");
    receipt.runtime_coverage_summary = session.coverage_summary;
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
        });
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
