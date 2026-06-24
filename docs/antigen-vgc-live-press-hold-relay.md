# Antigen VGC Live Press-and-Hold Relay — Milestone

Branch: `feature/vgc-live-press-hold-relay`

This is a **working dev milestone / live relay slice**: a verified end-to-end human-verification (HV)
flow against live Bath & Body Works (B&BW) "Press & Hold" walls, driven by the user through the
Antigen UI.

**This is NOT:**

- a CAPTCHA solve or bypass — Antigen never solves, automates, or defeats a human-presence challenge;
- production-ready — it is a single proven live slice on one vendor;
- a general HV solution — it has only been exercised against B&BW press-and-hold walls so far.

Antigen's role is to **detect, surface, and route** the human-verification challenge to the user and
then **observe** when the page clears. The human does the verification.

---

## Current Status

End-to-end flow that now works on live B&BW press-and-hold walls:

1. **HV wall detection is model-promoted.** The model detects the wall and a Visual Gesture Capsule
   (VGC) / handoff is minted.
2. **Handoff is created from `visual_gesture_capsule`.** Phases are published on the HV handoff ring.
3. **User interaction happens through the Antigen UI.** The user presses-and-holds in the Antigen
   surface; the live hold session relays the gesture (hold-start → heartbeats → hold-end) with a
   fail-closed timer.
4. **Release-ready detection uses the hold-anchor crop first.** The per-shape bar/button/ring detector
   runs on the selected crop. The selection priority is
   `dominant_surface → hold_anchor → inner_control → center_region`.
5. **Whole-crop temporal fallback (hold-anchor only).** If the per-shape detector fails to find an
   affordance on a `hold_anchor` crop, a conservative whole-crop fallback infers release readiness
   from cumulative visual change plus a recent-frame plateau.
6. **Completion is still governed by stable visual clear after release.** Completion requires a run of
   consecutive `looks_clear` confirmations (`advanceStableClear` → `complete`). The agent remains
   blocked until completion. `release_ready` never completes the flow.

`release_ready` is a **non-terminal UI sub-state** ("Release now" nudge). It surfaces guidance to the
user and nothing else.

---

## Invariants

These are hard rules. Do not weaken them.

- **Antigen detects / surfaces / routes human verification; it does not bypass it.** No CAPTCHA, 2FA,
  passkey, or human-presence check is ever solved or automated.
- **`release_ready` is UI guidance only.** It must NOT clear the VGC, complete the handoff, release
  the user's hold, or resume the agent.
- **The agent keeps waiting while phase is `release_ready`** (`agent_should_wait: true`, like
  `still_active` and `looks_complete_checking`). Only the conservative completion authority publishes
  `completed`.
- **Completion requires consecutive visual-clear confirmation** (`looks_clear` streak), not a single
  clear frame and not `release_ready`.
- **Whole-crop fallback runs only for `cropSource === "hold_anchor"`** — an explicit positive equality
  gate. It must NOT run for `dominant_surface`, `inner_control`, `center_region`, or any future/unknown
  crop source.
- **Pixel grids and crops are memory-only and never agent-visible.** The agent never receives
  screenshots, crops, coordinates, or gesture geometry.
- **Telemetry stays bucketed / enum-only and debug-flag-gated.** No raw pixels, dims, coordinates, or
  ratios are ever logged or returned.

---

## Implementation Notes

Pointers to the real code (source of truth — do not duplicate logic here):

- **Crop selection** — `selectReleaseReadyCrop()` in
  `apps/api/src/runtime/visualHandoffMonitor.ts`. Priority
  `dominant_surface → hold_anchor → inner_control → center_region`; the selected
  `SelectedCropSource` is passed down to the fallback.
- **Per-shape release-ready detector** — `apps/api/src/runtime/visualReleaseReadyDetector.ts`
  (horizontal bar / button / ring affordance detection).
- **Whole-crop temporal fallback** — `apps/api/src/runtime/visualReleaseReadyWholeCrop.ts`.
  `estimateReleaseReadyWithWholeCropFallback()` runs the per-shape detector first; only on a `found:
  false` result AND `cropSource === "hold_anchor"` does it call the stateful per-capsule
  `evaluateWholeCropProgress()`.
- **Live hold lifecycle** — `apps/api/src/runtime/visualGestureCapsuleHold.ts`. Hold-start /
  heartbeat / hold-end endpoints; fail-closed release on heartbeat silence; hard max-duration ceiling;
  a low-frequency in-hold DOM cleared-probe is the only authority for in-hold clearing (the model is
  advisory and never releases).
- **Handoff phases** — `apps/api/src/runtime/humanVerificationHandoff.ts`. `HvHandoffPhase` enum and
  `publishHvHandoffUpdate()`. `release_ready`, `still_active`, and `looks_complete_checking` all carry
  `agent_should_wait: true`.
- **Completion authority** — `advanceStableClear()` in `visualHandoffMonitor.ts`: a `looks_clear`
  verdict increments the consecutive-clear streak and only a full run of consecutive clears yields
  `action: "complete"`; any `wall_present` tick resets the streak.
- **Sticky "Release now"** — the monitor keeps a **monitor-private** `release_ready_sticky` flag so a
  later `wall_present` tick does not downgrade the "Release now" nudge back to `still_active` during a
  live hold. This pin is UI guidance only and does not affect completion, the hold, or agent
  resumption. (See Known Follow-ups for its limitation.)

### Constants & logic (current values)

Whole-crop fallback (`visualReleaseReadyWholeCrop.ts`):

| Constant | Value | Meaning |
|---|---|---|
| `CHANGE_LUMA_DELTA` | `30` | Per-pixel luminance delta (0–255) for a pixel to count as "changed". |
| `CUMULATIVE_STRONG_MIN` | `0.03` | Min fraction of crop pixels differing from the **baseline** to read "a lot has filled". |
| `RECENT_PLATEAU_MAX` | `0.012` | Max fraction of pixels differing from the **previous** frame (strict plateau). |
| `RECENT_PLATEAU_RELAXED_MAX` | `0.018` | Relaxed plateau ceiling for the sustained-evidence path. |
| `RELAXED_STRONG_MIN_CONSECUTIVE` | `3` | Consecutive relaxed-ok compared frames required for the relaxed path. |

Outer streak (`visualHandoffMonitor.ts`):

| Constant | Value | Meaning |
|---|---|---|
| `FULL_RATIO_THRESHOLD` | `0.92` | Fill ratio at/above which a frame counts as "full". |
| `VGC_RELEASE_READY_CONSECUTIVE` | `2` | Consecutive full-and-stable frames required before `release_ready` fires. |

Decision logic for the whole-crop fallback strong-read:

- **Strict mode:** cumulative ≥ `0.03` AND recent ≤ `0.012`.
- **Relaxed sustained mode:** cumulative ≥ `0.03` AND recent ≤ `0.018` for `3` consecutive compared
  frames.
- Either mode then still flows through the **outer two-consecutive-full-frame streak**
  (`VGC_RELEASE_READY_CONSECUTIVE = 2`) before `release_ready` is published. The fallback only ever
  loosens the *affordance read*, never the streak gate.

---

## Live Evidence

Dev observations from live side-by-side runs against B&BW — **not formal benchmarks**:

- **Baseline:** ~25s hold; `release_ready` did not reliably fire.
- **After whole-crop fallback:** observed hold guidance ~14s.
- **After latency tuning:** observed hold guidance ~7s.
- **Observed UI lag vs. the real challenge:** ~3s in the latest side-by-side run.

Treat these as directional indicators of the tuning progression, not guaranteed timings.

---

## Known Follow-ups

- **Cross-publisher handoff phase clobber (observed in live runs).** `release_ready` can still briefly
  downgrade to `still_active` before `hold_ended`, **despite the monitor-local `release_ready_sticky`
  state**. The shared handoff ring is last-writer-wins, so the hold module's in-hold model advisory
  can clobber the monitor's sticky pin on the ring. Future fix: introduce **publisher ownership /
  phase priority / non-downgrade semantics** for handoff phases so a once-reached `release_ready`
  cannot be downgraded by a lower-priority publisher mid-hold.
- **Generalization.** Exercise this flow on 2–3 other HV-prone sites to confirm it works beyond B&BW
  before claiming broader coverage.
- **Tuning telemetry.** Consider adding a bucketed `hold_elapsed_bucket` telemetry signal for future
  hold-latency tuning.
- **Dataset / detector.** Keep growing the visual-classifier dataset and the release-ready detector
  with more real captures.

---

## Related docs

- `docs/VISUAL_GESTURE_CAPSULE_DESIGN.md` — the VGC design.
- `docs/antigen-hv-visual-judgment-progress.md` — HV visual-judgment pipeline progress.
- `docs/antigen-vision-blocker-classifier.md` / `docs/visual-blocker-classifier-pipeline.md` —
  visual blocker classifier direction.
- `docs/HV_OOPIF_WALL_DETECTION_SUMMARY.md` — cross-origin (OOPIF) wall detection.
