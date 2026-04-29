import type {
  ActionRequest,
  ActionDecision,
  ActionDecisionResponse,
  ActionRiskCategory,
  ActionType,
  AegisRoute,
  Collar,
  ProtectedSession,
  RouteLocator,
  RouteStep,
} from "@aegis/types";
import { evaluateAction } from "../policies/evaluate.js";

// ─── Locator Matching ─────────────────────────────────────────────────────────

// Returns the first candidate that matches the requested locator (exact, case-insensitive).
function matchLocator(
  requested: RouteLocator,
  candidates: RouteLocator[]
): RouteLocator | null {
  for (const c of candidates) {
    if (c.type !== requested.type) continue;
    switch (c.type) {
      case "role":
        if (
          norm(c.role) === norm(requested.role) &&
          norm(c.name) === norm(requested.name)
        ) return c;
        break;
      case "label":
        if (norm(c.name) === norm(requested.name)) return c;
        break;
      case "placeholder":
      case "testid":
      case "css":
      case "xpath":
        if (norm(c.value) === norm(requested.value)) return c;
        break;
      case "coordinates":
        if (c.x === requested.x && c.y === requested.y) return c;
        break;
    }
  }
  return null;
}

function norm(s: string | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

// ─── Risk Classification ──────────────────────────────────────────────────────

const MONEY_MOVEMENT = /transfer|send\s*money|wire|money\s*movement/i;
const PURCHASE = /purchase|buy|checkout|submit\s*order|pay\s*now/i;
const DELETE_DATA = /delete|remove\s*account|close\s*account/i;
const ACCOUNT_SETTING =
  /password|settings|profile|account\s*setting|change\s*pin|external\s*account|connect\s*account|add\s*external|add\s*payment/i;
const EXTERNAL_MESSAGE = /\bemail\b|send\s*message|invite|direct\s*message/i;

function classifyStepRiskCategory(step: RouteStep): ActionRiskCategory {
  const loc = step.target.preferred_locator;
  const text = [
    step.intent,
    step.description,
    loc.name,
    loc.value,
    loc.role,
  ]
    .filter(Boolean)
    .join(" ");

  if (MONEY_MOVEMENT.test(text)) return "money_movement";
  if (PURCHASE.test(text)) return "purchase";
  if (DELETE_DATA.test(text)) return "delete_data";
  if (ACCOUNT_SETTING.test(text)) return "account_setting_change";
  if (EXTERNAL_MESSAGE.test(text)) return "external_message";

  switch (step.action) {
    case "download": return "download_file";
    case "submit":   return "submit_form";
    case "fill":
    case "select":   return "fill_form";
    case "read":
    case "verify":
    case "wait":     return "read";
    default:         return "browse";
  }
}

function riskCategoryToCollarActionType(category: ActionRiskCategory): ActionType {
  switch (category) {
    case "money_movement":         return "payment";
    case "purchase":               return "purchase";
    case "delete_data":            return "delete_account";
    case "account_setting_change": return "account_setting_change";
    case "external_message":       return "send_email";
    case "submit_form":            return "submit_form";
    case "download_file":          return "download_file";
    case "fill_form":              return "browse";
    case "read":                   return "read";
    case "browse":
    default:                       return "browse";
  }
}

// ─── Main Decision Function ───────────────────────────────────────────────────

export type ActionPolicyResult =
  | { ok: true; data: ActionDecisionResponse }
  | { ok: false; status: number; code: string; message: string };

export function evaluateActionRequest(
  body: ActionRequest,
  sessionStore: Map<string, ProtectedSession>,
  collarStore: Map<string, Collar>,
  routeStore: Map<string, AegisRoute>
): ActionPolicyResult {
  const { session_id, route_id, requested_action, allow_draft_route } = body;
  const { type: requestedType, step_id, target_locator } = requested_action;

  // 1. Session validation
  const session = sessionStore.get(session_id);
  if (!session) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Session not found." };
  }

  // 2. Route validation
  const route = routeStore.get(route_id);
  if (!route) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Route not found." };
  }

  // 3. Step validation
  const step = route.steps.find((s) => s.step_id === step_id);
  if (!step) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: `Step '${step_id}' not found in route '${route_id}'.` };
  }

  // Helper to build a resolved response
  function decide(
    decision: ActionDecision,
    reason: string,
    matchedLocator: RouteLocator | null,
    riskCategory: ActionRiskCategory,
    approvalContext?: string
  ): ActionPolicyResult {
    return {
      ok: true,
      data: {
        decision,
        reason,
        route_id,
        step_id,
        session_id,
        risk_category: riskCategory,
        matched_locator: matchedLocator,
        approval_context: approvalContext,
        // TODO: wire to ReceiptService when the audit layer is built
        audit_event_id: null,
      },
    };
  }

  const riskCategory = classifyStepRiskCategory(step);

  // 4. Action type must match route step
  if (requestedType !== step.action) {
    return decide(
      "block",
      `Requested action type '${requestedType}' does not match route step action '${step.action}'.`,
      null,
      riskCategory
    );
  }

  // 5. Locator must match step target
  const allLocators = [step.target.preferred_locator, ...step.target.fallback_locators];
  const matched = matchLocator(target_locator, allLocators);
  if (!matched) {
    return decide(
      "pause",
      "Requested locator does not match any locator in the route step target. Aegis pauses — verify the target before proceeding.",
      null,
      riskCategory
    );
  }

  // 6. Trust tier check — unverified_draft routes require explicit demo override
  if (route.trust_tier === "unverified_draft" && !allow_draft_route) {
    return decide(
      "pause",
      "Route has not been verified (trust_tier: unverified_draft). Set allow_draft_route: true for local demo testing only.",
      matched,
      riskCategory
    );
  }

  // 7. Step-level approval gate
  if (step.approval_required) {
    return decide(
      "approval_required",
      "Route step requires human approval before execution.",
      matched,
      riskCategory
    );
  }

  // 8. Route approval gates (step_id present in route.approval_gates)
  const gate = route.approval_gates.find((g) => g.step_id === step_id);
  if (gate) {
    return decide(
      "approval_required",
      `Route approval gate: ${gate.reason}`,
      matched,
      riskCategory,
      gate.approval_context
    );
  }

  // 9. Route forbidden_actions check — collar always wins, but route-level block is faster
  const collarActionType = riskCategoryToCollarActionType(riskCategory);
  if (route.forbidden_actions.includes(collarActionType)) {
    return decide(
      "block",
      `Action category '${collarActionType}' is listed in this route's forbidden_actions.`,
      matched,
      riskCategory
    );
  }

  // 10. Collar enforcement — collar always overrides route permissions
  const collar = collarStore.get(session.collar_id);
  if (!collar) {
    return decide(
      "block",
      "No collar found for this session. Cannot authorize action.",
      matched,
      riskCategory
    );
  }

  const collarResult = evaluateAction({
    collar,
    session,
    action_type: collarActionType,
  });

  switch (collarResult.decision) {
    case "block":
      return decide("block", collarResult.reason, matched, riskCategory);
    case "pause_session":
    case "revoke_session":
      return decide("pause", collarResult.reason, matched, riskCategory);
    case "approval_required":
    case "runner_required":
      return decide("approval_required", collarResult.reason, matched, riskCategory);
    case "allow":
    case "allow_and_log":
      // All checks passed
      return decide("allow", "Action matches verified route step and is within Collar permissions.", matched, riskCategory);
    default:
      return decide("approval_required", `Unrecognized collar decision: ${collarResult.decision}. Defaulting to approval_required.`, matched, riskCategory);
  }
}
