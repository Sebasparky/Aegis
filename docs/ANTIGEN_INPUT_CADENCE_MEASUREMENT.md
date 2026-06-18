# Antigen Input / Cadence Measurement

**Status:** Measurement harness + representative baseline. No runtime behavior is changed by this
work.
**Scope:** Measure what Antigen's real CDP runtime actually emits to a page — mouse path, click
mechanics, keystroke sequence, and the rhythm *between* actions — against a controlled local
fixture. This is the harness called for as backlog item **#4** of
[`ANTIGEN_INPUT_REALISM_AUDIT.md`](./ANTIGEN_INPUT_REALISM_AUDIT.md), and it retires the three rows
that audit left as **"Unknown / needs measurement."**

This is **not** about defeating any anti-bot system and contains **no** evasion or vendor logic. It
drives the real runtime on a local `file://` fixture only — no live site.

---

## What it measures and why

The audit established (by reading source) that the pointer layer animates a Bézier path, that
typing is char-by-char, and — after commit `ea4cb66` — that realistic typing emits a full
`keydown → char → keyUp` sequence. But three things could only be confirmed by observation:

1. **True per-action spacing under a flow** — is there really no debounce between actions?
2. **Aggregate cadence over a session** — what is the actual click→click rhythm?
3. **Inter-char timing realism in aggregate** — do the emitted delays match the configured band?

The harness records the browser-visible events the page sees and reports them, so these rows can be
backed by numbers instead of inference.

## Files

| File | Role |
|---|---|
| `apps/api/src/__tests__/fixtures/input-cadence-fixture.html` | Controlled page; an inline recorder timestamps every `mousemove`/`mousedown`/`mouseup`/`click` and `keydown`/`beforeinput`/`input`/`keyup` via `performance.now()`. Records only event types, keys, and timestamps — never field values. |
| `apps/api/src/__tests__/antigen-input-cadence.bench.test.ts` | Gated harness. Spawns headless Chromium, drives the real `realisticClickKnownBox` / `realisticTypeKnownBox`, reads the recorded log back over CDP, computes metrics, asserts loose bounds, and writes the table below. |

The harness reuses the runtime entry points unchanged
(`realisticClickKnownBox`, `realisticTypeKnownBox` in `apps/api/src/runtime/realisticBrowserActions.ts`)
and the snapshot box extractor (`extractAntigenSnapshotCandidatesViaCDP`). It is a sibling of the
existing `antigen-latency-benchmark.bench.test.ts` and shares its double-gating and report-writer
pattern.

## How to run

Double-gated, exactly like the latency benchmark: it runs only when `ANTIGEN_BENCHMARK=true` **and**
a Playwright Chromium is installed. A plain `vitest run` always skips it, so it can never become a
CI gate or a flake source.

```bash
cd apps/api
# default — skipped:
npx vitest run antigen-input-cadence
# real measurement run (requires Playwright Chromium):
ANTIGEN_BENCHMARK=true npx vitest run antigen-input-cadence
# capture the table to a path of your choice:
ANTIGEN_CADENCE_OUT=/tmp/cadence.md ANTIGEN_BENCHMARK=true npx vitest run antigen-input-cadence
```

It runs at the production defaults: realistic pointer profile (`ANTIGEN_POINTER_TIMING` unset) and
the full key-event sequence (`ANTIGEN_INPUT_KEYEVENTS_FULL` defaulting to on). The harness clears a
stray `ANTIGEN_POINTER_TIMING` from the shell so a developer's environment can't skew the baseline.

## Metric definitions

| Metric | Meaning |
|---|---|
| `click_mousemove_count` | DOM `mousemove` events emitted during one realistic click (the animated pointer path). |
| `click_press_release_gap` | `mouseup.t − mousedown.t` — how long the button is held (the runtime's `click_gap_ms`). |
| `click_up_to_click_gap` | `click.t − mouseup.t` — browser-synthesized click latency after release. |
| `click_onset_to_click` | Recorder-reset → `click` event — the action-start→commit latency (dominated by pointer animation). |
| `type_keydown_count` / `type_keyup_count` / `type_input_count` | Per-character event counts for the typed string (length 11). Equality with the char count is the empirical proof of the full `keydown → char → keyUp` sequence. |
| `type_onset_to_first_key` | Recorder-reset → first `keydown` (includes the focus click + 50ms typing onset). |
| `type_interchar_delay` | Delay between successive `keydown` events — the inter-character cadence distribution. |
| `action_spacing_two_clicks` | `click.t` gap between two consecutive clicks — the real per-action spacing under a mini-flow. |
| `retries_observed` | Retry/stale recoveries triggered on the clean fixture. |

## Representative local baseline

> **This is a representative local baseline, not a universal guarantee.** Every number below depends
> on the machine, the Chromium build, and concurrent load. Treat the *shape* (full key-event
> sequence present, press→release ≈ the configured 80ms, inter-char inside the 30–80ms band, action
> spacing ≈ animation time, zero retries) as the stable finding — not the exact milliseconds. Re-run
> the harness to regenerate the table for your environment.

Captured on: macOS 15.3.1 (arm64), Node v22.13.1, Playwright Chromium 147.0.7727.15, headless,
otherwise idle. `n` is iterations (or, for `type_interchar_delay`, total inter-keystroke samples).

| metric | unit | n | p50 | p95 | min | max | mean | note |
|---|---|---|---|---|---|---|---|---|
| click_mousemove_count | count | 10 | 27 | 27 | 26 | 27 | 26.5 | |
| click_press_release_gap | ms | 10 | 81.4 | 87.6 | 77.2 | 87.6 | 81.6 | |
| click_up_to_click_gap | ms | 10 | 0 | 0.7 | 0 | 0.7 | 0.1 | |
| click_onset_to_click | ms | 10 | 659.1 | 682.6 | 656.7 | 682.6 | 662.1 | recorder reset → click event |
| type_keydown_count | count | 8 | 11 | 11 | 11 | 11 | 11 | expected == 11 |
| type_keyup_count | count | 8 | 11 | 11 | 11 | 11 | 11 | expected == 11 |
| type_input_count | count | 8 | 11 | 11 | 11 | 11 | 11 | expected == 11 |
| type_beforeinput_count | count | 8 | 11 | 11 | 11 | 11 | 11 | |
| type_onset_to_first_key | ms | 8 | 730.4 | 735 | 724.7 | 735 | 729.3 | reset → first keydown |
| type_interchar_delay | ms | 80 | 55.4 | 78.5 | 33.1 | 80.7 | 57 | between successive keydowns |
| action_spacing_two_clicks | ms | 8 | 786.2 | 792.8 | 781.8 | 792.8 | 786.5 | click→click; ≈ animation+settle time, no artificial delay |
| retries_observed | count | 1 | 0 | 0 | 0 | 0 | 0 | single-dispatch runtime layer; clean fixture; fail-closed ≤2 at endpoint |

## Interpretation (retiring the three "needs measurement" rows)

- **Full key-event sequence is present.** `keydown`, `keyup`, and `input` each fire exactly once per
  character (11/11/11 for `"hello world"`). This is the empirical confirmation of commit `ea4cb66` —
  the lone `{type:"char"}` signature the audit flagged is gone. (`beforeinput` also fires per char,
  which is expected for editable inputs.)
- **Inter-char timing matches the configured band.** Measured 33–81ms with a ~57ms mean, sitting
  squarely inside the 30–80ms `GENERAL_TYPING_PROFILE`. It remains a flat/uniform draw, not
  log-normal with word pauses — that realism-hygiene improvement is still backlog item #2 in the
  audit; this harness now makes its effect measurable if/when it lands.
- **Per-action spacing ≈ animation time, no debounce.** Two consecutive clicks land ~786ms apart and
  a single click commits ~662ms after action start — both ≈ the ~630ms realistic pointer animation
  plus CDP overhead. There is no artificial inter-action delay; the animation+settle time *is* the
  implicit throttle, as the audit's cadence contract states.
- **Click mechanics are human-shaped.** ~26 `mousemove` events per click (the ~20-point realistic
  Bézier path), an ~81ms press→release hold (matching the 80ms `click_gap_ms`), and a browser-
  synthesized click essentially coincident with release.
- **Retries stay at zero on a clean page.** The runtime click/type functions perform a single
  dispatch; the endpoint-layer recovery paths are single-attempt, low-risk-gated, and fail-closed
  (≤2). A clean fixture triggers none. Forcing a stale/retry condition is intentionally out of scope
  for this measurement.

## Scope and limitations

- Controlled local fixture only. No live site, no anti-bot or vendor logic, no evasion guidance.
- Behavior-neutral: this harness reads emitted events; it changes no runtime path.
- Manual and default-skipped — never wired into CI.
- The recorder captures event types, keys, and timestamps only — never field values — consistent
  with the codebase's "structure, not values" posture.
- Numbers are environment-dependent; re-run to regenerate for your machine.
