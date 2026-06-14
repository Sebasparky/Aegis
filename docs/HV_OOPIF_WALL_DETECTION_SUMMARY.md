# Human-Verification Wall Detection — OOPIF / No-Text Path

Final implementation summary for this patch.

## What this patch adds

A **text-independent OOPIF path** to page-level human-verification (HV) wall
detection, so the live Bath & Body Works "Press & Hold" popup shape — where the
challenge text *and* control render inside a cross-origin iframe and the top
document carries no HV language — is classified as a blocking, page-level HV
surface. The detector now fails closed on a wall it cannot read the text of,
rather than treating the page as ordinary and letting an agent interact with it.

Detection stays **flag-gated** behind `ANTIGEN_HUMAN_VERIFICATION`; with the flag
off the path is byte-identical to before (returns `null`, emits no hint).

## Exact detection condition

Classification is a pure, browser-free decision in
`classifyPageWallSignals(value, oopifTargetSeen)`
(`apps/api/src/runtime/antigenSnapshotRuntime.ts`), evaluated as two paths:

**TEXT path (pre-existing).** Fires when the page IIFE reports
`text_classified === true` (strong top-document HV text + an inaccessible
iframe). Honors the page's challenge-type enum, so it can report
`press_and_hold`.

**OOPIF path (new) — STRICT, text-independent.** Fires only when all of:

```
visible_iframe_seen
  && inaccessible_iframe_seen
  && oopifTargetSeen            // a real OOPIF child target, observed browser-wide
                               // via CDP Target.getTargets
  && (fixed_overlay_seen || click_intercept_overlay_seen)
```

The `oopifTargetSeen` flag is **corroborating-only**: it can never classify on
its own. A stray OOPIF elsewhere on the page cannot trigger detection without the
co-present inaccessible visible iframe **and** a blocking overlay
(a fixed ≥0.5-coverage backdrop or a center click-intercept). On a match the
verdict is `{ human_verification: true, page_level: true, blocking: true,
user_presence_required: true, hv_challenge_type: "unknown_human_verification" }`.

A cheap in-bundle `hvWallHint` (strong HV text *or* the OOPIF shape: inaccessible
iframe + blocking overlay) gates the confirming probe so the page-level probe is
only run when the element count is low or the hint fires — it never runs on every
snapshot.

## Why `hv_challenge_type` is `unknown_human_verification` on the OOPIF path

The challenge text and control live inside a **cross-origin** iframe, so the top
document has no readable HV language and the iframe body is unreadable by policy
(we never read cross-origin iframe text). Because the patch cannot read the
challenge text, it must not *assert* what kind of challenge it is — claiming
`press_and_hold` for text it cannot see would be a fabricated classification.
The conservative `unknown_human_verification` records "this is a blocking
human-verification wall requiring human presence" without overstating the
specific mechanism. The TEXT path, which *can* read top-document hold language,
is the only path that returns `press_and_hold`.

## Tests passed

**Mac real-Chromium integration suite — 20/20**
(`human-verification-detection.integration.test.ts`), including:

- OOPIF no-text wall → `page_level`, `blocking`, `user_presence_required`,
  `hv_challenge_type = unknown_human_verification`
- Flag-OFF byte-identical: OOPIF wall and overlay wall not classified, no hint
- Negative: visible iframe with no blocking overlay
  (`ecommerce-marketing-iframe`) → not classified, even with the flag on
- Cross-origin denial wall / overlay-wall-preserved-background → page-level
  `press_and_hold`; per-element press-and-hold and checkbox modals; promo /
  split-promo strong-phrase negatives; live mirrored-hold relay clears the
  fixture challenge while an early release does not

**Sandbox (Linux) suites — 144/144** across:

- `antigen-browser-snapshot-endpoint.test.ts` — 40 (incl. `human_verification_debug`
  gating: absent unless **both** `ANTIGEN_HUMAN_VERIFICATION` and
  `ANTIGEN_HV_DEBUG` are on; whitelisted boolean/enum keys only; no leak of
  box / `cdp_url` / port / secrets)
- `human-verification-lifecycle.test.ts` — 22 (the `409 HUMAN_VERIFICATION_REQUIRED`
  guard: click / type / set-value / scroll rejected after wall detection)
- `antigen-browser-click-endpoint.test.ts` — 48
- `antigen-active-surfaces.test.ts` — 15
- `runtime-status.test.ts` — 10
- `human-verification-surfaces.test.ts` — 9

(The integration suite is gated to skip cleanly where Chromium is unavailable;
it could not run in the Linux sandbox due to missing system libraries, which is
why it was validated on the Mac.)

## Live-site QA policy

- **No structural debug, recon, or characterization** against third-party
  anti-bot challenges (e.g. B&BW Press & Hold). No snapshotting a live challenge
  to dump `would_classify_oopif`, iframe shape, or `human_verification_debug`.
- **Controlled fixtures are the only proof surface** for the detector. They are
  loaded as `file://` resources by the integration harness (no fixture HTTP
  server); the OOPIF case uses the harness's own cross-site origin server to
  spawn a real OOPIF child target.
- **Live sites are black-box canaries only:** pass/fail on whether the runtime
  *stops* and routes to human-presence relay — a binary stop / no-stop signal,
  with no structural output.
- Live B&BW **structural/debug testing is discontinued**. Future live-site
  checks, if any, are black-box canaries only: stop/no-stop behavior with no
  debug telemetry, no challenge characterization, and no attempts to trigger or
  solve the challenge.

## Remaining follow-up

- **Startup logging for `ANTIGEN_HV_DEBUG`.** Emit a single boot-time line
  recording whether HV debug telemetry is enabled (value-free), so a debug run is
  self-evident from logs without inspecting env. Keep it metadata-only — never
  log challenge text, URLs, selectors, or refs.
- **Relay / marker-clearing polish.** Tighten hold-session marker cleanup
  (`hv_control` marker and hold-session teardown) so a cleared challenge leaves no
  residual markers, and confirm heartbeat/end-of-hold transitions release cleanly
  on the released path.
