# Antigen Snapshot v1

## What It Is

Antigen Snapshot is Antigen's own page-observation system. It extracts visible interactive elements from the live browser page, assigns Antigen-owned refs (`ag_1`, `ag_2`, …), stores internal target metadata, and returns a compact safe snapshot to the agent.

Antigen-owned refs can be resolved and executed by Antigen's own pointer runtime. This eliminates the architectural mismatch where agents receive Playwright refs that Antigen cannot act on.

## Why It Exists

### The Current Broken Loop

```
Playwright observes page
→ Playwright assigns ref  e221
→ Agent sees "TERTIAL, Work lamp, light blue [ref=e221]"
→ Agent calls browser_click ref=e221
→ Antigen intercepts browser_click
→ Antigen cannot resolve e221 (Playwright owns it)
→ Antigen tries to find element by text description
→ Exact/alias matching fails on punctuation, word order, or trailing context words
→ ELEMENT_NOT_FOUND — even though the element is visible in the DOM
```

This is not a one-off matching bug. It is a structural mismatch: Playwright observes, but Antigen executes. When the observation layer and the execution layer are owned by different systems and use incompatible ref spaces, failures are inevitable.

Patching aliases buys one click at a time. A new phrasing, a new website, a new element — the loop restarts.

### The Desired Loop

```
Agent calls antigen_snapshot
→ Antigen queries live page via CDP/DOM
→ Antigen extracts visible interactive elements
→ Antigen assigns  ag_1 … ag_N
→ Antigen stores internal target records (box, selectors, role, name, href, …)
→ Agent receives compact safe snapshot with ag_* refs
→ Agent chooses ag_27 ("TERTIAL, Work lamp, light blue")
→ Agent calls browser_click ref=ag_27
→ Antigen loads stored target for ag_27
→ Antigen revalidates current bounding box via CDP
→ Antigen moves pointer naturally to element center
→ Antigen dispatches click
→ Antigen persists pointer state
→ Antigen returns safe metadata
```

The core invariant: **refs returned by Antigen must be executable by Antigen.**

## Design Position

Antigen Snapshot does not replace the agent as the page-reasoning brain. The agent still decides intent and chooses targets. Antigen owns refs, execution, policy, sensitive gating, and receipts.

This is about session continuity, trustworthy visible automation, predictable execution, and better debugging — not bot-detection evasion. Input is standard browser/CDP events. No OS-level cursor. No claim about bypassing security systems.

## Two Paths: Primary and Fallback

**Primary path** (used when the agent calls `antigen_snapshot` first):

> `antigen_snapshot` → `ag_*` ref → `browser_click ref=ag_*` → Antigen resolves exact stored record → revalidates box → executes

**Fallback/recovery path** (used when no `ag_*` ref is available):

> Legacy call or stale ref → Antigen builds or rebuilds a fresh snapshot → runs deterministic candidate scoring → picks a clear winner or returns `AMBIGUOUS_ELEMENT`

The fallback path is first-class and must always work reliably. It exists for three cases:

1. **Legacy compatibility** — agent calls `browser_click` with only an element description
2. **Ref recovery** — agent holds a stale `ag_*` ref; Antigen rebuilds snapshot and tries to recover the intended target using stored metadata
3. **Partial agent output** — agent saw an Antigen snapshot but described the element instead of passing the ref

See [scoring-and-fallback-resolution.md](./scoring-and-fallback-resolution.md) for the complete scoring algorithm.

## v1 Scope

- Extract visible interactive elements from the main frame
- Assign `ag_*` refs per snapshot
- Store internal records: box, DOM identity hints, role, name, href path
- Return safe semantic snapshot (no coordinates, no DOM internals, no sensitive values)
- Short TTL per snapshot; revalidate before action
- In-memory store only
- New adapter tool `antigen_snapshot` (does not replace `browser_snapshot`)
- `browser_click` updated to resolve `ag_*` refs first
- `browser_type` updated to resolve `ag_*` refs first
- Scoring fallback replaces brittle exact/alias matching

## Non-Goals for v1

- Shadow DOM / cross-origin iframe support
- Virtualized list handling (infinite scroll, virtual trees)
- Policy enforcement beyond basic sensitivity annotation
- Persistent/audit snapshot storage
- OS-level pointer control
- Bypassing any website security measure
- Replacing the agent's page reasoning

## Further Reading

- [architecture.md](./architecture.md) — System-level architecture, ownership boundaries, component diagram
- [external-contract.md](./external-contract.md) — Agent-facing API and response shape
- [internal-model.md](./internal-model.md) — Internal stored snapshot and element target records
- [extraction-strategy.md](./extraction-strategy.md) — How the DOM extractor works
- [resolution-and-click-flow.md](./resolution-and-click-flow.md) — How `browser_click`/`browser_type` resolve refs and fall back
- [scoring-and-fallback-resolution.md](./scoring-and-fallback-resolution.md) — Deterministic candidate scoring algorithm
- [security-and-privacy.md](./security-and-privacy.md) — Privacy boundary, forbidden fields, policy annotations
- [implementation-plan.md](./implementation-plan.md) — Incremental phases with acceptance criteria
- [open-questions.md](./open-questions.md) — Unresolved design questions
