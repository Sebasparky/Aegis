type InputRealismEvent =
  | "input_realism_mode_selected"
  | "input_realism_typing_started"
  | "input_realism_typing_completed"
  | "input_realism_verify_started"
  | "input_realism_verify_completed"
  | "input_realism_fallback_to_direct"
  | "input_realism_direct_mode"
  | "input_realism_failed";

type InputRealismPayload = {
  injection_request_id?: string;
  field_kind?: string;
  domain?: string;
  mode?: string;
  strategy?: string;
  char_count_bucket?: string;
  duration_ms?: number;
  success?: boolean;
  fallback_used?: boolean;
  fallback_reason?: string;
  failure_reason?: string;
};

export function logInputRealismLifecycle(
  event: InputRealismEvent,
  payload: InputRealismPayload,
): void {
  console.log("[InputRealism]", event, payload);
}
