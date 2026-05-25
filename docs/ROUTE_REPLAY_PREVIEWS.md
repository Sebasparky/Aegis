# Route Replay Previews — Doctrine and Architecture

## 1. Purpose

Route Replay Previews are **trust artifacts** for the Aegis/Antigen skills marketplace. They exist to answer a single question before a user installs or runs a skill: *what does this workflow actually do?*

A trust layer that shows decorative thumbnails is not a trust layer. Users and websites need workflow proof — a verifiable, inspectable record of the actual steps a skill executes. Route Replay Previews provide that proof in the most legible form: a cached, smooth replay of the real workflow captured in a controlled Playwright session under Aegis's own safety policy.

Replay artifacts are tied to a specific route version. They become part of the skill's evidence record alongside verification reports, run receipts, and trust tier assessments.

---

## 2. Product Principle

> **Compiled workflow replay, not live hover execution.**

The marketplace must show workflow proof, not decorative previews.

This means:
- The preview is generated once, ahead of time, under controlled conditions.
- It is stored as a cached artifact tied to the route and its version.
- It plays back on hover from the cached artifact — no browser is launched, no network request goes to the target site, no credentials are touched.
- The experience feels live because the artifact is a real recording of the real workflow, not a simulation.

Static screenshots, JSX-rendered fake pages, and text overlays are not workflow proof. They do not show what a skill does. They show what someone claimed it does. Route Replay Previews close that gap.

---

## 3. User Experience

### Resting card state
The card shows a **poster frame** — the first frame of the captured replay, which is the start page of the route. For Wikipedia Search, this is the Wikipedia main page. The poster is a real screenshot from the actual site, not a mock.

### Hover state
Hovering the card plays the **muted cached replay** from the beginning. The replay shows the actual browser workflow: page load, field fills, clicks, navigation, and the final result state. It does not execute live. It does not contact the target site. It is the cached artifact played back at the card's native size.

### Click — modal state
Clicking opens a **larger replay modal** with:
- The replay video at higher resolution or in a larger viewport
- A step timeline alongside the video: each route step listed with its order, action type, and safe description, highlighting the active step as the video plays
- Safety notes for the skill: trust tier, execution mode, approval gates, and risk level
- For sensitive routes: an explicit stop marker in the timeline and a note explaining where and why the replay ends

### Sensitive routes
Routes with irreversible or high-risk steps (payment, login, account deletion, form submission) show a **partial replay** up to the last safe step, then display an explicit stop marker: "Replay stops before sensitive action." The card never plays the sensitive portion. The modal shows the full step list including the blocked steps, clearly marked.

---

## 4. Architecture

```
Route created / edited
    │
    └─► Route hash / version updated → replay invalidated
            │
            └─► On: route verified | submitted for review | explicit capture request
                        │
                        ▼
                  Replay Capture Pipeline
                  (disposable Playwright context, Aegis safety policy)
                        │
                        ▼
                  RouteReplayAsset stored
                  (poster_frame + replay_video, tied to route_id + route_hash)
                        │
                        ▼
                  Marketplace reads cached asset
                  (no browser launched on hover — asset served statically)
```

**Key invariants:**

- A route change (steps, value policies, locators, metadata) invalidates the current replay and marks it `invalidated_at`.
- Replay capture is triggered explicitly: on route verification, marketplace submission, or a manual capture request. It is not triggered on every save.
- The marketplace consumes the cached asset. There is no browser execution on hover, no WebSocket connection, no CDP session, no live page load.
- Replay artifacts are versioned by `route_hash`. If a route reverts to a previously captured version, the prior asset may be reused if still valid.

---

## 5. Asset Model

### Proposed type: `RouteReplayAsset`

```typescript
interface RouteReplayAsset {
  asset_id: string;             // e.g. "rra_..."
  route_id: string;
  route_hash: string;           // hash of the route's compiled step sequence
  kind: "replay_video" | "poster_frame" | "step_frame";
  url_path: string;             // served via strict static asset endpoint
  poster_url_path?: string;     // companion poster frame for video assets
  captured_at: string;          // ISO 8601
  duration_ms?: number;         // for replay_video
  width?: number;
  height?: number;
  redaction_applied: boolean;
  source: "verification_replay" | "manual_capture" | "dev_seed";
  replay_safety: "full" | "partial" | "static_only";
  // full: all steps captured
  // partial: capture stopped before sensitive step; stop_reason explains where
  stop_reason?: string;         // human-readable: "Stopped before: payment confirmation"
  invalidated_at?: string;      // set when route changes after capture
  failure_reason?: string;      // set if capture failed
}
```

### Relationship to `RoutePreviewAsset`

The existing `RoutePreviewAsset` type (`kind: "start_page" | "step_frame"`) captures static screenshots. `RouteReplayAsset` captures full motion replay artifacts and their companion poster frames.

These two types can **coexist** in v1: `RoutePreviewAsset` continues to serve static start-page screenshots for routes that have not yet generated a full replay. `RouteReplayAsset` is the richer, authoritative artifact once generated. When a `RouteReplayAsset` with `kind: "replay_video"` is available for a route, the UI should prefer it over the static `RoutePreviewAsset`.

Long-term, `RoutePreviewAsset` may be subsumed by `RouteReplayAsset` as the unified asset model.

---

## 6. Capture Pipeline

The capture pipeline runs in a **disposable Playwright Chromium context** under Aegis's own safety policy. It is not the agent's browser. It is not a production CDP session. It produces no audit trail entries, no receipts, no collar enforcement — it is a controlled preview generation process.

Steps:

1. **Launch disposable context** — fresh ephemeral Chromium profile, no saved credentials, no cookies, no extensions.
2. **Apply redaction policy** — before recording begins, configure the context to redact sensitive field content: password inputs are not filled with real values (fill with placeholder or skip), credit card fields are not touched, OTP fields are skipped.
3. **Apply safe preview step filter** — walk the route's step list and classify each step: safe (navigate, click non-destructive, read, search), sensitive (fill credential, submit payment, confirm purchase, delete, download), or stop (any irreversible action). Only safe steps execute during capture.
4. **Record** — start Playwright's built-in video recording or equivalent frame capture. Execute safe steps in sequence. For each step, allow the page to settle before proceeding.
5. **Stop before sensitive actions** — when the step classifier encounters a sensitive step, stop recording. Mark the asset `replay_safety: "partial"` and set `stop_reason`.
6. **Capture poster frame** — take a screenshot of the first stable frame (the start page) as the `poster_frame` asset.
7. **Save artifacts** — write the video file and poster PNG to `PREVIEW_DIR`. Store `RouteReplayAsset` metadata on the route.
8. **Serve via strict static asset endpoint** — the existing `GET /api/route-preview-assets/:filename` pattern, extended to serve video files with appropriate content type and cache headers. Path traversal validation applies identically.

The pipeline never:
- Injects real credentials
- Contacts KMS or the vault
- Opens an approval gate
- Writes a run receipt
- Executes in a collar-bound session

---

## 7. Safety Policy

These are hard rules for the capture pipeline. They are not configurable per route.

**Never execute during capture:**
- Purchase submission or payment confirmation of any kind
- Payment method entry or card number input
- Credential injection (real passwords, secret_ref resolution)
- Login form submission with real credentials
- Bank transfer or financial transaction initiation
- Account creation, account deletion, or account setting changes
- Legal, medical, or financial form submission
- File downloads
- Any destructive or irreversible action
- OAuth grant or external app connection

**Never expose in capture output:**
- CDP URLs, WebSocket handles, or browser session identifiers
- Cookies, localStorage, or auth tokens
- Secrets, encrypted blobs, KMS material, or `secret_ref` values
- Card numbers, CVVs, or payment identifiers
- Pass IDs or vault pass labels
- Raw credential values of any kind
- Government IDs, biometric data, or identity documents
- Provider API payloads or session tokens

Routes whose first sensitive step is step 1 (e.g. a login-only route) produce `replay_safety: "static_only"` — the poster frame is captured but no workflow steps execute.

Routes with at least one safe step before the first sensitive step produce `replay_safety: "partial"`.

Routes with no sensitive steps produce `replay_safety: "full"`.

---

## 8. Scalability

**One replay per route version, not per user install.** A public skill installed by 10,000 users generates one replay artifact, not 10,000. Capture cost is amortized across all marketplace installs.

**Generation triggers are explicit.** Replay capture runs on route verification, marketplace submission, or an explicit operator/developer request. It does not run on every route save or every draft edit. Draft routes without a captured replay show the static poster or "capture pending" state.

**Compression.** Replay video is compressed aggressively. Target: under 2MB for a typical 10-step workflow at 1280×800. Prefer WebM/VP9 or similar efficient formats. Drop frame rate for lower-action sequences.

**Duration and resolution caps.** Maximum replay duration: 60 seconds. Maximum resolution: 1280×800 (the standard Playwright viewport). Maximum steps executed: 20. Longer workflows are truncated at the cap, with `stop_reason` set to "Replay truncated at step limit."

**Storage.** In v1, assets are served from the local `.data/route-previews` directory via the existing static asset endpoint. Object storage (S3, R2, GCS) and CDN distribution are Phase 3 concerns.

**Invalidation.** When a route's step sequence, value policies, or locators change, the current `RouteReplayAsset` is marked `invalidated_at` and the route returns to "capture pending" state for marketplace display. Private draft routes may allow expired replays to display with a staleness indicator rather than forcing immediate recapture.

**Private drafts.** Lower quality (lower resolution, shorter duration, or static-only) is acceptable for private rails. High-quality full replay capture is prioritized for routes submitted for marketplace review.

---

## 9. UX States

| State | Card display | Modal display |
|---|---|---|
| `replay_available` | Poster on rest, video plays on hover | Full replay + step timeline |
| `replay_partial` | Poster on rest, partial video on hover | Partial replay + stop marker in timeline |
| `static_poster_only` | Poster on rest, no motion on hover | Poster + step list, no video |
| `capture_pending` | Fallback (domain + name + steps) | Step list, "Replay generation pending" note |
| `capture_failed` | Fallback | Step list, "Preview capture unavailable" note |
| `sensitive_preview_stopped` | Partial video plays, fades to stop marker | Replay up to stop marker, explicit "Stopped before: [action]" |
| `no_preview_captured` | Fallback with "No captured start page yet." | Step list, invite to trigger capture |

The fallback state (domain + name + step list) is always intentional — it signals "this route exists and has recorded steps, but no replay has been captured yet." It never looks like a broken card.

---

## 10. Initial Implementation Plan

### Phase 1 — Core v1

- Add `RouteReplayAsset` type to `packages/types/src/index.ts`
- Add `POST /api/routes/:routeId/capture-replay` endpoint that runs the capture pipeline and stores a `RouteReplayAsset`
- Implement the Playwright capture pipeline: poster frame + replay video (or frame sequence) for safe routes, partial capture for sensitive routes
- Demonstrate end-to-end with Wikipedia Search: poster + replay showing search field filled with "Michigan", search clicked, Michigan article loaded
- Update `SkillPreviewPane` to render `<video>` on hover when a `replay_video` asset is present (muted, autoplay on hover, poster= the companion poster frame)
- Add click-through to a larger replay modal with step timeline

### Phase 2 — Reliability and safety

- Partial replay support: step classifier marks stop points, pipeline stops cleanly, stop marker rendered in modal timeline
- Replay invalidation by route hash: `invalidated_at` set on route change, UI shows staleness indicator
- Capture queue: multiple capture requests for the same route coalesce into one job
- Compression and retention policy: size limits, auto-expiry for private draft replays

### Phase 3 — Marketplace integration

- Marketplace review workflow integration: replay captured as part of review pipeline, reviewer sees replay before approving
- Signed replay metadata: `replay_jws` covering `asset_id`, `route_hash`, `route_id`, `captured_at`, `replay_safety`, issuer — same pattern as existing signed receipts
- Object storage and CDN distribution for public skills
- Richer step timeline in modal: step-level frame thumbnails, coverage markers, trust evidence links

---

## 11. Acceptance Criteria for v1

- **Wikipedia Search card** hover plays a smooth cached replay of the real workflow: Wikipedia main page → search field filled with "Michigan" → Search clicked → Michigan article loaded.
- The replay is **cached** — no browser launches on hover, no network request goes to wikipedia.org on hover.
- The **poster frame** is the Wikipedia main page and displays on card rest.
- A **larger modal** opens on card click and makes the replay inspectable alongside the step timeline.
- **Sensitive routes** do not replay unsafe actions; a stop marker appears clearly in the timeline.
- No fake preview components, no hardcoded JSX site mocks, and no text overlays presented as the primary replay experience.
- `RouteReplayAsset` type is defined and used consistently.
- TypeScript compilation passes with no errors.
- Existing `RoutePreviewAsset` (static screenshot) behavior is preserved and unbroken.

---

## 12. Non-Goals for This Document

The following are explicitly out of scope for the initial doctrine and Phase 1 implementation:

- Live workflow execution on hover or on install
- Fake preview generation or AI-generated page screenshots
- Production object storage or CDN (Phase 3)
- Automatic replay generation for every draft route
- Any sensitive action execution during replay capture
- Changes to payment, purchase confirmation, credential injection, verification, or runtime browser binding semantics
- Changes to collar enforcement, approval flows, or run receipt issuance
- A/B testing or personalized replay content
- Replay streaming (assets are served as complete files)

---

*This document is the source of truth for Route Replay Preview architecture and product doctrine. Future implementation sessions should reference it to stay aligned on the capture pipeline, safety policy, asset model, and UX state machine.*
