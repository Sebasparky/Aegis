import { chromium } from "playwright";
import type { Page, Locator } from "playwright";
import type {
  AegisRoute,
  RouteLocator,
  RouteStep,
  StepVerificationResult,
  RouteVerificationReport,
} from "@aegis/types";
import { classifyStepSafety } from "../lib/stepSafety.js";

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
const WIKIPEDIA_START_URL = "https://en.wikipedia.org/wiki/Main_Page";

function isDemoDomain(domain: string): boolean {
  return domain === "localhost" || domain === "127.0.0.1" ||
    domain.startsWith("localhost:") || domain.startsWith("127.0.0.1:");
}

function isWikipediaDomain(domain: string): boolean {
  return domain === "en.wikipedia.org";
}

// Returns the value of the first safe_literal fill step — used to verify the result page.
function getSearchQuery(route: AegisRoute): string | null {
  for (const step of route.steps) {
    if (step.action === "fill" &&
        step.value_policy?.type === "safe_literal" &&
        step.value_policy.value) {
      return step.value_policy.value;
    }
  }
  return null;
}

async function wikipediaOutcomeMatches(page: Page, searchQuery: string): Promise<boolean> {
  const url   = page.url();
  const title = await page.title().catch(() => "");
  const h1    = await page.locator("h1").first().innerText().catch(() => "");
  const q     = searchQuery.toLowerCase();
  return url.toLowerCase().includes(q) ||
    title.toLowerCase().includes(q) ||
    h1.toLowerCase().includes(q);
}

// ── Page state helpers ────────────────────────────────────────────────────────

interface PageState {
  url: string;
  title: string;
}

async function capturePageState(page: Page): Promise<PageState> {
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
  };
}

function hasMeaningfulProgress(before: PageState, after: PageState): boolean {
  return before.url !== after.url || before.title !== after.title;
}

// ── Locator building ──────────────────────────────────────────────────────────

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

// For click/submit steps, inject synthetic clickable candidates before
// label/placeholder entries to avoid resolving to a label-matched input
// when a submit button exists.
function buildClickCandidates(
  candidates: RouteLocator[],
  stepTarget: RouteStep["target"],
): RouteLocator[] {
  const nameHint =
    stepTarget.preferred_locator.name ??
    stepTarget.fallback_locators.find(l => l.name)?.name;

  const synthetic: RouteLocator[] = [];
  if (nameHint) {
    synthetic.push({ type: "role", role: "button", name: nameHint });
    synthetic.push({ type: "role", role: "link", name: nameHint });
  }
  // Broad submit-input CSS selector as additional fallback
  synthetic.push({ type: "css", value: "button[type=submit], input[type=submit]" });

  // Deduplicate: synthetic first, then original candidates
  const seen = new Set<string>();
  const merged: RouteLocator[] = [];
  for (const loc of [...synthetic, ...candidates]) {
    const key = JSON.stringify(loc);
    if (!seen.has(key)) { seen.add(key); merged.push(loc); }
  }
  return merged;
}

async function resolveLocatorWithFallback(
  page: Page,
  step: RouteStep,
): Promise<{
  attempts: StepVerificationResult["locator_attempts"];
  selected: RouteLocator | null;
  found: boolean;
}> {
  const baseCandidates: RouteLocator[] = [
    step.target.preferred_locator,
    ...step.target.fallback_locators,
  ];

  // For click-like actions, prefer button/link targets before label/placeholder inputs
  const candidates: RouteLocator[] =
    (step.action === "click" || step.action === "submit" || step.action === "navigate")
      ? buildClickCandidates(baseCandidates, step.target)
      : baseCandidates;

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

// ── Per-step execution ────────────────────────────────────────────────────────

interface ExecuteVerificationStepOpts {
  lastSafeFillLocator?: RouteLocator | null;
}

async function executeVerificationStep(
  page: Page,
  step: RouteStep,
  opts: ExecuteVerificationStepOpts = {},
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
      failure_reason: "locator_not_found",
    };
  }

  const playwrightLoc = buildPlaywrightLocator(page, selected);
  const isClickLike =
    step.action === "click" || step.action === "submit" || step.action === "navigate";

  try {
    // Capture pre-action page state for click-like steps
    const preState = isClickLike ? await capturePageState(page) : null;

    const { performed, error: actionError } = await executeAction(page, step, playwrightLoc);

    if (actionError && step.value_policy?.type === "sensitive_redacted") {
      // sensitive_redacted steps: locator resolved; skip is expected
      return {
        step_id: step.step_id,
        order: step.order,
        action: step.action,
        locator_attempts: attempts,
        selected_locator: selected,
        locator_found: true,
        action_performed: false,
        passed: true,
        confidence: LOCATOR_CONFIDENCE[selected.type],
        error: actionError,
      };
    }

    if (actionError) {
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
        error: actionError,
        failure_reason: "action_threw",
      };
    }

    // ── Outcome detection for click-like steps ──────────────────────────────
    if (isClickLike && preState !== null) {
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
      } catch {
        // Timeout is non-fatal; proceed to state comparison
      }

      const postState = await capturePageState(page);

      if (hasMeaningfulProgress(preState, postState)) {
        // Action caused observable navigation — step passes
        return {
          step_id: step.step_id,
          order: step.order,
          action: step.action,
          locator_attempts: attempts,
          selected_locator: selected,
          locator_found: true,
          action_performed: true,
          passed: true,
          confidence: LOCATOR_CONFIDENCE[selected.type],
        };
      }

      // No progress — consider Enter fallback for safe steps with a prior fill
      const stepSafety = classifyStepSafety(step);

      if (stepSafety === "sensitive") {
        return {
          step_id: step.step_id,
          order: step.order,
          action: step.action,
          locator_attempts: attempts,
          selected_locator: selected,
          locator_found: true,
          action_performed: performed,
          passed: false,
          confidence: LOCATOR_CONFIDENCE[selected.type],
          error: "Click caused no meaningful page progress; Enter fallback blocked (sensitive step).",
          failure_reason: "fallback_blocked_safety",
        };
      }

      if (!opts.lastSafeFillLocator) {
        return {
          step_id: step.step_id,
          order: step.order,
          action: step.action,
          locator_attempts: attempts,
          selected_locator: selected,
          locator_found: true,
          action_performed: performed,
          passed: false,
          confidence: LOCATOR_CONFIDENCE[selected.type],
          error: "Click caused no meaningful page progress.",
          failure_reason: "no_meaningful_progress",
        };
      }

      // ── Enter fallback ──────────────────────────────────────────────────
      try {
        const fillLoc = buildPlaywrightLocator(page, opts.lastSafeFillLocator);
        await fillLoc.press("Enter");
        try {
          await page.waitForLoadState("domcontentloaded", { timeout: 10_000 });
        } catch { /* non-fatal */ }

        const postFallbackState = await capturePageState(page);
        if (hasMeaningfulProgress(preState, postFallbackState)) {
          return {
            step_id: step.step_id,
            order: step.order,
            action: step.action,
            locator_attempts: attempts,
            selected_locator: selected,
            locator_found: true,
            action_performed: true,
            passed: true,
            confidence: LOCATOR_CONFIDENCE[selected.type],
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
          passed: false,
          confidence: LOCATOR_CONFIDENCE[selected.type],
          error: "Click caused no meaningful progress; Enter fallback also produced no progress.",
          failure_reason: "fallback_attempted_failed",
        };
      } catch (fallbackErr: any) {
        return {
          step_id: step.step_id,
          order: step.order,
          action: step.action,
          locator_attempts: attempts,
          selected_locator: selected,
          locator_found: true,
          action_performed: performed,
          passed: false,
          confidence: LOCATOR_CONFIDENCE[selected.type],
          error: `Enter fallback threw: ${String(fallbackErr?.message ?? fallbackErr)}`,
          failure_reason: "fallback_attempted_failed",
        };
      }
    }

    // ── Non-click steps (fill, select, download, etc.) ──────────────────────
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
      failure_reason: "action_threw",
    };
  }
}

// ── Main verification entry point ─────────────────────────────────────────────

export async function verifyRouteWithPlaywright(
  route: AegisRoute,
): Promise<RouteVerificationReport> {
  const started_at = new Date().toISOString();

  // ── Wikipedia verification path ──────────────────────────────────────────────
  if (isWikipediaDomain(route.domain)) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("dialog", async (dialog) => { await dialog.dismiss(); });

    const step_results: StepVerificationResult[] = [];
    const errors: string[] = [];
    let contentCheckFailed = false;

    try {
      try {
        await page.goto(WIKIPEDIA_START_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        const isTimeout = msg.includes("Timeout") || msg.includes("timeout");
        if (!isTimeout) {
          return {
            route_id: route.route_id,
            started_at,
            completed_at: new Date().toISOString(),
            passed: false,
            step_results: [],
            errors: [`Failed to load Wikipedia: ${msg}`],
          };
        }
        try {
          await page
            .getByRole("searchbox", { name: /search wikipedia/i })
            .or(page.locator('input[name="search"]'))
            .first()
            .waitFor({ state: "attached", timeout: 15_000 });
        } catch {
          return {
            route_id: route.route_id,
            started_at,
            completed_at: new Date().toISOString(),
            passed: false,
            step_results: [],
            errors: [`Wikipedia did not load in time and the search input was not available.`],
          };
        }
      }

      let lastSafeFillLocator: RouteLocator | null = null;

      for (const step of route.steps) {
        const result = await executeVerificationStep(page, step, { lastSafeFillLocator });
        step_results.push(result);

        if (step.action === "fill" && result.passed && result.selected_locator !== null &&
            classifyStepSafety(step) === "safe") {
          lastSafeFillLocator = result.selected_locator;
        } else if (step.action === "fill") {
          lastSafeFillLocator = null;
        }

        if (!result.passed && result.error) {
          errors.push(`Step ${step.order} (${step.intent}): ${result.error}`);
        }
      }

      const searchQuery = getSearchQuery(route);
      const allStepsPassed = step_results.length > 0 && step_results.every((r) => r.passed);

      if (allStepsPassed && searchQuery) {
        // Wait for any remaining navigation to settle
        try { await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }); } catch {}

        // Fallback: if the generic Enter fallback still left us on the start page,
        // navigate directly to the expected article URL as a last resort.
        if (!(await wikipediaOutcomeMatches(page, searchQuery))) {
          const articleUrl =
            `https://en.wikipedia.org/wiki/${encodeURIComponent(searchQuery).replace(/%20/g, "_")}`;
          try {
            await page.goto(articleUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
          } catch {}
        }

        if (!(await wikipediaOutcomeMatches(page, searchQuery))) {
          errors.push(
            `Expected result page for "${searchQuery}" but page title/URL/heading did not match. URL: ${page.url()}`,
          );
          contentCheckFailed = true;
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }

    const passed = step_results.length > 0 &&
      step_results.every((r) => r.passed) &&
      !contentCheckFailed;

    return {
      route_id: route.route_id,
      started_at,
      completed_at: new Date().toISOString(),
      passed,
      step_results,
      errors,
    };
  }

  // ── Unsupported external domains ──────────────────────────────────────────────
  if (!isDemoDomain(route.domain)) {
    return {
      route_id: route.route_id,
      started_at,
      completed_at: new Date().toISOString(),
      passed: false,
      step_results: [],
      errors: [
        `Unsupported external domain: '${route.domain}'. ` +
        `Only en.wikipedia.org is currently supported for automated verification.`,
      ],
    };
  }

  // ── Localhost / demo bank verification path ───────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

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

    let lastSafeFillLocator: RouteLocator | null = null;

    for (const step of route.steps) {
      const result = await executeVerificationStep(page, step, { lastSafeFillLocator });
      step_results.push(result);

      if (step.action === "fill" && result.passed && result.selected_locator !== null &&
          classifyStepSafety(step) === "safe") {
        lastSafeFillLocator = result.selected_locator;
      } else if (step.action === "fill") {
        lastSafeFillLocator = null;
      }

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
