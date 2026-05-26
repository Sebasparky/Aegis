import { randomUUID } from "crypto";
import type {
  AegisRoute,
  RouteStep,
  RouteLocator,
  RouteVariable,
  ElementTarget,
  ValuePolicy,
  ApprovalGate,
  ActionType,
  RiskLevel,
  RecordingPayload,
  SemanticRecordingEvent,
  StepActionType,
} from "@aegis/types";

// Patterns in label/placeholder/name that always produce sensitive_redacted
const SENSITIVE_LABEL_PATTERNS =
  /password|card\s*number|cvv|cvc|security\s*code|ssn|social\s*security|account\s*number|routing\s*number|pin\b/i;

// Autocomplete values that trigger sensitive_redacted
const SENSITIVE_AUTOCOMPLETE_PATTERNS = /^cc-number$|^cc-csc$|^cc-exp/i;

// Dangerous action keywords detected in visible_text or nearby_text of clicked elements
const DANGEROUS_ACTION_PATTERNS =
  /transfer|send\s*money|pay\s*now|make\s*payment|change\s*password|delete\s*account|add\s*external|connect\s*account|add\s*payment|submit\s*payment/i;

// Maps dangerous visible text to ActionType for forbidden_actions inference
const DANGEROUS_ACTION_MAP: Array<{ pattern: RegExp; action: ActionType }> = [
  { pattern: /transfer|send\s*money/i, action: "payment" },
  { pattern: /pay\s*now|make\s*payment|submit\s*payment/i, action: "purchase" },
  { pattern: /change\s*password/i, action: "account_setting_change" },
  { pattern: /delete\s*account/i, action: "delete_account" },
  { pattern: /add\s*external|connect\s*account/i, action: "connect_app" },
  { pattern: /add\s*payment/i, action: "payment" },
];

// Confidence by locator type (0–1)
const LOCATOR_CONFIDENCE: Record<RouteLocator["type"], number> = {
  role: 0.90,
  label: 0.88,
  testid: 0.85,
  placeholder: 0.82,
  css: 0.70,
  xpath: 0.50,
  coordinates: 0.20,
};

function newStepId(): string {
  return `step_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function newRouteId(): string {
  return `route_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// Rejects any locator value that contains executable code patterns
function containsExecutableCode(locator: RouteLocator): boolean {
  const v = locator.value ?? locator.name ?? "";
  return /javascript:|<script|eval\(|Function\(/i.test(v);
}

function classifyValuePolicy(event: SemanticRecordingEvent): ValuePolicy {
  const isSensitiveType =
    event.input_type === "password" ||
    (event.autocomplete && SENSITIVE_AUTOCOMPLETE_PATTERNS.test(event.autocomplete));

  const resolvedLabel = [
    event.label_text,
    event.aria_label,
    event.placeholder,
    event.input_name,
  ]
    .filter(Boolean)
    .join(" ");

  const isSensitiveLabel = SENSITIVE_LABEL_PATTERNS.test(resolvedLabel);

  if (isSensitiveType || isSensitiveLabel) {
    return { type: "sensitive_redacted", store_value: false };
  }

  if (event.input_type === "email") {
    return { type: "runtime_variable", name: "email_address", store_value: false };
  }

  if (event.type === "select") {
    return {
      type: "enum_selection",
      value: event.raw_value,
      store_value: true,
    };
  }

  if (event.raw_value) {
    return { type: "safe_literal", value: event.raw_value, store_value: true };
  }

  return { type: "runtime_variable", store_value: false };
}

// Builds the best preferred_locator from event metadata, then returns fallbacks from event.locators
function resolveLocators(event: SemanticRecordingEvent): {
  preferred: RouteLocator;
  fallbacks: RouteLocator[];
  confidence: number;
} {
  const candidates: RouteLocator[] = [];

  // Priority 1: aria-label as label locator
  if (event.aria_label) {
    candidates.push({ type: "label", name: event.aria_label });
  }

  // Priority 2: resolved label text as label locator
  if (event.label_text && event.label_text !== event.aria_label) {
    candidates.push({ type: "label", name: event.label_text });
  }

  // Priority 3: role + accessible name
  if (event.element_role && event.visible_text) {
    candidates.push({ type: "role", role: event.element_role, name: event.visible_text });
  }

  // Priority 4: placeholder
  if (event.placeholder) {
    candidates.push({ type: "placeholder", value: event.placeholder });
  }

  // Priority 5: css by name attribute
  if (event.input_name) {
    candidates.push({ type: "css", value: `[name="${event.input_name}"]` });
  }

  // Priority 6: css by id
  if (event.input_id && !/^\d/.test(event.input_id)) {
    candidates.push({ type: "css", value: `#${event.input_id}` });
  }

  // Append any locators from the event payload (deduplicated by type+value)
  const seen = new Set(candidates.map((l) => `${l.type}:${l.name ?? l.value ?? l.role}`));
  for (const loc of event.locators) {
    const key = `${loc.type}:${loc.name ?? loc.value ?? loc.role}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(loc);
    }
  }

  const preferred = candidates[0] ?? { type: "css", value: "unknown" };
  const confidence = LOCATOR_CONFIDENCE[preferred.type] ?? 0.5;

  return { preferred, fallbacks: candidates.slice(1), confidence };
}

function mapEventToAction(eventType: SemanticRecordingEvent["type"]): StepActionType {
  switch (eventType) {
    case "navigate": return "navigate";
    case "fill":     return "fill";
    case "select":   return "select";
    case "submit":   return "submit";
    case "download": return "download";
    default:         return "click";
  }
}

function buildIntent(event: SemanticRecordingEvent, order: number): string {
  const label = event.label_text ?? event.aria_label ?? event.visible_text ?? event.placeholder;
  if (label) {
    return label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40);
  }
  return `step_${order}_${event.type}`;
}

function deriveVariableName(event: SemanticRecordingEvent): string {
  const raw = event.label_text ?? event.aria_label ?? event.input_name ?? event.input_id ?? '';
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

function deriveVariableLabel(event: SemanticRecordingEvent): string {
  const raw = event.label_text ?? event.aria_label ?? event.input_name ?? event.input_id ?? '';
  return raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

export function compileRoute(payload: RecordingPayload): AegisRoute {
  const now = new Date().toISOString();
  const steps: RouteStep[] = [];
  const variables: RouteVariable[] = [];
  const approvalGates: ApprovalGate[] = [];
  const inferredAllowed = new Set<ActionType>(["browse"]);
  const inferredForbidden = new Set<ActionType>();

  for (const loc of payload.events.flatMap((e) => e.locators)) {
    if (containsExecutableCode(loc)) {
      throw new Error("UNSAFE_LOCATOR: route step contains executable code patterns");
    }
  }

  let stepOrder = 1;

  for (const event of payload.events) {
    const isDangerous =
      DANGEROUS_ACTION_PATTERNS.test(event.visible_text ?? "") ||
      DANGEROUS_ACTION_PATTERNS.test(event.nearby_text ?? "");

    // Dangerous clicks are recorded in forbidden_actions, not as route steps
    if (event.type === "click" && isDangerous) {
      for (const { pattern, action } of DANGEROUS_ACTION_MAP) {
        if (
          pattern.test(event.visible_text ?? "") ||
          pattern.test(event.nearby_text ?? "")
        ) {
          inferredForbidden.add(action);
        }
      }
      continue;
    }

    const { preferred, fallbacks, confidence } = resolveLocators(event);

    const target: ElementTarget = {
      preferred_locator: preferred,
      fallback_locators: fallbacks,
      confidence,
    };

    const action = mapEventToAction(event.type);
    const intent = buildIntent(event, stepOrder);

    let valuePolicy: ValuePolicy | undefined;
    if (event.type === "fill" || event.type === "select") {
      valuePolicy = classifyValuePolicy(event);
    }

    if (event.type === "download") {
      inferredAllowed.add("download_file");
    }

    const step: RouteStep = {
      step_id: newStepId(),
      order: stepOrder,
      action,
      intent,
      description: `${action} ${event.visible_text ?? event.label_text ?? intent}`,
      target,
      value_policy: valuePolicy,
      approval_required: false,
      confidence_required: 0.7,
    };

    steps.push(step);

    if (event.type === 'select' && step.value_policy?.type === 'enum_selection') {
      const varName = deriveVariableName(event);
      if (varName) {
        variables.push({
          name: varName,
          label: deriveVariableLabel(event),
          type: 'select',
          default_value: event.raw_value ?? '',
          allowed_values: event.options?.filter(Boolean),
          step_id: step.step_id,
        });
        step.variable_binding = varName;
      }
    }

    stepOrder++;
  }

  const forbiddenList = Array.from(inferredForbidden);
  const allowedList = Array.from(inferredAllowed);

  const riskLevel: RiskLevel =
    forbiddenList.some((a) => a === "payment" || a === "purchase" || a === "financial_data_disclosure")
      ? "high"
      : "low";

  const route: AegisRoute = {
    route_id: newRouteId(),
    version: "1.0.0",
    created_at: now,
    last_verified_at: now,
    creator_aegis_id: "aid_user_001",
    trust_tier: "unverified_draft",
    domain: payload.domain,
    workflow_name: payload.workflow_name,
    workflow_description: `Recorded workflow: ${payload.workflow_name}`,
    risk_level: riskLevel,
    required_permissions: allowedList,
    allowed_actions: allowedList,
    forbidden_actions: forbiddenList,
    approval_gates: approvalGates,
    confidence_threshold: 0.7,
    steps,
    variables: variables.length > 0 ? variables : undefined,
    run_count: 0,
    success_rate: 0,
    incident_count: 0,
  };

  // Extract start_url from the first recorded event's page URL.
  // Only set when the hostname matches the declared domain to prevent cross-domain leakage.
  // Preserved if already set by a caller; this is the only place start_url is written during compilation.
  const firstEventUrl = payload.events[0]?.url;
  if (firstEventUrl && !route.start_url) {
    try {
      if (new URL(firstEventUrl).hostname === payload.domain) {
        route.start_url = firstEventUrl;
      }
    } catch {
      // Malformed URL — skip
    }
  }

  return route;
}
