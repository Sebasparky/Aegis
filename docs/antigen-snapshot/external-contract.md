# Antigen Snapshot — External Contract

This document defines what the agent sees: the tool interface, request shape, response shape, and the fields that are and are not allowed to appear in external output.

---

## Tool Name

**`antigen_snapshot`** — a new adapter tool, distinct from `browser_snapshot`.

`browser_snapshot` continues to exist and delegates to `@playwright/mcp` unchanged. `antigen_snapshot` is the Antigen-owned alternative that returns `ag_*` refs the agent can act on.

### Why a Separate Tool (not an override)

- Avoids breaking existing agents that rely on Playwright's accessibility tree format.
- Lets agents opt in to `ag_*` refs explicitly.
- Allows side-by-side comparison during transition.
- Long-term, `antigen_snapshot` may become the default; that decision is in [open-questions.md](./open-questions.md).

---

## Adapter Tool Schema

```json
{
  "name": "antigen_snapshot",
  "description": "Capture Antigen's view of the current page. Returns ag_* refs that can be used with browser_click and browser_type for reliable execution.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "include": {
        "type": "array",
        "items": { "type": "string", "enum": ["links", "buttons", "inputs", "selects", "all"] },
        "description": "Optional filter. Defaults to all interactive elements."
      },
      "viewport_only": {
        "type": "boolean",
        "description": "If true, only return elements currently visible in the viewport. Default: true."
      },
      "max_elements": {
        "type": "integer",
        "description": "Cap on returned elements. Default: 200. Max: 500."
      }
    }
  }
}
```

---

## API Endpoint

```
POST /api/agent/v1/runtime/browser-snapshot
```

### Request Body

```json
{
  "browser_session_id": "bs_...",
  "action": "dom_snapshot",
  "viewport_only": true,
  "max_elements": 200
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `browser_session_id` | string | yes | Must match an active `TaskBrowserSession` |
| `action` | string | yes | Always `"dom_snapshot"` in v1 |
| `viewport_only` | boolean | no | Default `true` |
| `max_elements` | integer | no | Default 200, max 500 |

---

## Response Shape

### Success

```json
{
  "ok": true,
  "data": {
    "snapshot_id": "snap_01HZ...",
    "url": "https://www.ikea.com/us/en/search/?q=desk%20lamp",
    "title": "Search for \"desk lamp\" - IKEA",
    "element_count": 48,
    "elements": [
      {
        "ref": "ag_1",
        "kind": "link",
        "role": "link",
        "name": "TERTIAL, Work lamp, light blue",
        "state": {
          "visible": true,
          "enabled": true
        },
        "hints": {
          "href_path": "/us/en/p/tertial-work-lamp-light-blue-70504295/"
        }
      },
      {
        "ref": "ag_2",
        "kind": "link",
        "role": "link",
        "name": "TERTIAL, Work lamp, dark gray",
        "state": {
          "visible": true,
          "enabled": true
        },
        "hints": {
          "href_path": "/us/en/p/tertial-work-lamp-dark-gray-20504293/"
        }
      },
      {
        "ref": "ag_3",
        "kind": "input",
        "role": "searchbox",
        "name": "Search",
        "state": {
          "visible": true,
          "enabled": true
        },
        "hints": {}
      },
      {
        "ref": "ag_4",
        "kind": "button",
        "role": "button",
        "name": "Add to bag",
        "state": {
          "visible": true,
          "enabled": true
        },
        "hints": {}
      }
    ],
    "truncated": false,
    "snapshot_ttl_ms": 8000
  }
}
```

### Error

```json
{
  "ok": false,
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "No active browser session with id bs_xxx."
  }
}
```

---

## Element Object Fields

### Allowed in External Response

| Field | Notes |
|-------|-------|
| `ref` | Antigen ref, `ag_<n>`, scoped to this `snapshot_id` and session |
| `kind` | Semantic kind: `link`, `button`, `input`, `select`, `text_area`, `editor`, `control`, `summary` |
| `role` | ARIA role or inferred role: `link`, `button`, `searchbox`, `textbox`, `combobox`, `checkbox`, `radio`, `switch`, `menuitem`, `option`, `tab` |
| `name` | Accessible name (aria-label, label, innerText, alt, title, placeholder) |
| `state.visible` | boolean |
| `state.enabled` | boolean |
| `hints.href_path` | URL path portion of href for links (not full URL if sensitive policy disallows) |
| `sensitivity` | (future v1.1) coarse annotation: `ordinary`, `cart_add`, `checkout`, `credential_field`, `payment_field`, `account_action`, `destructive_action` |

### Not Allowed in External Response

The following must never appear in any agent-facing response, snapshot, or diagnostic:

| Field | Reason |
|-------|--------|
| `x`, `y`, `width`, `height`, `center_x`, `center_y` | Coordinates are internal execution detail |
| Full bounding box object | Same reason |
| `cdp_url` | Internal infrastructure |
| `user_data_dir` | Internal |
| `profile_key` | Internal |
| `pass_id` | Vault credential reference |
| `secret_ref` | Secret material reference |
| Raw cookie values | Session material |
| localStorage / sessionStorage values | Session material |
| Raw DOM HTML | Exposes internals |
| CSS selectors used for resolution | Brittle; agents should not hard-code these |
| Hidden input values | Any value of `type="hidden"` |
| Password field values | Never |
| Payment field values | Never |
| `selector_hints` object | Internal resolution aid |
| `href` (full URL) | Return only `href_path` unless policy explicitly allows full URL |
| Raw internal scores | Use score buckets in diagnostics if needed |

---

## Design Principles

**The agent chooses semantic refs, not coordinates.** Coordinates are internal. The agent should never need to know where on screen something is — it names targets semantically and Antigen executes.

**Names are the primary disambiguation signal.** The agent selects `ag_27` because the snapshot showed `name: "TERTIAL, Work lamp, light blue"`. Not because it knew the element was at `(489, 769)`.

**Hints are supplementary.** `href_path` helps the agent confirm it has the right product link. It is not required for resolution — the `ag_*` ref carries that.

**`snapshot_id` is required for future actions.** A `browser_click` call should pass `snapshot_id` so Antigen can verify ref freshness without ambiguity. In v1 this can be optional with a warning; in v2 it should be required.

---

## Snapshot TTL

The response includes `snapshot_ttl_ms` (default 8000ms). After this window:
- Refs are still resolvable but Antigen will attempt revalidation before acting.
- After a navigation event, all refs from the previous URL are immediately stale.
- Stale refs trigger revalidation, not silent failure. If revalidation succeeds, the action proceeds.

See [internal-model.md](./internal-model.md) for the full TTL and freshness model.
