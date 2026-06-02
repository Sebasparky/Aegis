# Antigen Snapshot — Open Questions

These questions are unresolved at the time of Phase 0 documentation. Each should be answered before the relevant implementation phase begins.

---

## Tool Naming and Interface

**Q1: Should the external tool be `antigen_snapshot`, or should `browser_snapshot` be intercepted/replaced?**

Options:
- A: Keep `antigen_snapshot` separate permanently. Agents opt in explicitly.
- B: Eventually intercept `browser_snapshot` and return Antigen format. Single tool surface.
- C: `browser_snapshot` returns both Playwright accessibility tree and Antigen elements side by side.

Relevant phase: Phase 8 (decide on `browser_snapshot` default).

**Q2: Should `browser_click` require `snapshot_id` as a mandatory parameter when `ref=ag_*` is provided?**

In v1, `snapshot_id` is optional (Antigen tries all active snapshots for the session). In v2, requiring it prevents accidental cross-snapshot ref resolution. When should this become mandatory?

---

## Snapshot Freshness

**Q3: What is the default snapshot TTL?**

Currently proposed: 8000ms (8 seconds). This covers a single agent turn. A very short TTL (2s) might cause unnecessary revalidation; a long one (30s+) risks stale boxes on dynamic pages. Should the TTL be configurable per request? Should it depend on page type (search results vs. static content)?

**Q4: Should revalidation be automatic (transparent to agent) or explicit (require a new `antigen_snapshot` call)?**

Currently proposed: automatic revalidation on stale ref — try selectors, confirm match, proceed. The agent sees a `"revalidated": true` flag in the response but does not need to call `antigen_snapshot` again. Is this the right tradeoff, or should stale refs always produce `STALE_REF` and force a new snapshot?

---

## Scope

**Q5: Should the snapshot include offscreen elements (outside viewport) or viewport-only?**

Currently proposed: `viewport_only: true` by default. Offscreen elements are not visible and the agent cannot confirm their state. But some pages use off-screen menus or tabs. Should a `viewport_only: false` option exist?

**Q6: Should `antigen_snapshot` auto-scroll to reveal more elements?**

If the agent wants to act on an element below the fold, should Antigen scroll to reveal it first, then snapshot? Or is snapshotting the current viewport sufficient, requiring the agent to scroll explicitly?

---

## href Exposure

**Q7: Should `href` (full URL) ever be exposed to the agent?**

Currently: only `href_path` (path portion, e.g., `/us/en/p/tertial-work-lamp-light-blue-70504295/`) is returned externally. Full URL is internal. Is path sufficient for disambiguation, or do agents need full URLs in some cases? What policy constraint applies?

---

## Iframe and Shadow DOM

**Q8: What is the v1 treatment of same-origin iframes?**

Currently: v1 targets main frame only. Should same-origin iframes be optionally supported in v1, or deferred entirely?

**Q9: What is the timeline for open shadow DOM support?**

The extraction strategy documents a `shadow_dom_traversal: false` placeholder. When would this become a priority? What sites require it?

---

## Virtualized Lists

**Q10: How should Antigen Snapshot handle virtualized lists (infinite scroll, virtual trees, RecyclerView equivalents)?**

Virtualized lists render only the visible slice of a large dataset. An agent trying to click a list item that is not currently in the DOM will get `ELEMENT_NOT_FOUND`. Options:

- A: Return `ELEMENT_NOT_FOUND` — agent must scroll to reveal the item first.
- B: Antigen detects a virtual list and attempts scroll-to-reveal before snapshotting.
- C: Annotate candidates as `"may_be_partial_list"` so the agent knows to scroll.

---

## Cart and Commerce Policy

**Q11: Is `cart_add` (Add to cart / Add to bag) considered `ordinary` or `policy_annotated`?**

Currently: `cart_add` is a separate sensitivity value. The default policy allows it, but the collar's spending policy may gate it. Is this the right default, or should `cart_add` require explicit collar permission?

---

## Scoring

**Q12: What is the minimum acceptable score for a clear winner?**

Currently proposed: 70. Is this too permissive (may accept weak matches) or too strict (may reject valid matches on sites with bad accessibility)? Should the threshold be tunable per action kind?

**Q13: Should scoring margin threshold (currently 20) be higher for sensitive actions?**

A `checkout` button should require a higher confidence margin than an ordinary link. Should `chooseClearWinner` accept a `sensitivity_mode: "strict"` parameter that raises the margin threshold?

**Q14: How much diagnostic candidate detail should be returned on `AMBIGUOUS_ELEMENT`?**

Currently: top 2-3 candidates with ref, role, name, score_bucket. Is this enough for agents to self-correct? Too many candidates may reveal structural information about the page.

**Q15: Should `ELEMENT_NOT_FOUND` include a hint about what was closest?**

Currently: returns `candidate_count` only. Would a `closest_name` hint (if the best score was ≥ 40 but < 70) help agents rephrase their target? Or does it encourage sloppy agent targeting?

---

## Agent Behavior

**Q16: Should Antigen eventually require agents to use `ag_*` refs for all Antigen-owned clicks?**

Currently: scoring fallback exists for compatibility. Long-term, should `browser_click` without an `ag_*` ref emit a structured warning or deprecation signal?

**Q17: How should old Playwright `e*` refs be handled when passed to `browser_click`?**

Currently: treated as if no ref was provided (fallback to scoring). Should Antigen explicitly detect `e*` refs and return a dedicated `PLAYWRIGHT_REF_NOT_SUPPORTED` error with a message explaining how to use `antigen_snapshot`?

---

## Receipts

**Q18: How should Antigen Snapshot interact with receipts?**

When an action is executed via an `ag_*` ref, should the action receipt include the `ag_*` ref and element name? At what phase should this be implemented (Phase 5, or as a later receipt enhancement)?

---

## Developer Experience

**Q19: Should coordinates ever be exposed under a dev/debug mode?**

Internal debug logs can capture full bounding boxes. Should a `ANTIGEN_DEBUG_COORDINATES=true` env flag expose boxes in API responses for developer troubleshooting? This must be gated and never available in production.
