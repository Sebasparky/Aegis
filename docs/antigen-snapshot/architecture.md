# Antigen Snapshot — Architecture

## Current Architecture

```
Agent (Claude Desktop / Cowork)
  │
  ▼ MCP protocol
antigen-browser-adapter.mjs
  │
  ├─ browser_snapshot ──────────────────────────────► @playwright/mcp
  │                                                       │
  │                              Playwright ref  e221 ◄──┘
  │                              (Playwright-owned, opaque to Antigen)
  │
  ├─ browser_click(ref=e221, element="TERTIAL Work lamp") ──► [INTERCEPTED]
  │     │
  │     └─ Cannot resolve e221
  │        Tries text/alias match against live DOM
  │        getBoundingClientRect via CDP if match found
  │        → clickBoxWithPointer (nativePointerRuntime.ts)
  │        → ELEMENT_NOT_FOUND on mismatch
  │
  ├─ browser_type ─────────────────────────────────────── [INTERCEPTED]
  │     └─ Text-based element resolution
  │        → clickBoxWithPointer + typeCharsViaCDP
  │
  └─ browser_navigate ─────────────────────────────────── [INTERCEPTED + FORWARDED]
        └─ Forwards to @playwright/mcp for page load
           Calls POST /api/agent/v1/runtime/browser-navigation-state
           to persist pointer landing zone
```

### Problem with Current Architecture

1. **Ref namespace mismatch.** Playwright refs (`e221`) are valid Playwright object handles. Antigen has no way to resolve them — they are not DOM selectors, node IDs, or stable identifiers.

2. **Text matching is brittle.** When Antigen falls back to natural-language matching it uses exact/alias string comparison. Products differ by one word (`light blue` vs `dark gray`), descriptions include trailing words (`product link`), or punctuation differs (`TERTIAL, Work lamp` vs `TERTIAL Work lamp`). Each mismatch requires a one-off patch. The loop repeats.

3. **Observation and execution are decoupled.** A Playwright snapshot taken at time T describes the page at T. By the time the agent calls `browser_click`, the page may have changed. Antigen has no freshness signal.

4. **No policy signal at observation time.** Antigen learns an element is sensitive only when it tries to click. A snapshot with policy annotations would let agents choose more safely.

---

## Target Architecture

```
Agent (Claude Desktop / Cowork)
  │
  ▼ MCP protocol
antigen-browser-adapter.mjs
  │
  ├─ antigen_snapshot ──────────────────────────────────── [ANTIGEN-OWNED]
  │     │
  │     ▼ POST /api/agent/v1/runtime/browser-snapshot
  │   Antigen API
  │     │
  │     ├─ CDP Runtime.evaluate → DOM IIFE extractor
  │     │   └─ visible interactive elements
  │     │      getBoundingClientRect for each
  │     │      name / role / kind / href / id / aria-label / ...
  │     │
  │     ├─ Assign ag_1 … ag_N
  │     ├─ Store internal SnapshotRecord + ElementTargetRecord[] in memory
  │     └─ Return safe compact snapshot (no coords, no raw DOM)
  │
  │   Agent receives:
  │   { ref: "ag_27", role: "link", name: "TERTIAL, Work lamp, light blue" }
  │
  ├─ browser_click(ref=ag_27) ──────────────────────────── [ANTIGEN-OWNED]
  │     │
  │     ▼ POST /api/agent/v1/runtime/browser-click
  │   Antigen API
  │     │
  │     ├─ Load ElementTargetRecord for ag_27
  │     ├─ Confirm same browser session, snapshot not expired
  │     ├─ Revalidate: run selector hints against live DOM
  │     ├─ Call getBoundingClientRect → fresh box
  │     ├─ Confirm visible + enabled
  │     ├─ Check policy / sensitivity
  │     ├─ clickBoxWithPointer (nativePointerRuntime.ts) ◄─ unchanged
  │     ├─ Persist pointer state
  │     └─ Return safe metadata
  │
  ├─ browser_type(ref=ag_14, text="desk lamp") ─────────── [ANTIGEN-OWNED]
  │     │
  │     └─ Same ref resolution flow
  │        confirm typeable → focus → typeCharsViaCDP ◄─── unchanged
  │
  ├─ browser_snapshot ──────────────────────────────────── [DELEGATED to Playwright]
  │     └─ Unchanged. Playwright ref e* for fallback/compatibility.
  │
  └─ browser_navigate ──────────────────────────────────── [INTERCEPTED + FORWARDED]
        └─ Unchanged.
```

---

## Ownership Boundaries

| Layer | Owner | Responsibility |
|-------|-------|---------------|
| Intent and target choice | Agent | Decides what to do and which `ag_*` ref to act on |
| `ag_*` ref namespace | Antigen | Assigns, stores, resolves, and expires refs |
| DOM extraction | Antigen (via CDP) | Runs IIFE in page, reads DOM/layout APIs |
| Pointer execution | Antigen (`nativePointerRuntime.ts`) | Natural movement, click/keydown dispatch, timing |
| Sensitive gating | Antigen (policy / collar) | Decides whether action requires approval |
| Receipts | Antigen | Records what was done |
| Page rendering, layout, getBoundingClientRect | Browser / Chromium | Ground truth for boxes and visibility |
| Playwright ref namespace (`e*`) | Playwright | Playwright-only; Antigen never resolves these |

---

## Short-Term Integration (v1)

- `antigen_snapshot` is a **new** adapter tool. It does not replace `browser_snapshot`.
- Agents that call `antigen_snapshot` first get `ag_*` refs and clean execution.
- Agents that call `browser_snapshot` first still get Playwright refs and fall back to scoring when they click.
- `browser_click` and `browser_type` are updated to **prefer** `ag_*` ref resolution first, then fall to scoring.

This means existing agents degrade gracefully — they do not break — while agents that adopt `antigen_snapshot` get reliable execution.

---

## Long-Term Direction

- `antigen_snapshot` becomes the default observation tool for Antigen-owned executions.
- `browser_snapshot` is retained for pure read use cases (agents that only read the page without acting through Antigen).
- `browser_click` and `browser_type` eventually require an `ag_*` ref or emit a structured warning when only a description is provided.
- Policy annotations move forward: `antigen_snapshot` marks elements `ordinary`, `cart_add`, `checkout`, `credential`, `payment`, `account_change`, etc. before the agent chooses.
- Snapshot can be linked to receipts: the `ag_*` ref and semantic element name appear in the action receipt, not raw coordinates.

---

## Component Diagram

```
Agent
  │
  ▼  MCP
antigen-browser-adapter.mjs
  │                             │
  │  antigen_snapshot           │  browser_snapshot
  ▼                             ▼
POST /runtime/browser-snapshot  @playwright/mcp
  │                               │
  ▼                               ▼
DOM IIFE extractor (CDP)        Playwright accessibility tree
  │                               │
  ▼                               ▼
internal snapshot store         agent sees  e*  refs
  │
  ├── ag_* refs → agent
  │
  ▼  browser_click ref=ag_*
POST /runtime/browser-click
  │
  ├── load ElementTargetRecord
  ├── revalidate via CDP selector
  ├── getBoundingClientRect (fresh)
  ▼
nativePointerRuntime.ts         ← unchanged, fully reused
  │
  ├── clickBoxWithPointer
  ├── pointer path generation
  ├── CDP Input.dispatchMouseEvent
  └── pointer state persistence
```

---

## Existing Runtime Files (Do Not Rebuild)

These files already implement the execution layer that Antigen Snapshot feeds into. They are not modified by this increment:

- `apps/api/src/runtime/nativePointerRuntime.ts` — `clickBoxWithPointer`, pointer path generation, CDP mouse dispatch
- `apps/api/src/runtime/realisticBrowserActions.ts` — realistic click/type orchestration
- `apps/api/src/runtime/secretInjection.ts` — credential field CDP injection (separate from snapshot)
- `apps/api/src/runtime/taskBrowserSessions.ts` — session lifecycle, pointer state persistence
- `apps/api/src/runtime/agentSafeObservation.ts` — sensitive workflow observation (separate feature; different purpose from Antigen Snapshot)
