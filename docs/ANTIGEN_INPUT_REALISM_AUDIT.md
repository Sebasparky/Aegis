# Antigen Input Realism Audit

**Status:** Audit only — no code changed by this document.
**Scope:** How Antigen's pointer movement, typing, and action cadence actually behave, compared
to human input. The goal is to confirm the agent's own input is plausibly human-like and
low-noise, and to record a safe improvement backlog. This is **not** about defeating any anti-bot
system, and contains **no** evasion or bypass guidance.

All findings were verified by reading the runtime source directly. File:line references point at
the responsible functions and constants.

---

## 1. Mouse movement pipeline

### How a click flows

A `browser_click` request takes this path:

```
browser_click (MCP)
  → POST /api/agent/v1/runtime/browser-click      apps/api/src/routes/agent-api.ts (~3918)
  → realisticClickKnownBox()                       runtime/realisticBrowserActions.ts:867
  → dispatchPointerClickToBox()                    runtime/realisticBrowserActions.ts:74
  → clickBoxWithPointer()                          runtime/nativePointerRuntime.ts:646
```

The click is dispatched over a **raw CDP WebSocket** using `Input.dispatchMouseEvent`. Antigen
does **not** issue an instant click at a point — it first generates and animates a timed pointer
path, then presses and releases.

### What makes the movement human-like

- **Target point is not the center.** `pickTargetPoint()` (`nativePointerRuntime.ts:308`) chooses
  a random point in the **inner 30–70%** of the element box:
  `x = box.x + width * (0.30 + rand * 0.40)` (same for `y`). It avoids both the exact center and
  the edges — closer to how a person lands a cursor inside a button.

- **The path is a Bézier curve, not a straight line.** `generatePointerPath()`
  (`nativePointerRuntime.ts:334`) builds a quadratic Bézier whose control point is offset
  **perpendicular** to the straight start→end line by **10–20% of the path length**, with a random
  left/right sign. Optional pre-recorded **template traces** (`pointerTraceTemplates.ts`) are used
  when a suitable one is loaded; otherwise the Bézier fallback is used.

- **Speed accelerates and decelerates.** Per-point delays follow a **`sin(t·π)` envelope** — slow
  at the start and end, faster through the middle — and sum exactly to the move budget. This
  mimics natural pointer easing rather than constant-velocity motion.

- **Movement granularity and timing** come from `MODE_TIMING` (`nativePointerRuntime.ts:61`):

  | Mode | Points | Move (ms) | Hover (ms) | Press→release (ms) | Total |
  |------|-------|----------|-----------|--------------------|-------|
  | fast | 5 | 30 | 15 | 10 | ~55 |
  | native | 12 | 120 | 50 | 30 | ~200 |
  | **realistic (default)** | **20** | **400** | **150** | **80** | **~630** |
  | careful | 28 | 750 | 300 | 150 | ~1200 |

  The production default is `realistic` — confirmed in `resolvePointerTimingMode()`
  (`nativePointerRuntime.ts:81`): an unset env var resolves to `realistic`;
  `ANTIGEN_POINTER_TIMING=fast` drops to the `native` profile for dev/QA.

- **It hovers before pressing.** After the move completes, `pressAtPoint()` waits `hover_ms`
  (150ms in realistic mode) before dispatching `mousePressed`.

- **Press and release are separated.** `clickAtPoint()` dispatches `mousePressed`, waits
  `click_gap_ms` (80ms realistic), then `mouseReleased`.

- **The pointer has continuity across actions.** Pointer position persists per browser session
  (task-session pointer state, with a module-level fallback). The next movement starts from where
  the last one ended; the very first movement starts from viewport center (≈640,400). Coordinates
  are never returned to the agent.

### Where it is still synthetic

- Per-point delays come from a deterministic `sin` envelope; run-to-run variation comes only from
  the randomized control point and target point, not from the timing curve itself.
- No physical model of hand dynamics (mass, overshoot-and-correct); the curve is smooth and
  always lands cleanly.
- No occlusion awareness — if the computed path passes "under" an overlay, it is still dispatched
  (the path is clamped to the viewport by `clampPathToViewport()` at `:479`, but not to visible
  regions).

**Overall:** the pointer layer is genuinely human-like and is the strongest part of the input
stack.

---

## 2. Typing pipeline

There are two distinct families, used for different purposes.

### A. Keystroke typing (character-by-character — the human-like path)

- **General typing** — `browser_type` → `dispatchTextCharsViaCDP()`
  (`realisticBrowserActions.ts:568`). A 50ms onset pause, then each character is sent via CDP
  `Input.dispatchKeyEvent {type:"char"}` with a per-character jitter from `GENERAL_TYPING_PROFILE`
  = **30–80ms**.

- **Credentials / payment / profile fills** — `typeCharsViaCDP()` (`inputRealismTyper.ts:72`).
  Same shape (50ms onset, char-by-char), with field-kind-aware jitter from `TYPING_PROFILES`
  (`inputRealismTyper.ts:32`): **username 25–75ms**, **password 45–95ms**. Card PAN/CVV use the
  password profile.

- **Default is realistic.** `getInputRealismMode()` (`inputRealismTyper.ts:53`): an unset env var
  resolves to `realistic` (key events). `ANTIGEN_INPUT_REALISM=fast|disabled|false` switches to
  `direct`, which uses `Input.insertText`. There is also a graceful fallback chain: key events →
  `Input.insertText` → native prototype setter.

### B. Exact replacement (instant — machine-like by design)

- `browser_fill`, `browser_set_value`, and `browser_clear` route to `setFieldValueKnownBox()`
  (`realisticBrowserActions.ts:~1568`, value-setting JS in `buildAntigenSetValueExpr:~1472`). This
  is a single `Runtime.evaluate` that clears and sets the value through the **native
  `HTMLInputElement.prototype.value` setter** and dispatches synthetic `input`/`change` events.
  It is instant, has **no per-character delay**, and is idempotent (a no-op if the value already
  matches). `browser_fill` clears and replaces; `browser_type` is the only append path.

  This path exists for reliable, exact, React/Vue-safe value replacement (e.g. correcting a
  volatile checkout field). It is deliberately deterministic, not an attempt to imitate a human.

### Realism gaps shared by both keystroke paths

- **Only `type:"char"` is dispatched.** This fires the DOM `keypress` and `input` events but
  **not `keydown` or `keyup`**. A real keyboard emits `keydown → keypress → input → keyup` per
  character. The only place Antigen emits the full sequence today is the **Enter** key
  (`dispatchEnterKey`, `realisticBrowserActions.ts:~590`, which sends `rawKeyDown → char → keyUp`).
  This is the clearest synthetic signature in the typing layer.
- **Inter-character delays are uniform-ish.** Each delay is `min + rand*(max−min)` — a flat
  distribution. Human typing is closer to log-normal with occasional long pauses.
- **No word pauses, typos, backspaces, or thinking pauses.** Typing is steady from first to last
  character, with only the single 50ms onset pause.
- Typing never auto-submits; Enter is always a separate explicit dispatch.

---

## 3. Action cadence

Cadence is the rhythm *between* actions, and it may matter more than the fidelity of any single
mouse movement: a perfect Bézier click that fires 20ms after a snapshot, repeated rapidly, reads
as automation regardless of curve quality.

- **Snapshot → click:** there is **no artificial delay and no debounce**. After Phase 4B
  revalidation (a few milliseconds of CDP evaluation), the pointer animation itself (~630ms in
  realistic mode) is effectively the spacing between deciding and acting. There is **no true
  page-stability wait** before acting on a snapshot's ref.

- **Post-click settle:** adaptive, early-exit schedules in `antigenClickVerification.ts` — default
  `[150,200,250]`, cart-mutation `[150,200,250,300,300]`, checkout-transition
  `[150,200,250,300,300,400]`, post-fill `[120,180]` (ms between probes). These exit as soon as a
  verified effect is detected, plus a post-click URL early-exit (reads at ≈0/60/120ms, 250ms
  ceiling).

- **Retries are tightly bounded — no tight loops.** Phase 4B revalidation runs once and fails
  closed (`ANTIGEN_REF_STALE`); it never self-retries. The optional recovery mechanisms — logical
  ref recovery (`antigenLogicalRecovery.ts`), surface-scoped resolution
  (`antigenSurfaceResolution.ts`), and click-verify no-effect recovery — are each **a single
  attempt**, gated to low-risk intents, and a verified-effect click never retries (so an
  add-to-cart can't be duplicated). The hard ceiling is **2 retries per action**; page changes
  and sensitive/final TTL expiry fail closed with no retry.

- **No per-minute or per-action budget instrumentation exists.** Cadence is bounded only by
  animation time + settle time + CDP latency (≈0.6–1.6s per click in practice). There is no
  measurement of true action spacing, so the *aggregate* cadence under a real flow is currently
  unmeasured.

---

## 4. Behavior vs. human comparison

| Behavior | Antigen today | Classification |
|---|---|---|
| Click target point | random, inner 30–70% of box | Similar to human |
| Path shape | Bézier with perpendicular bias | Similar to human |
| Move speed | `sin(t·π)` accel/decel | Similar to human |
| Hover before press | 150ms (realistic) | Similar to human |
| Press→release gap | 80ms (realistic) | Similar to human |
| Pointer continuity across actions | persisted per session | Similar to human |
| Char-by-char typing (default) | yes, CDP key events | Similar to human |
| Bounded, fail-closed retries | ≤2, low-risk only | Similar to human / safe |
| Inter-character delay | uniform RNG, fixed band | Different but acceptable |
| Word pauses / typos / corrections | none | Different but acceptable |
| Snapshot→click spacing | no debounce; animation is the spacing | Different but acceptable |
| Keystroke event completeness | `char` only — no keydown/keyup | Clearly machine-like |
| `browser_fill` / `browser_set_value` | instant native setter | Clearly machine-like (by design) |
| True per-action spacing under a flow | not instrumented | Unknown / needs measurement |
| Aggregate cadence over a session | not instrumented | Unknown / needs measurement |
| Inter-char timing realism in aggregate | uniform draw, unmeasured vs. human | Unknown / needs measurement |

---

## 5. Recommended follow-up backlog (not implemented here)

These are realism-hygiene and measurement improvements. They are scoped to Antigen's own input
behavior and are not tuned to any detection system.

1. **Emit a full key-event sequence for realistic typing.** Replace the lone `{type:"char"}` with
   `rawKeyDown → char → keyUp` per character (the Enter path already does this). Removes the
   clearest synthetic signature; behavior-neutral for form fields. Worth a flag so it can be
   disabled if a site misbehaves.
2. **Improve inter-character timing and add pauses.** Move from a uniform draw to a log-normal-ish
   distribution, add occasional longer keystroke pauses, and a short pause at word boundaries.
   Keep the current bands as the body of the distribution.
3. **Optional small pre-action page-stability wait.** A bounded "ready" gate before click/type
   when a recent navigation is in flight, reusing the existing settle-schedule machinery rather
   than a new poll loop. Flag-gated, default off, capped so it never becomes a tight loop.
4. **Measurement fixture / harness.** A local page that records emitted `keydown`/`keyup`/`input`
   timestamps and `mousemove` counts, driven through the real CDP runtime, asserting bounds on
   mousemoves per click, char-delay distribution, full key-event presence, and minimum action
   spacing. This is the only way to retire the three "Unknown / needs measurement" rows above.
5. **Document the cadence contract.** Record that there is no per-minute cap by design, that the
   animation+settle time is the implicit throttle, and that retries are bounded (≤2, fail-closed),
   so future changes don't accidentally introduce tight loops.

---

## Key code locations

| Concern | File | Symbols / lines |
|---|---|---|
| Pointer timing & path | `apps/api/src/runtime/nativePointerRuntime.ts` | `MODE_TIMING:61`, `resolvePointerTimingMode:81`, `pickTargetPoint:308`, `generatePointerPath:334`, `clampPathToViewport:479`, `clickBoxWithPointer:646` |
| Click dispatch, general typing, exact-set | `apps/api/src/runtime/realisticBrowserActions.ts` | `dispatchPointerClickToBox:74`, `dispatchTextCharsViaCDP:568`, `dispatchEnterKey:~590`, `realisticClickKnownBox:867`, `buildAntigenSetValueExpr:~1472`, `setFieldValueKnownBox:~1568` |
| Credential/payment typing realism | `apps/api/src/runtime/inputRealismTyper.ts` | `TYPING_PROFILES:32`, `getInputRealismMode:53`, `typeCharsViaCDP:72` |
| Protected fill primitive | `apps/api/src/runtime/protectedRealisticFill.ts` | `executeProtectedRealisticFill:135` |
| Settle schedules / click verification | `apps/api/src/runtime/antigenClickVerification.ts` | settle constants `:261/268/276/288` |
| Bounded recovery | `apps/api/src/runtime/antigenLogicalRecovery.ts`, `antigenSurfaceResolution.ts` | recovery eligibility / single-attempt re-find |
| Click endpoint & recovery gates | `apps/api/src/routes/agent-api.ts` | click endpoint `~3918`, recovery gates `~4143–4377` |
