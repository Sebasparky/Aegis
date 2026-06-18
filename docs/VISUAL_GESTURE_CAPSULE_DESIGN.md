# Visual Gesture Capsule (Visual User Presence Relay) — Design

> Status: **Design / not yet implemented.** This document is the reviewed design
> for a second, first-class user-presence path. No runtime, endpoint, UI, type,
> or test code exists for it yet. Existing files referenced below are **reuse
> targets for a future step**, not files to edit now.

---

## 1. Problem statement

Antigen's **Human Presence Relay v1** (`ANTIGEN_HUMAN_VERIFICATION`, committed
`4156d1d`) pauses the agent on a human-verification (HV) wall, then relays the
user's live press-and-hold / checkbox gesture into the paused browser session via
CDP. It locates the challenge control by probing the **page DOM** and returns a
`control_box` (a bounding box for the press-and-hold button or checkbox). The
relay's coordinate source is that `control_box`.

This works whenever the control is part of the host document's DOM. It does **not**
work for the live failure we hit on Bath & Body Works:

- The wall is a **page-level challenge rendered inside a cross-origin iframe /
  out-of-process iframe (OOPIF)** — e.g. a PerimeterX / HUMAN "Before we continue
  / Press & Hold / Access to this page has been denied" card.
- The browser **composites and displays** the challenge (the pixels are right
  there on screen), but the **host page DOM cannot read it** because of the
  Same-Origin Policy. `querySelectorAll`, `textContent`, accessibility-tree refs,
  and `antigen_snapshot` refs do not see the challenge text or the control.
- As a result the DOM probe returns **`control_box == null`**, and Human Presence
  Relay v1 correctly degrades to **`manual_user_completion`** — the user is told
  to go complete the challenge directly in the browser. That is safe but a poor
  experience and breaks the "unblock from your phone" promise.

The gap is specific and narrow: **a wall that is visually obvious but structurally
invisible to the host DOM.** We need a coordinate source that does not depend on
the host DOM.

References (existing, for orientation only):
`apps/api/src/runtime/humanPresenceRelay.ts` (DOM relay + `control_box`),
`apps/api/src/runtime/antigenSnapshotRuntime.ts` (overlay/wall probes),
`apps/api/src/lib/humanVerificationLifecycle.ts` (HV request lifecycle),
`apps/api/src/runtime/humanVerificationState.ts` (pause marker).

---

## 2. Product principle

- **Antigen is not solving CAPTCHA.** There is no automated solver, no provider
  internals, no postMessage/token interception, no reusable bypass strategy.
- **Antigen relays fresh user presence** into a paused browser session. A real
  human looks at the actual challenge and performs the actual gesture; Antigen
  only transports that one gesture to the right pixel.
- **The agent stays paused** for the entire handoff and **never receives** the
  screenshot, the coordinates, the gesture payload, or any strategy. It sees only
  status + guidance, exactly as with the existing HV pause.
- **The gesture is single-use, session-bound, short-lived, audited, and
  discarded.** It is recorded as user presence (UAR + grant), tied to one
  challenge on one session, expires quickly, and the screenshot + mapped
  coordinates are deleted after use.
- **Honest boundary:** relayed input may be rejected by the provider. Antigen
  never claims it can always clear a wall; it provides a clean manual fallback.

This inherits Aegis's standing invariants: user presence required and recorded;
agent constrained; no raw secrets/coordinates/screenshots in agent-facing
responses; sensitive surfaces fail closed.

---

## 3. Two explicit user-presence paths

These are disjoint and chosen by whether the DOM can locate a control.

| | **DOM Human Presence Relay** (existing) | **Visual Gesture Capsule** (new) |
|---|---|---|
| Trigger | DOM-visible control found (`control_box` set) | Page-level opaque wall: cross-origin iframe / OOPIF / DOM cannot locate control (`control_box == null`) |
| Coordinate source | `control_box` from the page DOM probe | User gesture on a screenshot, mapped to CSS viewport coordinates |
| Status | Unchanged by this work | New, first-class path |
| UX | User holds/clicks an abstract control in the Aegis UI; relay mirrors to `control_box` | User points/presses on the actual screenshot of the wall in the Aegis UI |

The Visual Gesture Capsule is a **standalone first-class visual path**, not a
fallback bolted onto `control_box`. It must not inherit any DOM-control
assumption. The existing DOM relay remains entirely unchanged.

---

## 4. Why not OCR / vision or WebRTC first

- **OCR / vision detection** costs compute and tokens (often per-attempt), and
  after spending that it still has to *decide where to click* — re-introducing
  exactly the automated-decision risk we want to avoid. The human already
  recognizes a Press & Hold card instantly; making a model re-derive it is
  wasteful and weaker.
- **WebRTC / live remote control / VNC** is much heavier infrastructure
  (streaming, input channels, session security) and a separate product surface.
- **Visual Gesture Capsule** is deliberately lightweight: **one screenshot + one
  user gesture payload.** Very low bandwidth, no model loop, and it keeps the
  trust story clean — the *user* visually recognizes the target and supplies the
  presence, which is the entire point.

OCR and remote control may have a place later (e.g. richer fallback), but the
capsule is the right first version.

---

## 5. Architecture

- **Feature flag:** `ANTIGEN_VISUAL_GESTURE_CAPSULE` (default **off**,
  byte-identical behavior when off — mirror `isHumanVerificationEnabled()` in
  `apps/api/src/runtime/humanVerificationState.ts`).
- **New state object:** `VisualGestureCapsule` (type + status machine, see §9),
  owning the screenshot + gesture lifecycle for one opaque-wall handoff.
- **Memory-only screenshot store:** screenshot bytes + capture metadata live in an
  in-memory Map, never persisted, never logged, never in any agent response,
  deleted on clear / recapture / expiry / cancel. Mirror the discipline of
  `apps/api/src/runtime/challengeInjection.ts` (`challengeCodes`).
- **Internal UI endpoints only.** No new agent-facing MCP tools. The agent stays
  on the existing HV pause guard + status poll.
- **Reuse existing primitives** (compose, don't duplicate):
  - **UAR + grant** audit model — record the gesture as
    `human_presence_verification` user approval + sensitive grant.
  - **Pause / resume guard** — the existing HV active marker
    (`setActiveHumanVerification` / `clearActiveHumanVerification`) and the
    `HUMAN_VERIFICATION_REQUIRED` 409 guard, which key off the marker, **not**
    `control_box`. The capsule is anchored to a `HumanVerificationRequest`
    (which already supports a `page_level` wall and does not require a control).
  - **Fail-closed hold / heartbeat** semantics from `humanPresenceRelay.ts`
    (`HOLD_FAIL_CLOSED_MS`, `HOLD_MAX_DURATION_MS`, heartbeat re-arm) for
    `press_hold`.
  - **Screenshot redaction / capture** pipeline
    (`apps/api/src/runtime/screenshotRedaction.ts`, CDP `Page.captureScreenshot` +
    `pngjs` fail-closed pixel pass) — viewport-only capture.
  - **CDP pointer primitives** (`apps/api/src/runtime/nativePointerRuntime.ts`:
    realistic path / press / release / click) and target/endpoint resolution
    (`cdpTargetSelection.ts`, `cdpEndpointResolver.ts`).
  - **Ref invalidation on resume** — `markHumanVerificationCompleted` already
    invalidates `ag_*` refs and clears the marker.
- **The single seam in existing code (future step):** the press/click primitives
  must accept an **explicit point** instead of a DOM-probe `control_box`, so the
  capsule can supply mapped coordinates. The DOM relay path keeps using
  `control_box` unchanged.
- **Endpoint pattern** to follow: `apps/api/src/routes/security-challenges.ts`
  (lazy expiry, terminal-status filtering, safe view). **UI pattern** to follow:
  `apps/web/src/app/route-run-approvals/page.tsx` (`PendingChallengeCard`, 8s
  auto-refresh).

---

## 6. Coordinate mapping contract

The UI does not send raw pixel coordinates; it sends **normalized fractions**.

- The UI renders the screenshot with **aspect preserved** (letterbox if needed).
  The gesture surface is **only the image content area**, never the padded element
  box.
- For each gesture point the UI sends `fx, fy ∈ [0, 1]` relative to the image
  content area's top-left.
- The server maps to **CSS viewport coordinates** using the viewport size captured
  alongside the screenshot:

  ```
  cssX = clamp01(fx) * viewport_css_width
  cssY = clamp01(fy) * viewport_css_height
  ```

- **deviceScaleFactor is not needed.** CDP `Input.dispatchMouseEvent` uses CSS
  pixels, and a **viewport-only** screenshot shares the live viewport's top-left
  origin, so `(cssX, cssY)` addresses the same pixel the user pointed at — even
  though the PNG's physical pixel dimensions are `viewport_css * deviceScaleFactor`.
- Fractions outside `[0,1]` are clamped or rejected. The capsule stores
  `viewport_css_width` / `viewport_css_height` (read at capture time via
  `window.innerWidth` / `window.innerHeight`); the PNG's pixel dimensions are used
  only for display, never for mapping.

This contract keeps all geometry on the server and means the agent never sees
coordinates in any form.

---

## 7. Gesture scope (v1)

Supported in v1:

- **`tap`** — single click/tap (checkbox-style "I'm not a robot" walls).
- **`press_hold`** — press and hold in place for a user-controlled duration
  (PerimeterX / B&BW "Press & Hold"). Duration is user-driven via heartbeat;
  fail-closed release reuses the existing hold timers.

Deferred (not in v1; the type/API should remain extensible to add them later):

- drag / slide-to-verify sliders
- puzzle piece movement
- image grids ("select all squares with…")
- any multi-step challenge where the page changes mid-challenge

---

## 8. Retry / fallback policy (v1)

- **Max 2 gesture attempts** per handoff.
- If the relayed gesture does **not** clear the wall, **recapture** a fresh
  screenshot and let the user **retry** (within the 2-attempt budget).
- After attempts are exhausted, enter **`manual_fallback`**: keep the agent
  paused and instruct the user to complete the verification **in the open, visible
  browser window**. Antigen then re-runs the same cleared-state check; on clear it
  resumes the agent.
- **No WebRTC / VNC / remote-control fallback in v1.** Remote control is a
  separate, heavier product surface; v1 proves the lightweight capsule path first
  and degrades to a safe manual completion.

---

## 9. State machine

```
                         recapture (attempts remain)
                        ┌──────────────────────────────┐
                        ▼                               │
 [create] ─► awaiting_user_gesture ─► relaying ─► checking
                        ▲                               │
                        │                     ┌─────────┴──────────┐
                        │                     ▼                    ▼
                        └──── rejected_retryable               cleared (terminal)
                                  │
                       attempts exhausted
                                  ▼
                            manual_fallback ──(recheck: clear)──► cleared (terminal)

 Any non-terminal state ─► expired | failed | cancelled   (terminal)
```

States:

- `awaiting_user_gesture` — screenshot captured and shown; waiting for the user.
- `relaying` — mapped gesture being dispatched via CDP.
- `checking` — post-gesture cleared-state probe running.
- `cleared` — wall gone; resume the agent (terminal). Triggers
  `markHumanVerificationCompleted` (ref invalidation + UAR/grant).
- `rejected_retryable` — wall still present and attempts remain → recapture.
- `manual_fallback` — attempts exhausted; user finishes in the visible browser.
- `expired` / `failed` / `cancelled` — terminal. (`failed` includes capture
  failure, e.g. headless box where `Page.captureScreenshot` is unavailable.)

Lifecycle properties: capsule TTL aligned with the HV TTL (~3 min,
`HUMAN_VERIFICATION_TTL_MS`); per-screenshot freshness window; lazy expiry at read
time deletes screenshot bytes; single-use (a `cleared` state is terminal and the
screenshot is consumed); session/domain/HV-request bound.

---

## 10. Implementation milestones

- **M1 — Backend capsule loop (first).** Types, capsule store + lifecycle helpers,
  internal endpoints, coordinate mapping, `tap` + `press_hold` relay via the
  point-explicit seam, safe views — all behind `ANTIGEN_VISUAL_GESTURE_CAPSULE`.
  Prove the full loop end-to-end on a **synthetic fixture** in a **headed**
  session. No UI; driven via internal endpoints in tests.
- **M2 — Web UI card.** New card in `route-run-approvals` (image + transparent
  gesture layer, emits normalized fractions + heartbeat for holds, 8s poll, retry,
  manual-fallback messaging, cancel) plus web API client functions.
- **M3 — Live B&BW headed trial + runbook.** Run against the real wall in a
  visible session; record results; tune detection and fallback. Treat provider
  acceptance of relayed input as an **open empirical question**, not a guarantee.

---

## 11. Test plan

- **Coordinate mapping unit tests** — `fx/fy` → CSS viewport; clamping; aspect /
  letterbox cases; PNG physical pixels irrelevant to mapping.
- **Capsule state-machine tests** — `awaiting_user_gesture → relaying → checking →
  cleared`; `rejected_retryable` with ≤2 retries; `manual_fallback`; expiry;
  cancel; single-use (consumed screenshot, terminal `cleared`).
- **Safe-view tests** — no agent-facing response contains screenshot bytes,
  coordinates, or fractions; literal `false` for `raw_gesture_revealed_to_agent`
  and `screenshot_revealed_to_agent`.
- **Synthetic fixtures** — local HTML "Press & Hold" and "checkbox" walls that
  clear on a correct press (≥ duration) / click (right box); assert the mapped CDP
  relay lands and clears the wall, refs invalidate, agent resumes via re-snapshot.
- **Cross-origin-iframe-like fixture** — a wall whose control lives in a separate
  origin/iframe, to validate the opaque-DOM case (DOM probe returns no control,
  but the screenshot shows it and the relayed gesture clears it).
- **Headed capture test** — real-Chromium capture that **self-skips** when
  `Page.captureScreenshot` is unavailable (mirror
  `apps/api/src/__tests__/screenshot-redaction.test.ts`).
- **Flag-off** — with `ANTIGEN_VISUAL_GESTURE_CAPSULE` off, behavior is
  byte-identical; no capsule created, no capture, existing HV relay unchanged.

---

## 12. Risks / open questions

- **Provider acceptance (central risk).** `Input.dispatchMouseEvent` produces
  `isTrusted` events and the compositor hit-tests them through to the OOPIF, so
  geometry should work — but PerimeterX/HUMAN-class detectors also score
  `navigator.webdriver`, CDP presence, and trajectory/timing entropy, and may
  reject relayed input. The realistic pointer path helps but **acceptance is not
  guaranteed**; this is why the manual fallback (§8) is mandatory and why we make
  **no bypass claims**.
- **Headless capture unreliable on this box.** `Page.captureScreenshot` hangs in
  some headless environments (the existing redaction test self-skips). v1
  **requires a headed/visible session**; capture failure → capsule `failed` →
  manual fallback.
- **Static screenshot can't show live progress.** A Press & Hold bar fills over
  time; the user holds against a still image and cannot see progress. v1 relies on
  the user-controlled hold duration + post-release probe; the UI should set
  expectations (and the recapture retry covers under/over-holds).
- **Stale screenshot / freshness.** The page can change while the user responds.
  Before each relay, re-resolve the live target and re-probe; if the URL changed
  or the wall is gone, invalidate the screenshot and force a recapture (or resolve
  as cleared/cancelled) rather than replaying against a changed page.
- **Single-use / replay protection.** Screenshot + mapped coordinates are
  memory-only and deleted after relay; `cleared` is terminal; gesture endpoints
  require the authenticated user session (never the agent token); coordinates are
  never returned anywhere; capsule is bound to one HV request + session + domain
  with a short TTL.
- **Touch vs mouse.** Only mouse events exist today (no `Input.dispatchTouchEvent`).
  v1 relays mouse events; whether some challenges require touch is an open question
  for a later step.
