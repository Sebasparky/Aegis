# Antigen Snapshot — Internal Model

This document defines the data structures stored inside Antigen when a snapshot is taken. These records are never sent to agents; they exist to enable reliable element resolution and bounding-box revalidation at action time.

---

## Ref Namespace

- Antigen refs: `ag_<n>` where `n` is a sequential integer starting at 1 per snapshot
- Playwright refs: `e<n>` — Playwright-owned; Antigen never generates or stores these
- A ref is only valid within its `snapshot_id` and `browser_session_id`
- Refs from different snapshots do not collide (different `snapshot_id`)

---

## Snapshot Record

```typescript
interface SnapshotRecord {
  snapshot_id: string;           // "snap_01HZ..."  — ULID or UUID
  browser_session_id: string;    // links to TaskBrowserSession
  url: string;                   // page URL at time of snapshot
  title: string;                 // document.title
  created_at: string;            // ISO 8601
  expires_at: string;            // ISO 8601 — created_at + TTL
  stale: boolean;                // true if navigation occurred after snapshot
  element_count: number;
  elements: Map<string, ElementTargetRecord>;  // key: ref ("ag_27")
}
```

---

## Element Target Record

The full internal record for a single element. Contains everything Antigen needs to resolve and act on the element without calling the agent again.

```typescript
interface ElementTargetRecord {
  // Identity
  snapshot_id: string;
  ref: string;                   // "ag_27"
  browser_session_id: string;
  url: string;                   // page URL at snapshot time

  // Semantic
  tag: string;                   // "a", "button", "input", ...
  role: string;                  // ARIA role or inferred
  kind: ElementKind;             // "link" | "button" | "input" | "select" | "text_area" | "editor" | "control" | "summary"
  name: string;                  // accessible name (aria-label, label, innerText, alt, title, placeholder)
  normalized_name: string;       // normalized for scoring — see scoring-and-fallback-resolution.md
  meaningful_tokens: string[];   // extracted meaningful tokens — see scoring-and-fallback-resolution.md

  // DOM identity hints (used for revalidation)
  id: string | null;
  aria_label: string | null;
  placeholder: string | null;
  title_attr: string | null;     // title= attribute
  href: string | null;           // full href if present
  href_path: string | null;      // pathname portion only
  frame_id: string;              // "main" in v1; future: iframe src or id

  selector_hints: {
    id_selector: string | null;          // "#my-button"
    href_selector: string | null;        // "a[href*=\"tertial-work-lamp-light-blue\"]"
    aria_label_selector: string | null;  // "[aria-label=\"Add to bag\"]"
    placeholder_selector: string | null; // "input[placeholder=\"Search\"]"
    tag: string;                         // "a" — always present
  };

  // Layout (captured at snapshot time)
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  center: {
    x: number;
    y: number;
  };

  // State at snapshot time
  visible: boolean;
  enabled: boolean;
  disabled_reason: string | null;  // "disabled attr" | "aria-disabled" | "pointer-events:none" | null

  // Sensitivity (future v1.1)
  sensitivity: ElementSensitivity | null;

  // Freshness
  created_at: string;            // ISO 8601
  expires_at: string;            // ISO 8601
  revalidated_at: string | null; // ISO 8601 — set when bounding box was re-fetched before an action
  revalidation_box: Box | null;  // most recent revalidated box if different from original
}

type ElementKind = "link" | "button" | "input" | "select" | "text_area" | "editor" | "control" | "summary";
type ElementSensitivity = "ordinary" | "cart_add" | "checkout" | "credential_field" | "payment_field" | "account_action" | "destructive_action" | "unknown_sensitive";
```

---

## TTL and Freshness Model

### Default TTL

`expires_at = created_at + 8000ms` (configurable; 2s–30s range is reasonable)

### Invalidation Events

| Event | Effect |
|-------|--------|
| Page navigation (`browser_navigate`) | All refs for the old URL become `stale: true` immediately |
| Snapshot TTL exceeded | `stale: true`; revalidation attempted before action |
| Browser session closed | All refs for session become unresolvable |

### Revalidation Before Action

When an agent uses a ref that is stale or near-expiry:

1. Attempt to query the live DOM using `selector_hints` in priority order.
2. If element found: update `revalidated_at` and `revalidation_box`. Proceed.
3. If element not found via any hint: return `STALE_REF` error with safe diagnostics.
4. If the page URL has changed: return `STALE_SNAPSHOT` error.

Revalidation does not refresh the entire snapshot. It re-checks only the specific target element.

---

## In-Memory Store

```typescript
// Module-level map in the snapshot service
const snapshots: Map<string, SnapshotRecord> = new Map();

// Lookup by ref within a snapshot
function resolveRef(snapshot_id: string, ref: string): ElementTargetRecord | null {
  return snapshots.get(snapshot_id)?.elements.get(ref) ?? null;
}
```

- Keyed by `snapshot_id`
- Elements are keyed by `ref` within each snapshot
- Session cleanup: when a `TaskBrowserSession` closes, all associated snapshots are deleted
- Navigation cleanup: on `browser_navigate`, mark all snapshots for the session as stale
- Periodic GC: snapshots older than `max_age_ms` (e.g., 60s) are deleted

### v1 Storage Constraints

- In-memory only. No persistence to disk or database.
- Snapshot store does not appear in audit logs.
- Internal bounding-box data and selector hints are not written to any receipt or external log.

### Future Persistent/Audit Storage

If Antigen Snapshot actions are linked to receipts (Phase 6+), receipts store only:
- The semantic element name at action time (e.g., `"TERTIAL, Work lamp, light blue"`)
- The `ag_*` ref
- The action kind (`click`, `type`)
- The timestamp

Receipts do **not** store raw coordinates, DOM HTML, or selector hints.

---

## Forbidden Internal Fields

Even in the internal model, these must never be stored or processed:

- Password field `.value`
- Payment field `.value` (card number, CVV, expiry)
- Secret field `.value`
- `localStorage` / `sessionStorage` contents
- Raw cookie values
- Full HTML dump of the page
- `cdp_url` (available via session; do not duplicate into snapshot records)
- `storageState`

See [security-and-privacy.md](./security-and-privacy.md) for the complete boundary specification.
