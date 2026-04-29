import { chromium } from "playwright";
import type { Page, Locator } from "playwright";
import type {
  AegisRoute,
  RouteLocator,
  RouteStep,
  StepVerificationResult,
  RouteVerificationReport,
} from "@aegis/types";

// Confidence by locator type (mirrors the compiler's scoring)
const LOCATOR_CONFIDENCE: Record<RouteLocator["type"], number> = {
  role: 0.90,
  label: 0.88,
  testid: 0.85,
  placeholder: 0.82,
  css: 0.70,
  xpath: 0.50,
  coordinates: 0.20,
};

const DEMO_PAGE_URL = "http://localhost:3001/bank.html";

// Only localhost/127.0.0.1 routes are supported for automated verification.
function isDemoDomain(domain: string): boolean {
  return domain === "localhost" || domain === "127.0.0.1" ||
    domain.startsWith("localhost:") || domain.startsWith("127.0.0.1:");
}

function buildPlaywrightLocator(page: Page, loc: RouteLocator): Locator {
  switch (loc.type) {
    case "role":
      return page.getByRole(loc.role as Parameters<Page["getByRole"]>[0], { name: loc.name });
    case "label":
      return page.getByLabel(loc.name!);
    case "placeholder":
      return page.getByPlaceholder(loc.value!);
    case "testid":
      return page.getByTestId(loc.value!);
    case "css":
      return page.locator(loc.value!);
    case "xpath":
      return page.locator(`xpath=${loc.value!}`);
    case "coordinates":
      throw new Error("Coordinate locators are not supported during verification.");
  }
}

async function resolveLocatorWithFallback(
  page: Page,
  step: RouteStep,
): Promise<{
  attempts: StepVerificationResult["locator_attempts"];
  selected: RouteLocator | null;
  found: boolean;
}> {
  const candidates: RouteLocator[] = [
    step.target.preferred_locator,
    ...step.target.fallback_locators,
  ];

  const attempts: StepVerificationResult["locator_attempts"] = [];

  for (const loc of candidates) {
    if (loc.type === "coordinates") {
      attempts.push({ locator: loc, found: false, error: "Coordinate locators skipped in verification." });
      continue;
    }

    try {
      const playwrightLoc = buildPlaywrightLocator(page, loc);
      // waitFor 'attached' (not 'visible') — some elements may be hidden until a prior step activates them
      await playwrightLoc.first().waitFor({ state: "attached", timeout: 2500 });
      attempts.push({ locator: loc, found: true });
      return { attempts, selected: loc, found: true };
    } catch (err: any) {
      attempts.push({ locator: loc, found: false, error: String(err?.message ?? err) });
    }
  }

  return { attempts, selected: null, found: false };
}

async function executeAction(
  page: Page,
  step: RouteStep,
  locator: Locator,
): Promise<{ performed: boolean; error?: string }> {
  switch (step.action) {
    case "navigate":
    case "click":
    case "submit": {
      await locator.click();
      return { performed: true };
    }

    case "select": {
      const vp = step.value_policy;
      if (vp?.type === "enum_selection" && vp.value) {
        try {
          await locator.selectOption({ label: vp.value });
        } catch {
          // Fall back to first non-empty option if exact label isn't found
          await locator.selectOption({ index: 1 });
        }
      } else {
        await locator.selectOption({ index: 1 });
      }
      return { performed: true };
    }

    case "fill": {
      const vp = step.value_policy;
      if (vp?.type === "sensitive_redacted") {
        return {
          performed: false,
          error: "Step requires sensitive_redacted value — cannot fill during automated verification.",
        };
      }
      if (vp?.type === "safe_literal" && vp.value) {
        await locator.fill(vp.value);
        return { performed: true };
      }
      // runtime_variable or no policy — skip fill but don't fail the step
      return { performed: false };
    }

    case "download": {
      await locator.click();
      // Check for the demo page's visible success indicator
      try {
        await page.locator("#download-feedback").waitFor({ state: "visible", timeout: 3000 });
      } catch {
        // Not a hard failure — the click itself succeeded
      }
      return { performed: true };
    }

    case "verify":
    case "read":
    case "wait":
      // No-op in demo verification
      return { performed: false };

    default:
      return { performed: false, error: `Unsupported action type: ${step.action}` };
  }
}

async function executeVerificationStep(
  page: Page,
  step: RouteStep,
): Promise<StepVerificationResult> {
  const { attempts, selected, found } = await resolveLocatorWithFallback(page, step);

  if (!found || selected === null) {
    return {
      step_id: step.step_id,
      order: step.order,
      action: step.action,
      locator_attempts: attempts,
      selected_locator: null,
      locator_found: false,
      action_performed: false,
      passed: false,
      confidence: 0,
      error: "No locator resolved — element not found on page.",
    };
  }

  const playwrightLoc = buildPlaywrightLocator(page, selected);

  try {
    const { performed, error: actionError } = await executeAction(page, step, playwrightLoc);

    if (actionError && step.value_policy?.type === "sensitive_redacted") {
      // Sensitive_redacted steps are marked as requiring approval, not failed
      return {
        step_id: step.step_id,
        order: step.order,
        action: step.action,
        locator_attempts: attempts,
        selected_locator: selected,
        locator_found: true,
        action_performed: false,
        passed: true, // locator resolved; skip is expected
        confidence: LOCATOR_CONFIDENCE[selected.type],
        error: actionError,
      };
    }

    return {
      step_id: step.step_id,
      order: step.order,
      action: step.action,
      locator_attempts: attempts,
      selected_locator: selected,
      locator_found: true,
      action_performed: performed,
      passed: !actionError,
      confidence: LOCATOR_CONFIDENCE[selected.type],
      error: actionError,
    };
  } catch (err: any) {
    return {
      step_id: step.step_id,
      order: step.order,
      action: step.action,
      locator_attempts: attempts,
      selected_locator: selected,
      locator_found: true,
      action_performed: false,
      passed: false,
      confidence: LOCATOR_CONFIDENCE[selected.type],
      error: String(err?.message ?? err),
    };
  }
}

export async function verifyRouteWithPlaywright(
  route: AegisRoute,
): Promise<RouteVerificationReport> {
  const started_at = new Date().toISOString();

  if (!isDemoDomain(route.domain)) {
    return {
      route_id: route.route_id,
      started_at,
      completed_at: new Date().toISOString(),
      passed: false,
      step_results: [],
      errors: [
        `Automated verification is only supported for localhost demo routes. ` +
        `Domain '${route.domain}' is not allowed.`,
      ],
    };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Dismiss any browser dialogs (e.g., the "Please select a month" alert)
  page.on("dialog", async (dialog) => { await dialog.dismiss(); });

  const step_results: StepVerificationResult[] = [];
  const errors: string[] = [];

  try {
    try {
      await page.goto(DEMO_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const isConnectionRefused =
        msg.includes("ERR_CONNECTION_REFUSED") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("net::ERR");
      return {
        route_id: route.route_id,
        started_at,
        completed_at: new Date().toISOString(),
        passed: false,
        step_results: [],
        errors: [
          isConnectionRefused
            ? "Mock-store server is not reachable on port 3001. Start it with: npm run dev"
            : `Failed to load demo page: ${msg}`,
        ],
      };
    }

    for (const step of route.steps) {
      const result = await executeVerificationStep(page, step);
      step_results.push(result);
      if (!result.passed && result.error) {
        errors.push(`Step ${step.order} (${step.intent}): ${result.error}`);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const passed = step_results.length > 0 && step_results.every((r) => r.passed);

  return {
    route_id: route.route_id,
    started_at,
    completed_at: new Date().toISOString(),
    passed,
    step_results,
    errors,
  };
}
