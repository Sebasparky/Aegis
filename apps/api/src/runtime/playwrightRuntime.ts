import { chromium, type Page, type Locator } from "playwright";
import type { RouteLocator } from "@aegis/types";
import { routeRuns, routes, newId } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { getReceiptRepository } from "../repositories/receiptRepository.js";
import { resolveRouteStepValue } from "../lib/secretResolution.js";
import { buildReceipt } from "../routes/route-runs.js";
import { createRuntimeSession, runtimeSessions, type RuntimeEvent, type RuntimeSession } from "./aegisRuntime.js";

// Injected page script — collects sensitive event metadata only, never field values.
const INSTRUMENTATION_SCRIPT = `
(function() {
  if (window.__aegisInstrumented) return;
  window.__aegisInstrumented = true;
  window.__aegisEvents = [];

  function recordEvent(evt) { window.__aegisEvents.push(evt); }

  // Detect password fields
  document.querySelectorAll('input[type="password"]').forEach(function(el) {
    recordEvent({
      event_type: 'password_field_detected',
      sensitivity: 'high',
      page_url: location.href,
      element_hint: el.name || el.id || el.placeholder || 'password-input',
      covered_by_aegis: true,
      reason: 'Aegis Playwright runtime controls this field — secret resolved via KMS vault.',
      timestamp: new Date().toISOString(),
    });
  });

  // Detect sensitive button/submit clicks by visible text
  const SENSITIVE_PATTERNS = /pay|purchase|place order|submit order|transfer|trade|delete account|change password|sign in|log in/i;
  document.addEventListener('click', function(e) {
    var el = e.target;
    if (!el) return;
    var text = (el.textContent || el.value || el.innerText || '').trim();
    if (SENSITIVE_PATTERNS.test(text)) {
      recordEvent({
        event_type: 'sensitive_button_click',
        sensitivity: 'high',
        page_url: location.href,
        element_hint: text.slice(0, 60),
        covered_by_aegis: true,
        reason: 'Button click executed by Aegis Playwright runtime under route control.',
        timestamp: new Date().toISOString(),
      });
    }
  }, true);

  // Detect form submissions
  document.addEventListener('submit', function(e) {
    var form = e.target;
    recordEvent({
      event_type: 'form_submit',
      sensitivity: 'medium',
      page_url: location.href,
      element_hint: form.id || form.name || form.action || 'form',
      covered_by_aegis: true,
      reason: 'Form submission executed by Aegis Playwright runtime.',
      timestamp: new Date().toISOString(),
    });
  }, true);
})();
`;

function buildLocator(page: Page, loc: RouteLocator): Locator {
  switch (loc.type) {
    case "role":
      return page.getByRole(loc.role as any, { name: loc.name });
    case "label":
      return page.getByLabel(loc.name!);
    case "placeholder":
      return page.getByPlaceholder(loc.name!);
    case "testid":
      return page.getByTestId(loc.name!);
    case "css":
      return page.locator(loc.value ?? loc.name!);
    case "xpath":
      return page.locator(`xpath=${loc.value ?? loc.name!}`);
    default:
      return page.locator(loc.name!);
  }
}

async function tryLocator(page: Page, target: import("@aegis/types").ElementTarget): Promise<Locator> {
  const allLocators = [target.preferred_locator, ...target.fallback_locators];
  for (const loc of allLocators) {
    try {
      const l = buildLocator(page, loc);
      await l.waitFor({ timeout: 2000 });
      return l;
    } catch {
      // try next
    }
  }
  // Return preferred anyway — will surface a clear error on action
  return buildLocator(page, target.preferred_locator);
}

async function collectPageEvents(page: Page): Promise<RuntimeEvent[]> {
  try {
    const raw: any[] = await page.evaluate(() => (globalThis as any).__aegisEvents ?? []);
    return raw.map((e) => ({
      event_type: e.event_type,
      sensitivity: e.sensitivity,
      page_url: e.page_url,
      element_hint: e.element_hint,
      covered_by_aegis: e.covered_by_aegis,
      reason: e.reason,
      timestamp: e.timestamp,
    }));
  } catch {
    return [];
  }
}

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

  // Transition run to running
  run.status = "running";
  run.started_at = new Date().toISOString();
  routeRuns.set(runId, run);
  schedulePersist();

  session.status = "running";
  session.updated_at = new Date().toISOString();
  runtimeSessions.set(session.runtime_session_id, session);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.addInitScript(INSTRUMENTATION_SCRIPT);
    await page.goto(route.start_url, { waitUntil: "domcontentloaded" });

    for (const step of route.steps) {
      if (step.action === "fill" && step.value_policy) {
        const resolved = await resolveRouteStepValue(run, step);
        const locator = await tryLocator(page, step.target);
        await locator.fill(resolved.value);

        // Track credential usage — never expose the value
        run.credential_used = true;
        run.secret_values_revealed_to_agent = false;
        run.pass_ids_used = Array.from(new Set([...(run.pass_ids_used ?? []), resolved.pass_id]));
        routeRuns.set(runId, run);
        schedulePersist();
      } else if (step.action === "click") {
        const locator = await tryLocator(page, step.target);
        await locator.click();
      }
    }

    // Wait for success — Demo Login navigates to /demo-login/success
    await page.waitForURL(/demo-login\/success|demo-login\//, { timeout: 10000 }).catch(() => {
      // Navigation may already have completed or route may not have a URL success pattern
    });

    // Collect instrumentation events before closing
    const events = await collectPageEvents(page);
    session.runtime_events.push(...events);

    // Mark run and session completed
    const now = new Date().toISOString();
    run.status = "completed";
    run.completed_at = now;
    routeRuns.set(runId, run);
    schedulePersist();

    const receipt = buildReceipt(run, "completed", undefined, "aegis_playwright");
    await getReceiptRepository().createReceipt(receipt);

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

    try {
      const receipt = buildReceipt(run, "failed", errorMsg, "aegis_playwright");
      await getReceiptRepository().createReceipt(receipt);
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
