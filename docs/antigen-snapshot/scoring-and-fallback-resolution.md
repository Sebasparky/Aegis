# Antigen Snapshot — Scoring and Fallback Resolution

Candidate scoring is the **first-class fallback and recovery system** for Antigen Snapshot. It is not an afterthought — it is the safety net that makes the system work when no direct `ag_*` ref is available, and it must be deterministic, explainable, and thoroughly tested.

## Position in the Architecture

**Primary path** (always prefer this):

```
antigen_snapshot → ag_* ref → browser_click ref=ag_* → exact stored record → revalidate box → execute
```

**Fallback path** (this document):

```
browser_click with description or stale ref
  → build fresh internal snapshot
  → scoreCandidateForAction() for each candidate
  → rankCandidates()
  → chooseClearWinner()
  → execute if winner found, else return AMBIGUOUS_ELEMENT / ELEMENT_NOT_FOUND
```

When the fallback path is used:

1. **Legacy compatibility** — agent calls `browser_click element="TERTIAL Work lamp light blue product link"` with no `ref`
2. **Stale ref recovery** — agent passes an `ag_*` ref but the snapshot is expired; Antigen rebuilds a fresh snapshot and tries to recover the intended target using the stored element's `name` and `href_path` as the scoring seed
3. **Partial agent output** — agent received an Antigen snapshot but described the target in text instead of passing the ref

Scoring is **not** used when a valid `ag_*` ref is available. It must never silently replace a direct ref resolution.

---

## Why Scoring, Not Exact Matching

The previous failure pattern:

- Snapshot showed link `"TERTIAL, Work lamp, light blue"`.
- Agent asked for `"TERTIAL Work lamp light blue product link"`.
- Exact match failed: different punctuation, extra words.
- We patched aliases for this phrase.
- Next phrase failed: `"Tertial work lamp (light blue)"`.
- The loop continued.

Alias patching is not maintainable. A deterministic scoring algorithm replaces it with a signal-weighted model that handles punctuation variation, extra context words, token reordering, and partial name matches — without requiring per-site patches.

---

## Scoring Entry Points (Public API)

```typescript
// Normalize a raw target string into scoring-ready form
function normalizeTarget(raw: string): NormalizedTarget

// Score one candidate element against a normalized target
function scoreCandidateForAction(
  target: NormalizedTarget,
  candidate: ElementTargetRecord,
  action: "click" | "type"
): CandidateScore

// Rank all candidates
function rankCandidates(
  target: NormalizedTarget,
  candidates: ElementTargetRecord[],
  action: "click" | "type"
): RankedCandidate[]

// Pick a clear winner or return a failure reason
function chooseClearWinner(
  ranked: RankedCandidate[],
  action: "click" | "type"
): ClearWinnerResult
```

```typescript
interface NormalizedTarget {
  raw: string;
  lowercased: string;
  tokens: string[];                 // all tokens after normalization
  meaningful_tokens: string[];      // tokens after removing generic words
  inferred_kind: ElementKind | null; // inferred from target text (e.g., "link", "button", "input")
}

interface CandidateScore {
  ref: string;
  total: number;
  breakdown: Record<string, number>; // signal name → points earned (for internal debug)
  hard_rejected: boolean;
  reject_reason: string | null;
}

interface RankedCandidate {
  record: ElementTargetRecord;
  score: CandidateScore;
}

type ClearWinnerResult =
  | { found: true; winner: ElementTargetRecord; score: number }
  | { found: false; code: "ELEMENT_NOT_FOUND" | "AMBIGUOUS_ELEMENT"; diagnostics: object };
```

---

## Step 1: Normalization Pipeline

`normalizeTarget(raw: string): NormalizedTarget`

Apply this pipeline in order:

1. Lowercase the entire string
2. Replace hyphens, underscores, slashes, pipes with spaces
3. Remove punctuation: `.,!?;:'"()[]{}` — but keep `&` (useful for product names like "Home & Kitchen")
4. Collapse multiple whitespace characters to single space
5. Trim leading and trailing whitespace
6. Tokenize on space boundaries
7. Remove generic words (see list below)
8. Remove tokens of length 1 that are not meaningful
9. The result is `meaningful_tokens`

### Generic Words to Remove

These words carry no product/action signal and cause false positives:

```
link, button, product, item, card, result, option, menu, suggestion, search,
click, open, select, choose, view, details, the, a, an, this, that, here,
go, navigate, visit, page, site, web, element, widget, control, field,
action, target, element, text
```

**Important:** Do not remove words if the remaining `meaningful_tokens` array would be empty. If all tokens are generic, preserve the full lowercased token list as `meaningful_tokens` (with a warning flag) and treat the target as high-ambiguity.

**Example:** `"search suggestion link"` → tokens: `["search", "suggestion", "link"]` → after removing generics: `["suggestion"]` — wait, "suggestion" is in the list. Result: empty. Preserve all: `["search", "suggestion"]` (flag high-ambiguity). This prevents collapsing to `"search"` and clicking a random search element.

### Kind Inference from Target Text

After normalization, check if any of these words remain in the raw (pre-removal) token list and set `inferred_kind`:

| Token | `inferred_kind` |
|-------|----------------|
| `link` | `"link"` |
| `button` | `"button"` |
| `input`, `field`, `textbox`, `searchbox`, `search box`, `text field` | `"input"` |
| `select`, `dropdown` | `"select"` |
| `checkbox` | `"control"` |

If multiple conflicting kinds appear, `inferred_kind` is null.

---

## Step 2: Scoring Signals

`scoreCandidateForAction(target, candidate, action)` computes a sum of additive signals and subtractive penalties.

### Hard Rejection (score = 0, hard_rejected = true)

These conditions immediately reject a candidate regardless of name/role signals:

| Condition | Reason |
|-----------|--------|
| `candidate.visible === false` | Not visible |
| `candidate.enabled === false` | Disabled |
| `action === "type"` and `candidate.kind` not in `["input", "text_area", "editor"]` | Cannot type into this element |
| `inferred_kind` present and candidate kind conflicts with action (e.g., `action="type"` but candidate is `"link"`) | Wrong kind for action |

### Additive Signals

#### Name Matching

Compute against `candidate.normalized_name` and `candidate.meaningful_tokens`.

| Signal | Points |
|--------|--------|
| Exact normalized name match (`target.lowercased === candidate.normalized_name`) | +100 |
| Candidate normalized_name contains all target meaningful_tokens as a substring | +70 |
| Target meaningful_tokens all appear in candidate meaningful_tokens (token containment) | +60 |
| Token overlap: all target meaningful_tokens present in candidate meaningful_tokens | +60 |
| Token overlap: ≥ 75% of target meaningful_tokens present in candidate meaningful_tokens | +40 |
| Token overlap: ≥ 50% of target meaningful_tokens present | +25 |
| Token overlap: ≥ 25% of target meaningful_tokens present | +10 |
| Any single important token matches (token length ≥ 4, not a generic word) | +5 per token, max +15 |

"Present in" means the candidate's meaningful_token set contains the token exactly or the candidate's normalized_name contains the token as a substring.

#### ARIA/Label Signals

| Signal | Points |
|--------|--------|
| `candidate.aria_label` normalized exactly matches target lowercased | +30 |
| `candidate.aria_label` normalized contains all target meaningful_tokens | +25 |
| `candidate.placeholder` normalized matches meaningful target tokens | +20 |
| Associated label text normalized matches | +20 |

#### Role / Kind Match

| Signal | Points |
|--------|--------|
| `inferred_kind === candidate.kind` (exact kind match) | +20 |
| `inferred_kind` is `"input"` and candidate role is `"searchbox"`, `"textbox"`, or `"combobox"` | +25 |
| `inferred_kind` is `"link"` and candidate role is `"link"` | +20 |
| `inferred_kind` is `"button"` and candidate role is `"button"` | +20 |

#### Href / Path Signals

These are especially important for product link disambiguation.

| Signal | Points |
|--------|--------|
| `candidate.href_path` slug tokens all appear in target meaningful_tokens (slug = split on `-`, `/`) | +30 |
| `candidate.href_path` slug tokens mostly (≥ 75%) appear in target meaningful_tokens | +20 |
| Any important (≥ 4 chars) target meaningful_token appears in `candidate.href_path` | +10 |
| `candidate.href_path` is non-null and target contains a URL-like fragment | +5 |

"Slug tokens" = `href_path.split("/").flatMap(s => s.split("-")).filter(t => t.length >= 3)`.

#### ID / Attribute Signals

| Signal | Points |
|--------|--------|
| `candidate.id` normalized contains an important (≥ 4 chars) target token | +10 |
| `candidate.id` and target share a word that is product/action-specific | +10 |

### Penalties

| Penalty | Points |
|---------|--------|
| `inferred_kind === "link"` but candidate kind is `"button"` | -20 |
| `inferred_kind === "button"` but candidate kind is `"link"` | -20 |
| `inferred_kind === "link"` or `"button"` but candidate kind is `"input"` | -30 |
| Candidate `name` is empty string | -20 |
| Candidate `name` is a single generic word (`"Learn more"`, `"View"`, `"Open"`, `"Click here"`, `"Here"`) and no href/id signal matches | -30 |
| Candidate is offscreen (viewport_only=true was used) | -15 |
| Candidate `sensitivity` is `"checkout"`, `"payment_field"`, or `"destructive_action"` | -10 (flag for policy check; do not reject outright) |

---

## Step 3: Ranking

`rankCandidates(target, candidates, action)`:

1. Run `scoreCandidateForAction` for each non-hard-rejected candidate
2. Sort descending by `total` score
3. Hard-rejected candidates are excluded from the ranked list
4. Return top 10 ranked candidates (internal only; diagnostics may surface top 2-3)

---

## Step 4: Clear Winner

`chooseClearWinner(ranked, action)`:

### Acceptance Thresholds

All conditions must hold for a winner to be declared:

| Condition | Threshold |
|-----------|-----------|
| `ranked[0].score.total` | ≥ **70** |
| `ranked[0].score.total - ranked[1]?.score.total` (margin) | ≥ **20** (or no second candidate) |
| Winner is visible | must be `true` |
| Winner is enabled | must be `true` |
| Winner kind compatible with action | must be `true` |
| Winner not policy-blocked | must be `true` (or return POLICY_REQUIRES_APPROVAL) |

If all conditions pass: `{ found: true, winner: ranked[0].record, score: ranked[0].score.total }`

### Failure Cases

| Condition | Result |
|-----------|--------|
| No candidates (empty ranked list) | `ELEMENT_NOT_FOUND` |
| Best score < 70 | `ELEMENT_NOT_FOUND` |
| Best score ≥ 70 but margin < 20 | `AMBIGUOUS_ELEMENT` |
| Best candidate policy-blocked | `POLICY_REQUIRES_APPROVAL` or `SENSITIVE_ACTION_BLOCKED` |

---

## Step 5: External Diagnostics

### AMBIGUOUS_ELEMENT

Return top 2-3 candidates with safe fields only:

```json
{
  "code": "AMBIGUOUS_ELEMENT",
  "message": "Multiple visible candidates matched the target.",
  "candidates": [
    { "ref": "ag_21", "role": "link", "name": "TERTIAL, Work lamp, light blue", "score_bucket": "high" },
    { "ref": "ag_22", "role": "link", "name": "TERTIAL, Work lamp, dark gray",  "score_bucket": "high" }
  ]
}
```

### ELEMENT_NOT_FOUND

```json
{
  "code": "ELEMENT_NOT_FOUND",
  "message": "No visible enabled candidate clearly matched the target.",
  "target_kind": "link",
  "candidate_count": 148
}
```

### Score Buckets

Do not expose raw numeric scores in external responses. Use:

| Internal score | External bucket |
|---------------|----------------|
| ≥ 80 | `"high"` |
| 50–79 | `"medium"` |
| < 50 | `"low"` |

Internal debug logs (behind a dev flag) may record exact scores and breakdowns. External diagnostics never do.

### Never Expose in Diagnostics

- x/y coordinates of any candidate
- `selector_hints` contents
- `cdp_url`, `user_data_dir`, `profile_key`
- Password field values, payment field values
- Full href (return only `href_path`)
- Internal score breakdown

---

## Examples

### Example 1: Product Link — Clear Winner

Target: `"TERTIAL Work lamp light blue product link"`

After normalization:
- meaningful_tokens: `["tertial", "work", "lamp", "light", "blue"]`
- inferred_kind: `"link"`

Candidate A:
- name: `"TERTIAL, Work lamp, light blue"`
- normalized_name: `"tertial work lamp light blue"`
- meaningful_tokens: `["tertial", "work", "lamp", "light", "blue"]`
- kind: `"link"`
- href_path: `"/us/en/p/tertial-work-lamp-light-blue-70504295/"`

Score for A:
- Token overlap all: +60
- Kind match (link=link): +20
- Href slug tokens (tertial, work, lamp, light, blue) all in target: +30
- **Total: ~110**

Candidate B:
- name: `"FORSÅ, Work lamp, nickel plated"`
- tokens: `["forsa", "work", "lamp", "nickel", "plated"]`
- href_path: `"/us/en/p/forsa-work-lamp-nickel-plated-80146777/"`

Score for B:
- Token overlap: "work", "lamp" only → ≥ 25%: +10
- Kind match: +20
- Href no product tokens from target match: 0
- **Total: ~30**

Gap: 110 - 30 = 80. Threshold: 70, margin ≥ 20. **Clear winner: Candidate A.**

### Example 2: Color Disambiguation — Ambiguous

Target: `"TERTIAL Work lamp product link"` (no color)

Candidate A: `"TERTIAL, Work lamp, light blue"` — score ~90
Candidate B: `"TERTIAL, Work lamp, dark gray"` — score ~90

Gap: ≈ 0. Below margin threshold. **Result: AMBIGUOUS_ELEMENT.**

Agent must be more specific: `"TERTIAL Work lamp light blue"`.

### Example 3: Add to Cart — Button Match

Target: `"Add to cart button"`

After normalization:
- meaningful_tokens: `["add", "cart"]`  ("to", "button" removed as generic)
- inferred_kind: `"button"`

Candidate:
- name: `"Add to cart"`
- normalized_name: `"add to cart"`
- meaningful_tokens: `["add", "cart"]`
- kind: `"button"`
- id: `"addToCartButtonOrTextIdFor95008995"`

Score:
- Token overlap all meaningful: +60
- Kind match (button=button): +20
- ID contains "add" and "cart": +10
- **Total: ~90**

Second candidate (if any) unlikely to score above 70. **Clear winner.**

Note: `sensitivity` may be `"cart_add"` — policy check happens after scoring but before execution.

### Example 4: Unsafe Generic Collapse

Target: `"search suggestion link"`

After normalization:
- All tokens are generic: search, suggestion, link
- Fallback: preserve as meaningful_tokens = `["search", "suggestion"]` with high-ambiguity flag

Multiple candidates with "search" in name → all score ≈ 15.

Best score < 70. **Result: ELEMENT_NOT_FOUND.** Agent must provide a more specific description.

### Example 5: Wrong Role — Penalized

Target: `"add to cart link"` (agent incorrectly says "link")

Candidate: role=button, name="Add to cart"
- Name signal: +60
- Kind mismatch (target says link, candidate is button): -20
- **Total: ~40**

Score < 70. Unless no other candidates, likely ELEMENT_NOT_FOUND or low-confidence. Antigen does not silently click the wrong kind of element.

---

## Where Scoring Lives

Scoring utilities should be implemented as a **pure, browser-agnostic module** with no CDP or Playwright dependencies:

```
apps/api/src/runtime/snapshotScoring.ts
```

Exports:
- `normalizeTarget(raw: string): NormalizedTarget`
- `extractMeaningfulTokens(tokens: string[]): string[]`
- `scoreCandidateForAction(target, candidate, action): CandidateScore`
- `rankCandidates(target, candidates, action): RankedCandidate[]`
- `chooseClearWinner(ranked, action): ClearWinnerResult`

This module must be independently testable without a browser runtime.

---

## Required Unit Tests

These tests must be written before the scoring module is considered complete (Phase 1 of implementation). Tests use mocked `ElementTargetRecord` data — no browser required.

| Test | Expected Result |
|------|----------------|
| 1. Exact name match wins | Winner with score ≥ 100 |
| 2. Token overlap product match wins (TERTIAL light blue) | Winner with score ≥ 70, margin ≥ 20 |
| 3. Href slug reinforces product match (href contains product tokens) | Score increases by +30 vs. no href |
| 4. Role mismatch penalized (target says link, candidate is button) | -20 applied |
| 5. Disabled candidate hard-rejected | Not in ranked list |
| 6. Hidden candidate hard-rejected | Not in ranked list |
| 7. Two color variants with same name base → AMBIGUOUS_ELEMENT | `found: false, code: "AMBIGUOUS_ELEMENT"` |
| 8. Generic-only target does not collapse (search suggestion) | Score < 70 → ELEMENT_NOT_FOUND |
| 9. "Add to cart" button wins by name + role + id | Winner score ≥ 90 |
| 10. browser_type with a non-input candidate → hard reject | `hard_rejected: true` |
| 11. Sensitive candidate (checkout) flagged but not auto-rejected | Score computed; policy check triggers POLICY_REQUIRES_APPROVAL |
| 12. No coordinates in external diagnostics | AMBIGUOUS_ELEMENT response has no x/y/box fields |
| 13. Score buckets in diagnostics | high/medium/low only, no raw integers |
| 14. Empty candidate name penalized | -20 applied |
| 15. Single-token generic name penalized unless href compensates | -30 unless href_path signal present |
