/**
 * Input Realism Typer — v1 (username/password fields only)
 *
 * Dispatches CDP key events character-by-character with field-kind-aware jitter
 * after pointer focus completes. This is fire-and-forget dispatch: key events are
 * sent sequentially with a sleep between each; no per-character ack is awaited.
 * Whether the field accepted the input is verified separately by the caller via
 * a post-typing Runtime.evaluate check.
 *
 * Secret-safety invariants:
 * - Never log raw value, any substring, or full/partial character sequences
 * - Never log char count — use char_count_bucket only
 * - Never log pass_id, secret_ref, browser_session_id, or selector hints
 * - [InputRealism] logs include only approved fields (see TYPING_INPUT_REALISM.md)
 */

export type InputRealismMode = "realistic" | "direct";

export interface InputRealismResult {
  strategy: "key_events" | "direct_assignment";
  duration_ms: number;
  char_count_bucket: string;
  success: boolean;
  failure_reason?: string;
}

interface TypingProfile {
  min_ms: number;
  max_ms: number;
}

const TYPING_PROFILES: Record<"username" | "password", TypingProfile> = {
  username: { min_ms: 25, max_ms: 75 },
  password: { min_ms: 45, max_ms: 95 },
};

/**
 * Maps a raw value length to a coarse bucket string.
 * Never use raw length in logs — always use this bucket.
 */
export function getCharCountBucket(len: number): string {
  if (len <= 4) return "1-4";
  if (len <= 8) return "5-8";
  if (len <= 16) return "9-16";
  return "17+";
}

/**
 * Reads ANTIGEN_INPUT_REALISM env var to determine the active mode.
 *   unset / "realistic" / any unknown  → "realistic" (character-by-character key events)
 *   "fast" / "disabled" / "false"      → "direct"   (skip realism; caller uses insertText)
 */
export function getInputRealismMode(): InputRealismMode {
  const v = (process.env.ANTIGEN_INPUT_REALISM ?? "").toLowerCase();
  if (v === "fast" || v === "disabled" || v === "false") return "direct";
  return "realistic";
}

/**
 * Reads ANTIGEN_INPUT_KEYEVENTS_FULL env var. Default ON.
 *   unset / "true" / any unknown                 → true  (rawKeyDown → char → keyUp per char)
 *   "false" / "0" / "disabled" / "off" / "no"    → false (legacy char-only event)
 *
 * When on, realistic typing emits the full browser-like key-event sequence per
 * character instead of the lone `{type:"char"}` event. Behavior-neutral for form
 * fields; flag exists so it can be disabled if a site misbehaves.
 */
export function getKeyEventsFullEnabled(): boolean {
  const v = (process.env.ANTIGEN_INPUT_KEYEVENTS_FULL ?? "").toLowerCase();
  return !(v === "false" || v === "0" || v === "disabled" || v === "off" || v === "no");
}

/**
 * Emits one printable character's CDP key events.
 *
 * With full key events (default), dispatches rawKeyDown → char → keyUp, mirroring
 * the proven `dispatchEnterViaCDP` shape: rawKeyDown/keyUp carry `key` (no text);
 * the `char` event carries `text` and is what fires DOM keypress/input and inserts
 * the character. Without full key events, only the `char` event is sent — the
 * original behavior.
 *
 * No intra-character sleep is performed: inter-character jitter remains the
 * caller's spacing, so total typing duration is unchanged. Never logs the char.
 */
export function dispatchPrintableCharViaCDP(
  sendCdp: (method: string, params: Record<string, unknown>) => void,
  char: string,
  fullKeyEvents: boolean,
): void {
  if (!fullKeyEvents) {
    sendCdp("Input.dispatchKeyEvent", { type: "char", text: char });
    return;
  }
  sendCdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: char });
  sendCdp("Input.dispatchKeyEvent", { type: "char", text: char });
  sendCdp("Input.dispatchKeyEvent", { type: "keyUp", key: char });
}

/**
 * Dispatches CDP `Input.dispatchKeyEvent` calls character-by-character with
 * field-kind-aware jitter. Fire-and-forget: each event is sent without waiting
 * for a CDP ack. Value acceptance must be verified by the caller afterward.
 *
 * @param sendCdp   CDP send function (must not throw on well-formed params)
 * @param sleep     Awaitable delay — injected for testability
 * @param opts.value        The secret value to type (never logged)
 * @param opts.fieldKind    "username" or "password" — selects timing profile
 * @param opts.injectionRequestId  Safe to log; passed through to diagnostics
 * @param opts.domain       Safe to log
 * @param opts.random       Injected RNG for deterministic tests (default: Math.random)
 */
export async function typeCharsViaCDP(
  sendCdp: (method: string, params: Record<string, unknown>) => void,
  sleep: (ms: number) => Promise<void>,
  opts: {
    value: string;
    fieldKind: "username" | "password";
    injectionRequestId: string;
    domain: string;
    random?: () => number;
  },
): Promise<InputRealismResult> {
  const { value, fieldKind, injectionRequestId, domain } = opts;
  const random = opts.random ?? Math.random;
  const profile = TYPING_PROFILES[fieldKind];
  const charCountBucket = getCharCountBucket(value.length);
  const fullKeyEvents = getKeyEventsFullEnabled();
  const startMs = Date.now();

  // Brief pause after focus before first keystroke — matches natural human onset.
  await sleep(50);

  for (const char of value) {
    try {
      dispatchPrintableCharViaCDP(sendCdp, char, fullKeyEvents);
    } catch {
      // Synchronous send failure (e.g., WebSocket closed mid-typing).
      // Return failure so the caller can fall back to direct assignment.
      const duration_ms = Date.now() - startMs;
      return {
        strategy: "key_events",
        duration_ms,
        char_count_bucket: charCountBucket,
        success: false,
        failure_reason: "send_failed",
      };
    }
    const jitterMs = profile.min_ms + random() * (profile.max_ms - profile.min_ms);
    await sleep(Math.round(jitterMs));
  }

  const duration_ms = Date.now() - startMs;
  return {
    strategy: "key_events",
    duration_ms,
    char_count_bucket: charCountBucket,
    success: true,
  };
}
