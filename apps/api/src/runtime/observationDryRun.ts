import { chromium } from "playwright";
import type { DelegationTrustTaskCategory, ObservationDryRunResult } from "@aegis/types";
import {
  createRuntimeSession,
  activateProtectedObservationMode,
  getObservationModeState,
  initialObservationModeState,
} from "./aegisRuntime.js";
import {
  isSensitiveTaskCategory,
  urlLooksSensitive,
  scanPageForSensitivitySignals,
  buildAgentSafeObservationSnapshot,
  buildMinimalOpenObservation,
} from "./agentSafeObservation.js";
import { newId } from "../store/index.js";

function validateUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw Object.assign(new Error("Invalid URL."), { code: "INVALID_URL" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw Object.assign(
      new Error(`URL protocol "${parsed.protocol}" is not allowed. Only http and https are permitted.`),
      { code: "INVALID_URL" }
    );
  }
  return parsed;
}

const SAFETY_RULES_ENFORCED = {
  no_clicks: true,
  no_typing: true,
  no_form_submit: true,
  no_credential_fill: true,
  no_payment_release: true,
  no_kms_decrypt: true,
  no_route_execution: true,
  no_screenshot: true,
  no_full_dom_dump: true,
} as const;

export async function runObservationDryRun(args: {
  requested_url: string;
  task_category?: DelegationTrustTaskCategory;
  user_id: string;
}): Promise<ObservationDryRunResult> {
  const { requested_url, task_category, user_id } = args;

  const parsedUrl = validateUrl(requested_url);
  const domain = parsedUrl.hostname;
  const dry_run_id = newId("obsdry");
  const created_at = new Date().toISOString();

  const session = createRuntimeSession({
    user_id,
    domain,
    start_url: requested_url,
  });
  const sessionId = session.runtime_session_id;

  // Pre-navigation: escalate to protected if task intent is sensitive.
  if (isSensitiveTaskCategory(task_category)) {
    activateProtectedObservationMode(
      sessionId,
      "required_permission_sensitive",
      `task_category:${task_category}`
    );
  }

  // Pre-navigation: escalate to protected if URL looks sensitive.
  const urlSignal = urlLooksSensitive(requested_url);
  if (urlSignal) {
    activateProtectedObservationMode(sessionId, urlSignal.reason, urlSignal.signal);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    const navStart = Date.now();
    let final_url: string | undefined;
    try {
      await page.goto(requested_url, { waitUntil: "domcontentloaded", timeout: 15000 });
      final_url = page.url();
    } catch (navErr: unknown) {
      const msg = navErr instanceof Error ? navErr.message : "Navigation failed.";
      const completed_at = new Date().toISOString();
      return {
        dry_run_id,
        status: "failed",
        requested_url,
        domain,
        ...(task_category ? { task_category } : {}),
        created_at,
        completed_at,
        recommendation: "blocked_by_navigation_error",
        observation_mode: getObservationModeState(sessionId) ?? initialObservationModeState(),
        sensitive_surfaces: [],
        summary: {
          total_elements: 0,
          sensitive_elements: 0,
          redacted_values: 0,
          required_capabilities: [],
        },
        safety_rules_enforced: SAFETY_RULES_ENFORCED,
        error: { code: "NAVIGATION_ERROR", message: msg },
      };
    }

    const navigation_ms = Date.now() - navStart;

    // Post-navigation: scan DOM for additional sensitivity signals.
    const domSignals = await scanPageForSensitivitySignals(page);
    for (const { signal, reason } of domSignals) {
      activateProtectedObservationMode(sessionId, reason, signal);
    }

    const modeState = getObservationModeState(sessionId) ?? initialObservationModeState();
    const completed_at = new Date().toISOString();

    if (modeState.mode === "open_observation") {
      const open_summary = await buildMinimalOpenObservation(page);
      const recommendation =
        task_category && isSensitiveTaskCategory(task_category)
          ? "do_not_execute_without_aegis_route"
          : "safe_to_observe";

      return {
        dry_run_id,
        status: "completed",
        requested_url,
        final_url,
        domain,
        ...(task_category ? { task_category } : {}),
        created_at,
        completed_at,
        recommendation,
        observation_mode: modeState,
        open_summary,
        sensitive_surfaces: [],
        summary: {
          total_elements: 0,
          sensitive_elements: 0,
          redacted_values: 0,
          required_capabilities: [],
          navigation_ms,
        },
        safety_rules_enforced: SAFETY_RULES_ENFORCED,
      };
    }

    // Protected observation — build redacted snapshot.
    const snapshot = await buildAgentSafeObservationSnapshot(
      page,
      sessionId,
      undefined,
      user_id,
      domain
    );

    const sensitive_surfaces = snapshot.elements
      .filter((e) => e.sensitive)
      .map((e) => ({
        kind: e.kind,
        ...(e.label ? { label: e.label } : {}),
        ...(e.text ? { text: e.text } : {}),
        ...(e.input_type ? { input_type: e.input_type } : {}),
        ...(e.sensitivity ? { sensitivity: e.sensitivity } : {}),
        ...(e.required_capability ? { required_capability: e.required_capability } : {}),
        reason: e.reason ?? "Sensitive element detected on page.",
      }));

    const recommendation =
      sensitive_surfaces.length > 0
        ? "sensitive_surface_detected"
        : "do_not_execute_without_aegis_route";

    return {
      dry_run_id,
      status: "completed",
      requested_url,
      final_url,
      domain,
      ...(task_category ? { task_category } : {}),
      created_at,
      completed_at,
      recommendation,
      observation_mode: modeState,
      snapshot,
      sensitive_surfaces,
      summary: {
        total_elements: snapshot.summary.total_elements,
        sensitive_elements: snapshot.summary.sensitive_elements,
        redacted_values: snapshot.summary.redacted_values,
        required_capabilities: snapshot.summary.required_capabilities,
        navigation_ms,
      },
      safety_rules_enforced: SAFETY_RULES_ENFORCED,
    };
  } finally {
    await browser.close();
  }
}
