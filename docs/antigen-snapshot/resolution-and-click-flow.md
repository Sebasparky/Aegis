# Antigen Snapshot — Resolution and Click Flow

This document defines how `browser_click` and `browser_type` resolve a target and execute, in both the primary (ag_* ref) path and the fallback (scoring) path.

See [scoring-and-fallback-resolution.md](./scoring-and-fallback-resolution.md) for the complete scoring algorithm used in the fallback path.

---

## Two Paths

### Primary Path: ag_* ref resolution

Used when the agent has called `antigen_snapshot` and passes `ref=ag_*` to `browser_click` or `browser_type`. This is the expected path once agents adopt Antigen Snapshot.

No fuzzy matching. No natural-language rediscovery. Direct lookup.

### Fallback Path: scoring-based resolution

Used in three situations:
1. **Legacy call** — agent passes only an element description (`element="TERTIAL Work lamp light blue product link"`) with no `ref` field, or `ref` is a Playwright `e*` ref
2. **Stale ref recovery** — agent passes an `ag_*` ref that is stale (snapshot expired or page navigated); Antigen rebuilds a fresh snapshot and tries to match the stored element metadata against new candidates
3. **Partial output** — agent saw an Antigen snapshot but described the target instead of providing the ref

The fallback path is first-class and must always work reliably. It is not optional. See [scoring-and-fallback-resolution.md](./scoring-and-fallback-resolution.md).

---

## Primary Flow: browser_click by ag_ref

```
1.  Receive browser_click call
    - ref: "ag_27"
    - snapshot_id: "snap_01HZ..."  (optional in v1, required in v2)
    - element: "TERTIAL, Work lamp, light blue"  (used for logs only)

2.  Detect ref type
    - ref starts with "ag_"  → primary path
    - ref starts with "e" or is absent  → fallback path

3.  Load ElementTargetRecord
    - Look up snapshot_id + ref in in-memory store
    - If not found: → STALE_REF (snapshot_id unknown or expired)

4.  Verify session
    - record.browser_session_id must match the active session
    - If mismatch: → SESSION_MISMATCH

5.  Check snapshot freshness
    - If record.url !== current page URL: → STALE_SNAPSHOT
    - If now > record.expires_at: attempt revalidation (step 6)
    - If stale: false and now <= expires_at: skip revalidation (proceed to step 7)

6.  Revalidate element (when stale or near-expiry)
    a.  Try selector_hints in priority order:
        1.  id_selector  (e.g., "#addToCartBtn")
        2.  aria_label_selector
        3.  href_selector
        4.  placeholder_selector
    b.  For each selector: querySelectorAll → filter visible+enabled candidates
    c.  Pick candidate matching expected role and normalized name (loose match)
    d.  If found: update record.revalidated_at, record.revalidation_box
    e.  If not found via any selector: → STALE_REF with diagnostics

7.  Get fresh bounding box
    - Run getBoundingClientRect on the resolved element (or revalidated element)
    - Use revalidation_box if revalidated, else original box

8.  Confirm visibility and enablement
    - visible: false → NOT_VISIBLE
    - enabled: false → NOT_ENABLED

9.  Policy check
    - If element has sensitivity annotation: check collar/task policy
    - "checkout", "payment_field", "credential_field", "account_action", "destructive_action"
      → may require POLICY_REQUIRES_APPROVAL or SENSITIVE_ACTION_BLOCKED

10. Execute click
    - Call clickBoxWithPointer(box) via nativePointerRuntime.ts
    - This is the existing, tested pointer execution layer — do not rebuild

11. Persist pointer state
    - Update TaskBrowserSession.pointer_state with new x/y

12. Return safe metadata
    {
      "ok": true,
      "data": {
        "ref": "ag_27",
        "name": "TERTIAL, Work lamp, light blue",
        "kind": "link",
        "action": "click",
        "revalidated": false,
        "pointer_path_point_count": 20,
        "pointer_start_source": "session",
        "pointer_state_persisted": true
      }
    }
```

---

## Primary Flow: browser_type by ag_ref

```
1.  Receive browser_type call
    - ref: "ag_14"
    - text: "desk lamp"
    - submit: true

2.  Detect ref type → primary path

3.  Load ElementTargetRecord for ag_14

4.  Confirm target is typeable
    - kind must be: input, text_area, editor
    - role must be: textbox, searchbox, combobox, or contenteditable
    - If not typeable: → TARGET_NOT_TYPEABLE

5.  Verify session, freshness, revalidate if needed (same as click steps 3-6)

6.  Get fresh bounding box

7.  Confirm visible and enabled

8.  Policy check (credential/payment fields require Aegis sensitive handoff — do not type directly)

9.  Move pointer to input center
    - clickBoxWithPointer(box) to focus the field

10. Type via existing realistic typing path
    - typeCharsViaCDP (character-by-character, realistic delays)

11. If submit: true
    - Dispatch Enter key event
    - Record submit_method: "enter"
    - If Enter does not submit (future detection): try button_fallback

12. Persist pointer state

13. Return safe metadata
    {
      "ok": true,
      "data": {
        "ref": "ag_14",
        "name": "Search",
        "kind": "input",
        "action": "type",
        "char_count_bucket": "5-8",
        "focused": true,
        "submitted": true,
        "submit_method": "enter",
        "pointer_state_persisted": true
      }
    }
```

---

## Fallback Flow: No ag_ref (Scoring Path)

Used for legacy calls and stale ref recovery. See [scoring-and-fallback-resolution.md](./scoring-and-fallback-resolution.md) for the full algorithm.

```
1.  No ag_* ref provided (or ref is Playwright e* or stale ag_*)

2.  Extract target description
    - Use the element parameter: "TERTIAL Work lamp light blue product link"
    - If stale ag_* ref: also use stored record.name as seed for matching

3.  Build fresh Antigen snapshot of current page
    - Same extraction as antigen_snapshot endpoint
    - Do not return this snapshot to the agent — it is internal

4.  Run candidate scoring
    - For each candidate: scoreCandidateForAction(target, candidate, action_kind)
    - Rank by score descending

5.  Apply clear-winner rules
    - best_score >= 70
    - best_score - second_best_score >= 20
    - winner is visible + enabled
    - winner kind is compatible with action (e.g., typeable for browser_type)
    - winner is not policy-blocked

6.  If clear winner found:
    - Promote winner to an ad-hoc ElementTargetRecord (store under a fresh ref)
    - Execute click/type via the same primary flow (steps 7–13 above)
    - Return safe metadata including the resolved name

7.  If no clear winner:
    - Return ELEMENT_NOT_FOUND or AMBIGUOUS_ELEMENT
    - Include safe diagnostics (see below)
```

---

## Failure Modes

All failure responses follow this shape:

```json
{
  "ok": false,
  "error": {
    "code": "ELEMENT_NOT_FOUND",
    "message": "Human-readable explanation",
    ...safe diagnostic fields...
  }
}
```

| Code | Cause | Safe Diagnostics |
|------|-------|-----------------|
| `STALE_SNAPSHOT` | Page URL changed since snapshot was taken | `previous_url`, `current_url` |
| `STALE_REF` | Ref not found in any live snapshot; revalidation failed | `ref`, hint that agent should call `antigen_snapshot` again |
| `ELEMENT_NOT_FOUND` | No plausible candidates matched | `target_kind`, `candidate_count` |
| `AMBIGUOUS_ELEMENT` | Multiple candidates with close scores | `candidates` array (ref, role, name, score_bucket) |
| `NOT_VISIBLE` | Element resolved but not visible at action time | `ref`, `name` |
| `NOT_ENABLED` | Element resolved but disabled | `ref`, `name`, `disabled_reason` |
| `TARGET_NOT_TYPEABLE` | Tried to `browser_type` a non-input element | `ref`, `name`, `kind` |
| `POLICY_REQUIRES_APPROVAL` | Element requires user approval before acting | `ref`, `name`, `sensitivity` |
| `SENSITIVE_ACTION_BLOCKED` | Element sensitivity blocked by collar/policy | `ref`, `name`, `sensitivity` |
| `SESSION_MISMATCH` | Ref belongs to a different session | None beyond the code |
| `FRAME_UNSUPPORTED` | Element lives in an iframe or shadow DOM context not supported in v1 | `frame_context` hint |

### AMBIGUOUS_ELEMENT Diagnostic Shape

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

### ELEMENT_NOT_FOUND Diagnostic Shape

```json
{
  "code": "ELEMENT_NOT_FOUND",
  "message": "No visible enabled candidate clearly matched the target.",
  "target_kind": "link",
  "candidate_count": 148
}
```

Do not expose raw scores in external diagnostics. Use score buckets: `"high"`, `"medium"`, `"low"`.

---

## Relationship Between Primary Path and Scoring

Scoring is not a degraded version of the primary path. It is a **parallel, first-class system** for cases where a direct ref is unavailable. The two paths share:

- The same `clickBoxWithPointer` execution layer (primary path uses a stored box; scoring rebuilds it fresh)
- The same failure codes and diagnostic shapes
- The same policy check

They differ in how the target is found:

| | Primary path | Fallback path |
|--|--|--|
| Target source | Stored `ag_*` ref | Natural-language description or recovered metadata |
| Element location | Cached box + revalidation | Fresh snapshot + scoring |
| Determinism | High — exact ref lookup | Lower — depends on score gap and page state |
| Speed | Fast — skips snapshot extraction | Slower — full snapshot extraction required |
| Brittleness | Very low | Moderate — degrades gracefully to AMBIGUOUS_ELEMENT |

The scoring fallback replaces the previous brittle exact/alias text matching. It must never become the default path for agents that have access to `antigen_snapshot`.

See [scoring-and-fallback-resolution.md](./scoring-and-fallback-resolution.md) for the complete algorithm, signal weights, normalization rules, and unit test requirements.
