# Typing Speed and Input Realism

## Purpose

Typing/input realism makes Antigen's sensitive-field handoff feel intentional, legible, and trustworthy. It closes the last gap between pointer movement realism and complete sensitive-handoff realism: the pointer can now move naturally via calibrated traces, but value insertion into the field may still appear instantaneous or mechanical.

This is not bot evasion. It is an execution quality and user-trust layer for sensitive handoffs.

The user delegating an action should be able to watch Antigen fill a credential, OTP, or profile value and understand that Antigen is:

1. targeting the correct field
2. entering the correct kind of value
3. doing so at a natural, intentional pace
4. never exposing the raw secret to the agent or to logs
5. producing clean diagnostics if input fails or stalls

---

## Product Goals

- Human-legible sensitive handoff — value entry that visually tracks as deliberate
- Consistent pacing across credential, OTP, profile, and payment field fills
- Secret-safe input — raw values never reach agent logs, API responses, or diagnostic payloads
- Field-kind-aware behavior — different profiles for password vs. username vs. OTP vs. profile text
- Clear lifecycle diagnostics — structured failure output when input stalls or is rejected
- Configurable modes — fast/safe/dev speed variants later, without changing the safety model

---

## Non-Goals

- Do not attempt to bypass or defeat bot detection
- Do not pretend to be a human at the network or fingerprinting level
- Do not add site-specific timing hardcoding
- Do not expose raw characters, full string length, or any reconstructable partial value in logs or responses
- Do not make input so slow that sensitive handoffs feel broken or stalled
- Do not replace external agent control of ordinary browsing — Antigen only takes over for guarded value entry

---

## Current Baseline

Pointer movement is now realistic. Calibrated template traces are loaded from `pointerProfileLoader.ts` and dispatched by `nativePointerRuntime.ts`. The `generator: "template_trace"` log field confirms trace-based dispatch; `"bezier_fallback"` is used when no matching template exists. Pointer state persists per `browser_session_id` across fills and navigations.

Credential injection lifecycle now records `executing_at` and produces structured lifecycle events via `injectionLifecycleLog.ts`. The status machine (`pending_approval → approved → executing → filled`) is observable and auditable.

What is missing: a dedicated realism layer for value insertion. Current behavior depending on code path is either direct CDP `value` property assignment or fast synthetic event dispatch. Neither tracks naturally when a user watches the browser.

---

## Desired User Experience

For a sensitive-field fill, the sequence should be:

1. Antigen receives an approved field-fill request
2. Antigen selects the correct browser session and confirms the target domain
3. Pointer moves to the field (calibrated trace — already implemented)
4. Field receives focus (CDP click — already implemented)
5. Value is inserted at a controlled, field-kind-aware cadence
6. For secret fields: browser masks value as bullets; Antigen does not log characters
7. Antigen verifies the field accepted input (value present, no error state)
8. Antigen records `filled_at` and lifecycle status; control returns to the external agent

The external agent still owns: navigation, clicking Next/Sign In/Submit, choosing login method, and all ordinary browsing. Antigen only intervenes for step 5 above.

---

## Input Classes

### username_email

- Typically visible in the browser
- Moderate typing speed
- No character-level masking required
- Should support correction-like behavior later (backspace + retype) if validation rejects the value

### secret_password

- Browser masks characters as bullets natively
- Never log characters or field content at any granularity
- Typing should be steady — not painfully slow, not instantaneous
- Avoid per-character diagnostics (single duration_ms total, not per-char)
- Paste fallback is acceptable if key events are unreliable, but must be audited before enabling

### otp_code

- Short value (4–10 characters)
- Usually masked or visible depending on the page
- Should be faster and more deliberate than password typing
- Must support paste fallback if page blocks synthetic key events (common in OTP widgets)
- OTP has an expiry — input must complete within the challenge window

### profile_text (name, address, phone)

- Visible fields; more natural, human-like pacing
- Field validation matters — some fields reject partial input; complete value should arrive correctly
- Longer values (full addresses) need adequate time without feeling frozen

### payment_card

- High-liability field — intentionally slower and more deliberate
- May require segmented entry (4-digit groups) in a future pass
- Approach should be conservative until a full payment field profile is designed
- Not in scope for v1 typing realism; reserved for Phase 3+

---

## Runtime Strategy

### Preferred v1 approach

Add a `typeIntoField` helper that is called by the sensitive-field injection path after pointer focus completes. The helper:

1. Resolves the `field_kind` from the injection request
2. Selects the appropriate typing profile (see table below)
3. Dispatches CDP key events character by character with per-character delay
4. Verifies the field accepted the full value after completion
5. Returns `{ success, strategy, duration_ms, char_count_bucket, failure_reason? }`

CDP key events (`Input.dispatchKeyEvent`) are preferred over direct DOM value assignment because they trigger React/Vue synthetic event handlers, field validators, and masking behavior. Direct assignment (`element.value = ...`) is a fallback or explicit `fast` mode only.

### Typing profiles (starting points, not final constants)

| field_kind | delay range (ms/char) | notes |
|---|---|---|
| `secret_password` | 45–95 | jitter within range; no per-char logs |
| `username_email` | 25–75 | moderate pace; visible field |
| `otp_code` | 35–80 | faster; deliberate; paste fallback available |
| `profile_text` | 40–120 | human-like; longer values tolerated |
| `payment_card` | intentionally slower | reserved for Phase 3+; segmented later |

Jitter should be drawn from a uniform or small-variance distribution within the range. Do not use a fixed constant — it looks mechanical. Do not use a distribution wide enough that individual characters feel laggy.

### Strategy selection

```
field_kind         → profile
env ANTIGEN_INPUT_REALISM=fast  → all fields use direct assignment (dev shortcut)
input event unreliable signal   → fallback to direct assignment + log "fallback_to_direct_assignment"
```

---

## Safety and Secret Handling

- Never log raw characters or any reconstructable partial value
- Never log full string length when that could leak sensitive structure (use `char_count_bucket`: e.g., `"1-4"`, `"5-8"`, `"9-16"`, `"17+"`)
- Never use the clipboard for secrets unless explicitly designed and security-reviewed
- Do not begin typing unless target selection and focus are confirmed — no typing into the wrong field
- Do not expose the raw value to the external agent at any point in the lifecycle
- Do not expose raw value in `InputRealism` log events, error payloads, or diagnostic responses
- `injection_request_id` is safe to log; `pass_id` and `secret_ref` are not
- `browser_session_id` is internal-only — do not include in public or MCP-facing responses

---

## Diagnostics

Log prefix: `[InputRealism]`

### Allowed log events and fields

| Event | Allowed fields |
|---|---|
| `typing_started` | `injection_request_id`, `field_kind`, `domain`, `strategy`, `char_count_bucket` |
| `typing_completed` | `injection_request_id`, `field_kind`, `domain`, `strategy`, `duration_ms`, `char_count_bucket`, `success: true` |
| `typing_failed` | `injection_request_id`, `field_kind`, `domain`, `strategy`, `duration_ms`, `char_count_bucket`, `success: false`, `failure_reason` |
| `fallback_to_direct_assignment` | `injection_request_id`, `field_kind`, `domain`, `reason` |

### Forbidden in all log events

- raw value or any substring
- individual characters
- full string length (use `char_count_bucket`)
- `pass_id`
- `secret_ref`
- `browser_session_id` (internal diagnostics only, never in MCP or API responses)
- selector hints beyond what is already permitted in injection lifecycle logs

---

## Failure Modes

Each failure mode should produce a structured `failure_reason` string and a `typing_failed` log event.

| Failure | Expected handling |
|---|---|
| Field loses focus mid-type | Abort typing; return `field_focus_lost`; report partial input in lifecycle |
| Page navigates during typing | Abort; return `page_navigated_during_input`; mark injection `failed` |
| Input blocked or readonly | Detect before starting; return `field_not_writable` |
| Framework ignores synthetic key events | Retry with direct assignment fallback; log `fallback_to_direct_assignment` |
| Value partially entered | Log `partial_input`; do not retry with same authorization |
| OTP expires during entry | Return `otp_expired_during_input`; agent must re-request challenge |
| Password manager / autofill overlay interferes | Detect overlay; return `autofill_interference`; surface as advisory |
| CDP target changes | Return `cdp_target_changed`; lifecycle status set to `failed` |

---

## Phased Plan

**Phase 0 — Docs and acceptance criteria** _(this increment — complete)_
- Define goals, non-goals, input classes, profiles, safety invariants, failure modes, AC

**Phase 1 — Input realism helper**
- Add `typeIntoField` to the runtime helper layer
- Wire behind `ANTIGEN_INPUT_REALISM=true` env flag or enable as default-safe
- Unit tests: profile selection, char_count_bucket logic, redaction behavior, fallback trigger

**Phase 2 — Wire credential injection**
- Use `typeIntoField` for `username_email` and `secret_password` fills in `executeSecretInjectionViaCDP`
- Verify `executing_at` / `filled_at` timestamps remain correct
- Smoke test: localhost GitHub login; visual confirmation of character-by-character entry

**Phase 3 — OTP, profile, and payment field profiles**
- Wire `otp_code` profile with paste fallback
- Wire `profile_text` profile for name/address fields
- Begin `payment_card` profile design (segmented entry approach)

**Phase 4 — Diagnostics integration**
- Surface `[InputRealism]` events in the injection lifecycle log or a dedicated diagnostics endpoint
- Integrate `duration_ms` and `char_count_bucket` into the lifecycle response for internal tooling

**Phase 5 — Tuning**
- Run smoke tests against real sites (GitHub login, OTP flows)
- Adjust profile timing constants based on observed behavior
- Document final constants as tuned values in this file

---

## Acceptance Criteria for v1 Implementation (Phase 1 + 2)

- Pointer movement remains calibrated — template traces still used for pointer movement to the field
- Username and password fields type character by character instead of teleporting the full value
- No raw secret values appear in any log, API response, MCP tool response, or CDP payload
- `executing_at` and `filled_at` lifecycle timestamps remain correct after input realism is wired
- Failed typing produces a structured `failure_reason` with `[InputRealism]` log event
- Tests cover: profile selection by `field_kind`, `char_count_bucket` bucketing, redaction invariants, fallback to direct assignment when key events fail, lifecycle timestamp compatibility
- Manual smoke test shows natural character-by-character entry on localhost login without triggering form submission mid-type

---

## Open Questions

1. **Dev mode speed** — should `ANTIGEN_INPUT_REALISM=fast` default to direct assignment, or to a fast but still key-event-based path? Fast key events are preferable for test reliability.
2. **Default-on vs env flag** — should input realism be on by default in v1, or require `ANTIGEN_INPUT_REALISM=true`? Recommendation: default-on with a `fast` override for dev/test.
3. **Password field masking** — if CDP key events are unreliable for a specific site, direct assignment still triggers browser masking (bullets). This is acceptable as a fallback; log `fallback_to_direct_assignment`.
4. **Pre-type pause** — should there be a short pause (50–150 ms) after focus and before the first character? A brief pause matches natural human behavior and separates the focus click from typing onset.
5. **OTP vs password speed** — OTP codes should be faster (35–80 ms/char) since they are short and the user expects fast entry. Password typing can be slower without feeling wrong.
6. **Profile field corrections** — should `profile_text` typing simulate backspace-and-retype if a field validator rejects partial input? Phase 3 concern; not in v1 scope.

---

## References

- `docs/CDP_INJECTION_RUNTIME.md` — persistent pointer state, pointer log format, CDP disconnect semantics
- `docs/NATIVE_DELEGATED_INTERACTION_RUNTIME.md` — pointer interaction modes (`fast`, `native`, `realistic`, `careful`), Bézier/template path generation, v2 normalized template matching algorithm
- `docs/LOCAL_RUNTIME_BROWSER_ENDPOINT.md` — Antigen model, three browser modes, Antigen responsibilities boundary, `browser.disconnect()` invariant
- `apps/api/src/runtime/nativePointerRuntime.ts` — current pointer dispatch implementation
- `apps/api/src/lib/injectionLifecycleLog.ts` — credential injection lifecycle log structure
- `apps/api/src/routes/secret-field-injections.ts` — injection status machine and CDP fill endpoint
