import type { RouteStep } from "@aegis/types";

export const SENSITIVE_CLICK_RE =
  /\b(submit|confirm|pay|purchase|checkout|sign[\s-]?in|log[\s-]?in|transfer|delete|remove|download|buy|order|proceed|authorize|approve)\b/i;

export function classifyStepSafety(step: RouteStep): "safe" | "sensitive" {
  if (step.approval_required) return "sensitive";

  if (step.action === "fill") {
    if (step.value_policy?.type === "safe_literal" && step.value_policy.value !== undefined) return "safe";
    return "sensitive";
  }

  if (step.action === "click") {
    const text = `${step.intent} ${step.description}`;
    if (SENSITIVE_CLICK_RE.test(text)) return "sensitive";
    return "safe";
  }

  if (step.action === "navigate" || step.action === "read") return "safe";

  return "sensitive";
}
