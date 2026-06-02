# Antigen Snapshot — Implementation Plan

Each phase has a clear scope, acceptance criteria, and notes on what must not regress. Phases are designed to be independently shippable.

---

## Phase 0: Documentation (This Increment)

**Goal:** Precisely define the architecture, external contract, internal model, extraction strategy, resolution flows, scoring algorithm, security boundary, and implementation plan before writing any runtime code.

**Files:**
- `docs/antigen-snapshot/README.md`
- `docs/antigen-snapshot/architecture.md`
- `docs/antigen-snapshot/external-contract.md`
- `docs/antigen-snapshot/internal-model.md`
- `docs/antigen-snapshot/extraction-strategy.md`
- `docs/antigen-snapshot/resolution-and-click-flow.md`
- `docs/antigen-snapshot/scoring-and-fallback-resolution.md`
- `docs/antigen-snapshot/security-and-privacy.md`
- `docs/antigen-snapshot/implementation-plan.md`
- `docs/antigen-snapshot/open-questions.md`

**Acceptance:**
- [ ] All 10 files exist
- [ ] Docs define: why Antigen Snapshot exists, external contract, internal model, extraction strategy, resolution flows (primary + fallback), scoring algorithm with signal weights and thresholds, security boundary, and open questions
- [ ] `git diff --stat` shows documentation-only changes (no `.ts`, `.mjs`, `.json`, or config files modified)

**Done:** When this PR is merged.

---

## Phase 1: Scoring Utility Module

**Goal:** Implement `snapshotScoring.ts` as a pure, browser-agnostic module with no CDP or Playwright dependencies. The scoring algorithm must be tested before it is wired into any browser action path.

**Files to create:**
- `apps/api/src/runtime/snapshotScoring.ts`
- `apps/api/src/runtime/__tests__/snapshotScoring.test.ts`

**Implementation notes:**
- Export: `normalizeTarget`, `extractMeaningfulTokens`, `scoreCandidateForAction`, `rankCandidates`, `chooseClearWinner`
- All scoring logic per `scoring-and-fallback-resolution.md`
- All types per `internal-model.md` (`ElementTargetRecord`, `NormalizedTarget`, `CandidateScore`, etc.)
- No browser imports; no CDP; no Playwright

**Acceptance:**
- [ ] All 15 required unit tests pass (see `scoring-and-fallback-resolution.md`)
- [ ] TERTIAL light blue wins over dark gray when both candidates present
- [ ] Color-only ambiguity produces AMBIGUOUS_ELEMENT
- [ ] Generic-only target produces ELEMENT_NOT_FOUND (score < 70)
- [ ] Disabled/hidden candidates hard-rejected
- [ ] No coordinates in any output
- [ ] Score buckets (high/medium/low) in diagnostics, not raw numbers
- [ ] `browser_type` rejects non-typeable candidates

**Must not regress:**
- Nothing (no browser code touched in this phase)

---

## Phase 2: DOM Extraction Runtime Function

**Goal:** Implement the CDP-based element extractor that runs the JS IIFE in the page and returns a typed array of raw element data.

**Files to create/modify:**
- `apps/api/src/runtime/snapshotExtractor.ts` (new)

**Implementation notes:**
- Function: `extractPageElements(page: Page, opts: ExtractionOptions): Promise<RawElementData[]>`
- Uses `page.evaluate(iife_string)` — raw JS string IIFE, not TypeScript arrow function
- Candidate selector list per `extraction-strategy.md`
- Visibility, enablement, name extraction, kind inference per `extraction-strategy.md`
- Caps at `maxElements` (default 200)
- Returns JSON-serializable array only — no DOM references
- Does not assign `ag_*` refs (that happens in Phase 3)
- Does not mutate the page

**Acceptance:**
- [ ] Can extract visible links/buttons/inputs from a representative test page
- [ ] Uses `getBoundingClientRect` for boxes
- [ ] Does not read `.value` for password/payment fields
- [ ] Handles an empty page safely (returns `[]`)
- [ ] Respects element cap
- [ ] Returns only JSON-serializable data
- [ ] Unit tests with mocked `page.evaluate` cover: basic extraction, visibility filter, enablement filter, name extraction priority, kind inference

**Must not regress:**
- `browser_snapshot`, `browser_click`, `browser_type`, `browser_navigate` — all unchanged in this phase

---

## Phase 3: Snapshot Store and API Endpoint

**Goal:** Add the in-memory snapshot store and implement `POST /api/agent/v1/runtime/browser-snapshot`.

**Files to create/modify:**
- `apps/api/src/runtime/snapshotStore.ts` (new)
- `apps/api/src/routes/agent-api.ts` or equivalent — add endpoint

**Implementation notes:**
- `snapshotStore.ts` exports: `createSnapshot`, `resolveRef`, `markStale`, `cleanupSession`, `gcExpiredSnapshots`
- `createSnapshot` calls `extractPageElements` then assigns `ag_1 … ag_N` refs
- Stores `SnapshotRecord` with `Map<string, ElementTargetRecord>` per `internal-model.md`
- `POST /api/agent/v1/runtime/browser-snapshot` per `external-contract.md`
- Response excludes coordinates and all forbidden fields (per `security-and-privacy.md`)
- Navigation events (captured from `browser_navigate` handler) call `markStale` for the session

**Acceptance:**
- [ ] Returns `ag_*` refs in response
- [ ] Stores internal boxes and selector hints
- [ ] Response contains no x/y/width/height/selector/cdp_url/pass_id
- [ ] Snapshot refs are scoped to session and snapshot_id
- [ ] Snapshot marks stale after a `browser_navigate` call
- [ ] Expired snapshots are GC'd
- [ ] Session cleanup removes associated snapshots

**Must not regress:**
- `browser_snapshot` (still delegates to Playwright unchanged)
- `browser_click`, `browser_type`, `browser_navigate` adapters

---

## Phase 4: Adapter Tool antigen_snapshot

**Goal:** Add `antigen_snapshot` as a new MCP tool in the browser adapter. Agents can now call it and receive `ag_*` refs.

**Files to modify:**
- `examples/antigen-browser-adapter.mjs`

**Implementation notes:**
- Add `antigen_snapshot` to `STATIC_BROWSER_TOOLS` list with schema per `external-contract.md`
- Intercept `antigen_snapshot` calls (never forward to Playwright)
- Call `POST /api/agent/v1/runtime/browser-snapshot` and return the response
- `browser_snapshot` is **unchanged** — still forwarded to Playwright

**Acceptance:**
- [ ] Cowork / Claude Desktop can call `antigen_snapshot`
- [ ] Response is readable and compact
- [ ] Response contains `ag_*` refs, names, roles, kinds, state
- [ ] No existing browser tools regress (test suite still passes)
- [ ] `browser_snapshot` still returns Playwright format

---

## Phase 5: browser_click by ag_ref

**Goal:** Update `browser_click` to resolve `ag_*` refs using the primary path. Scoring fallback replaces old exact/alias text matching.

**Files to modify:**
- `apps/api/src/routes/agent-api.ts` (or wherever `POST /api/agent/v1/runtime/browser-click` is handled)
- `apps/api/src/runtime/realisticBrowserActions.ts` (add ref resolution entry point)

**Implementation notes:**
- Detect `ref` prefix: `ag_` → primary path via `resolveRef` + revalidation
- Detect `ref` prefix: `e` (Playwright) or absent → fallback path via scoring
- Primary path: per steps in `resolution-and-click-flow.md`
- Fallback path: `extractPageElements` → `rankCandidates` → `chooseClearWinner` → execute if clear winner
- Reuses `clickBoxWithPointer` from `nativePointerRuntime.ts` unchanged
- Return safe metadata per `external-contract.md`
- Failure codes per `resolution-and-click-flow.md`

**Acceptance:**
- [ ] Product link click works using `ag_*` ref (IKEA/Target-style test)
- [ ] No natural-language rediscovery required for primary path
- [ ] Scoring fallback resolves `"TERTIAL Work lamp light blue product link"` without `ref`
- [ ] AMBIGUOUS_ELEMENT returned when two color variants have similar scores
- [ ] Failure codes are explicit and safe
- [ ] No forbidden fields in any response

**Must not regress:**
- `browser_type`, `browser_navigate`, `browser_snapshot`, `antigen_snapshot`
- All existing adapter tests

---

## Phase 6: browser_type by ag_ref

**Goal:** Update `browser_type` to resolve `ag_*` refs for input fields. Scoring fallback used when no ref provided.

**Files to modify:**
- Same API route / `realisticBrowserActions.ts`

**Implementation notes:**
- Same ref detection logic as Phase 5
- Hard-reject non-typeable candidates in scoring path
- `submit: true` → Enter key dispatch (unchanged from current behavior)
- `pointer_state_persisted` in response

**Acceptance:**
- [ ] Search box typed into by `ag_*` ref
- [ ] `submit: true` still works with `submit_method` in response
- [ ] Pointer continuity maintained
- [ ] `TARGET_NOT_TYPEABLE` returned for non-input targets
- [ ] Credential fields blocked from direct typing (must use `request_secret_field_injection`)

---

## Phase 7: Policy Annotations v1

**Goal:** Add coarse sensitivity annotations to snapshot elements. Mark likely credential/payment/checkout/cart/account/destructive candidates at extraction time.

**Files to modify:**
- `snapshotExtractor.ts` — add sensitivity classification
- `external-contract.md` definition is already written; implement it

**Implementation notes:**
- Annotation logic per `security-and-privacy.md` (name-based classification, no value reading)
- `sensitivity` field added to `ElementTargetRecord` and external response
- Policy check added to primary and fallback execution paths

**Acceptance:**
- [ ] Checkout/pay buttons marked `checkout` or `destructive_action`
- [ ] Password inputs marked `credential_field`
- [ ] Cart add buttons marked `cart_add`
- [ ] Sensitive values not exposed (annotation only)
- [ ] `POLICY_REQUIRES_APPROVAL` returned for checkout/payment/account actions

---

## Phase 8: Decide on browser_snapshot Default

**Goal:** Evaluate whether `antigen_snapshot` should become the default or whether `browser_snapshot` should be enhanced to return Antigen refs alongside Playwright accessibility tree output.

**This phase is a decision, not a full implementation.** Based on agent behavior observed in Phases 4–6, choose one:

A. **Keep separate.** `antigen_snapshot` = Antigen refs; `browser_snapshot` = Playwright refs. Agents use `antigen_snapshot` before acting.

B. **Augment.** `browser_snapshot` returns both the Playwright accessibility tree and an Antigen snapshot section. Agent can use either ref set.

C. **Replace.** `browser_snapshot` is intercepted and returns only Antigen format.

See [open-questions.md](./open-questions.md) for the open question on this decision.

**Acceptance:**
- [ ] Decision documented
- [ ] Agents primarily use `ag_*` refs
- [ ] Playwright `e*` refs remain available as fallback if needed

---

## Scoring Utility Tests (Required Before Phase 5)

These tests (Phase 1) must exist and pass before the scoring module is wired into `browser_click`:

1. Exact name match → winner ≥ 100
2. Token overlap product match → winner ≥ 70, margin ≥ 20
3. Href slug reinforces match
4. Role mismatch penalty (-20)
5. Disabled → hard reject
6. Hidden → hard reject
7. Two color variants → AMBIGUOUS_ELEMENT
8. Generic-only target → ELEMENT_NOT_FOUND
9. Add to cart button → winner ≥ 90
10. `browser_type` + non-input → hard reject
11. Sensitive candidate flagged for policy check
12. No coordinates in external diagnostics
13. Score buckets in diagnostics
14. Empty name penalized (-20)
15. Generic single-word name penalized unless href compensates
