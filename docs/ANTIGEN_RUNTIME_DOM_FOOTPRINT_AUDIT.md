# Antigen Runtime DOM Footprint Audit

**Status:** Documentation only. No runtime changes were made for this audit.
**Scope:** Antigen's own runtime DOM footprint during browsing and actions. This is **not**
an analysis of any website's anti-bot internals, and no structural diagnostics were run
against any live site. Findings are from source review of `apps/api/src/runtime/` plus
controlled local reasoning.

---

## 1. Executive Summary

- **Browsing is read-only.** `antigen_snapshot`, ref generation, active surfaces, human-
  verification (HV) detection, and the post-click / post-fill probes only **read** the DOM.
  Across the snapshot, surface-resolution, and click/fill-verification paths there are **zero**
  DOM-write calls (`setAttribute`, `appendChild`, `createElement`, `.style.`, `scrollIntoView`,
  `.focus(`, `dispatchEvent`). They use `querySelectorAll`, `getAttribute`,
  `getBoundingClientRect`, `getComputedStyle`, and `textContent` only (plus `.value` for
  button/submit captions).
- **Refs are server/runtime-side only.** Opaque handles (`ag_1`, `ag_2`, …) are in-memory
  records in `antigenSnapshotStore.ts`. **No `data-antigen-ref` is ever written to the DOM** —
  the page is never tagged with ref identifiers.
- **DOM mutations occur only during intended work.** Writes and dispatched events happen only
  during (a) explicit user/intended actions (click, type, set_value, scroll), (b) sensitive
  fills (credential / payment / profile), (c) screenshot redaction (temporary overlay, removed
  after capture), or (d) debug / headed-mode overlays. Action input is dispatched via CDP
  `Input.*` native events, not synthetic `dispatchEvent`.
- **Two real footprint issues remain.** (1) Persistent fill markers — most broadly
  `data-antigen-fill-id`, written to **every** visible form field during profile-fill
  enumeration and never removed; also `data-antigen-filled` / `data-antigen-masked` persist
  after fills. (2) Visible/headed-mode debug overlays and the navigation-mediation banner are
  injected into the page automatically when `session.mode === "visible"`, not only behind an
  explicit env flag.

---

## 2. Audit Table

| Code path (file · function) | Reads DOM? | Writes/mutates DOM? | Triggers events? | Forces layout? | Risk | Recommended follow-up |
|---|---|---|---|---|---|---|
| `antigenSnapshotRuntime.ts` · snapshot extraction IIFE | Yes (read-only APIs) | No | No | Yes (read-only) | none | — |
| `antigenSnapshotStore.ts` · ref generation | n/a (server-side) | No — in-memory mapping; no `data-antigen-ref` | No | No | none | — |
| `antigenSurfaceResolution.ts` · active surfaces / surface resolve | Yes (`elementFromPoint`, rects, names) | No | No | Yes (hit-test reads) | none | — |
| `antigenSnapshotRuntime.ts` · `buildOverlaySnippetJs` / HV detection | Yes (structural) | No | No | Yes (read-only) | none | — |
| `humanPresenceRelay.ts` · `buildHumanVerificationProbeExpr` | Yes | No | No | Yes (read-only) | none | — |
| `humanPresenceRelay.ts` · HV relay (press-and-hold) | Yes (probe) | No DOM writes | Yes — CDP `Input.*` pointer events | No | low (intended, opt-in flag) | — |
| `antigenClickVerification.ts` · post-click probe | Yes (counts/hashes, button captions) | No | No | Yes (read-only) | none | — |
| `postFillProbe.ts` · post-fill probe | Yes (marker counts; never `.value`) | No | No | Yes (read-only) | none | — |
| `realisticBrowserActions.ts` · `browser_click` | Yes (find) | No DOM writes | Yes — CDP pointer events | Yes (find) | low (intended) | — |
| `realisticBrowserActions.ts` · `browser_type` | Yes | Native-setter clear before typing | Yes — CDP keys + focus/input/change/blur; incidental `scrollIntoView` | Yes | low | optional: drop incidental scroll |
| `realisticBrowserActions.ts` · `set_value` / `fill` / `clear` | Yes (skip-check, read-back) | Native setter / selectedIndex / innerText | input+change **only when changed**; skips events when current == requested | Yes | none/low | — |
| `realisticBrowserActions.ts` · `scroll_to_ref` | Yes (viewport/scrollHeight) | `window.scrollTo` | Native `scroll` only | Minimal | none/low | — |
| `secretInjection.ts` · credential injection | Yes (length-only verify) | Native fill; `.value` getter mask; `data-antigen-filled` | CDP keys + focus/input/change/blur | Yes | medium (intended; marker persists) | Follow-up 3 |
| `protectedRealisticFill.ts` · protected fill primitive | Yes | Native fill; getter mask; visual mask; `data-antigen-masked`/`-field`/`-filled` | CDP pointer+keys; focus/input/change/blur | Yes | medium (intended; markers persist) | Follow-up 3 |
| `paymentCardFill.ts` / `paymentIframeFill.ts` · card fill | Yes | Same as protected fill (+ OPPWA iframe path) | Same | Yes | medium | Follow-up 3 |
| `profileFieldFill.ts` · enumerate + fill | Yes (all fields, metadata only) | `data-antigen-fill-id` on **every** field (never removed); `data-antigen-filled` | input/change/focus/blur; CDP typing | Yes | medium-high | **Follow-up 2** |
| `screenshotRedaction.ts` · redaction | Yes | Temporary overlay layer (removed post-capture); re-marks `data-antigen-*`; PNG pixel blackout | No | Yes | low | Follow-up 3 |
| `nativePointerRuntime.ts` · pointer debug overlays + nav banner | No | DEBUG/HEADED only: dot/trail/SVG/banner; auto-removed 1.5–8s | No | Yes | low | **Follow-up 1** |

---

## 3. Important Clarification

- **Profile-fill markers are a real hardening issue, but they did not cause the early B&BW
  challenge.** Profile field fill was **not** exercised during that flow, so the persistent
  `data-antigen-fill-id` / `data-antigen-filled` attributes were not present on the page at the
  time the challenge appeared. Treat this as footprint hardening, not as the root cause of that
  event.
- **Visible-mode debug overlays / nav-mediation banner may be relevant to B&BW.** The live QA
  sessions run in **visible/headed mode**, and in that mode the pointer debug overlays and the
  "Antigen is mediating this browser" navigation banner are injected into the page
  automatically (via `session.mode === "visible"`), independent of the explicit
  `ANTIGEN_POINTER_DEBUG_OVERLAY` env flag. These are real DOM nodes present (though
  auto-removed) during the session and are the more plausible footprint to scrutinize for that
  flow.

---

## 4. Recommended Follow-Up Backlog

> Not implemented in this thread. Listed for prioritization only.

- **Follow-up 1 — Gate debug overlays behind an explicit flag.** Make pointer debug overlays
  and the navigation-mediation banner activate **only** under `ANTIGEN_POINTER_DEBUG_OVERLAY`
  (or an equivalent explicit flag), not automatically when `session.mode === "visible"`. This
  removes injected DOM nodes from normal headed QA runs.
- **Follow-up 2 — Clean up `data-antigen-fill-id` markers.** After the target profile field is
  resolved, remove `data-antigen-fill-id` from all enumerated candidates (or scope it to the
  resolved element and clear it on completion). Eliminates marker spray across fields the agent
  never filled.
- **Follow-up 3 — Review `data-antigen-filled` / `data-antigen-masked` persistence carefully.**
  `screenshotRedaction.ts` depends on `data-antigen-masked` to locate redaction regions, so
  these cannot be blindly removed. Design a lifecycle that scopes them to fields actually acted
  on and clears them after the final redacted screenshot.
- **Follow-up 4 — Add read-only regression tests for browsing paths.** Assert that the snapshot,
  surface-resolution, and verification paths contain no DOM-write calls (e.g. a guard test over
  the IIFE source / a fixture-based check that no `data-antigen-*` attributes appear after a
  pure snapshot), so future changes can't silently make browsing mutate the page.

---

## Appendix — Evidence Notes

- Read-only proof: grepping `antigenSnapshotRuntime.ts`, `antigenSurfaceResolution.ts`, and
  `antigenClickVerification.ts` for `setAttribute|appendChild|createElement|.style.|innerHTML|
  scrollIntoView|.focus(|dispatchEvent` returns no matches.
- Marker inventory: all `setAttribute('data-antigen-*')` writes live in `profileFieldFill.ts`,
  `protectedRealisticFill.ts`, `secretInjection.ts`, `paymentIframeFill.ts`, and
  `screenshotRedaction.ts` — none in browsing paths.
- `data-antigen-fill-id` is written at `profileFieldFill.ts:632`; no `removeAttribute` exists in
  that file (or runtime) to clear it.
- Idempotent fill: `setFieldValueKnownBox` returns `changed:false` and dispatches no events when
  the current value already equals the requested value.
