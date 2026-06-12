# Antigen IKEA Checkout Milestone — Current State

> **Handoff note.** Consolidated orientation for the next session. The companion docs are
> [`docs/dev/antigen-browser-qa.md`](./antigen-browser-qa.md) (canonical Step 0 / env / smoke
> recipe) and [`docs/NEXT_SESSION_PROMPT.md`](../NEXT_SESSION_PROMPT.md) (running history).
> This note summarizes; those two are authoritative for the exact commands.

## Commit / working-tree state (read this first)

- **The code milestone is already committed.** As of this handoff, `HEAD` is
  `50d68e1 "Expose Antigen refs and ordering for payment fills"` and **the working tree was
  clean before these doc edits**. The `git add … && git commit -m "Expose Antigen refs and
  ordering for payment fills"` command from earlier handoff prompts is **already done — do not
  re-run it.** All three intended files (`packages/types/src/index.ts`,
  `apps/api/src/runtime/paymentCardFill.ts`, `apps/api/src/routes/agent-api.ts`) are in that
  commit.
- **The only expected uncommitted changes after this handoff are the docs**: this new file
  plus one short pointer line each in `docs/NEXT_SESSION_PROMPT.md` and
  `docs/dev/antigen-browser-qa.md`. No runtime/product code changed for the handoff.

## High-level result

The IKEA real-web checkout flow now demonstrates, under Antigen mediation:

- Real site navigation through homepage → search → product → cart → checkout → payment.
- **No deeplinks after the homepage** — every move after the initial homepage load is
  `antigen_snapshot` + `browser_click` on fresh `ag_*` refs.
- `post_click_state` reduced blind retry loops (decisive single snapshot after a
  modal/navigation/content change instead of polling).
- `post_fill_state` improved the protected-fill handoff (names-only realized outcome after a
  fill, so the agent does one snapshot + one click instead of guessing).
- Protected **profile fill works**.
- Wrong autofilled profile values are **corrected, not blindly trusted**.
- **Payment card fill works across OPPWA iframe fields and top-level DOM fields**: card number
  and CVV fill through the OPPWA iframe path; **expiry and cardholder fill through
  `element_hint.antigen_ref`** (top-level DOM).
- **Screenshot redaction reached 4/4** in live smoke (all four protected card fields visually
  protected in the rendered image).
- The **final Pay / Place order was not clicked**.
- **No raw sensitive values leaked** (no card/profile/credential values, no selectors/ids/
  boxes/coords, no CDP URL).
- Session closed cleanly.

## Key fixes completed (with files)

1. **Runtime flag diagnostics + Step 0 hard gate** — `apps/api/src/runtime/antigenRuntimeFlags.ts`
   (single source of truth for "which Antigen flags are effective in THIS API process"),
   surfaced at `GET /api/runtime/status` (`apps/api/src/routes/runtime-status.ts`).
   `fill_state` is included. **The flags must be set in the shell that starts `apps/api`, not
   only the adapter/MCP shell** — a flag set on the adapter but not the API silently looks
   inactive (this exact mistake made `post_fill_state` absent during a live smoke while it was
   believed on). Step 0 is now a mandatory gate before any smoke is recorded as
   operator-verified.

2. **Active surfaces + post-click realization** — `apps/api/src/runtime/antigenSnapshotPageMap.ts`
   (active-surface enrichment / recommended actions), `apps/api/src/runtime/antigenClickVerification.ts`
   (`post_click_state` on `browser_click`). One decisive snapshot after a modal/navigation/
   content update; avoid blind retries.

3. **Antigen-ref payment bridge** — `apps/api/src/runtime/paymentCardFill.ts`,
   `apps/api/src/routes/agent-api.ts`, `packages/types/src/index.ts`. The agent passes an
   **opaque `ag_*` ref**; the server resolves it via the snapshot record. **No selector / id /
   box / coordinate leakage.** Top-level expiry/cardholder payment fields can be filled via
   `element_hint.antigen_ref`.

4. **`post_fill_state`** — `apps/api/src/runtime/postFillProbe.ts`,
   `apps/api/src/runtime/profileFieldFill.ts`, `apps/api/src/runtime/paymentCardFill.ts`, plus
   adapter `post_fill_summary` (`examples/aegis-tool-server.mjs` / `examples/lib/adapter-helpers.mjs`).
   Profile/payment fill execute responses can return a **names-only safe state summary**. No
   refs are minted outside the snapshot. One snapshot + one click handoff after fills. The
   probe never reads `.value`.

5. **Protected realistic fill hardening** — `apps/api/src/runtime/protectedRealisticFill.ts`.
   Non-fillable overlay/wrapper elements **fail closed**; no more `Illegal invocation` for
   cardholder; **tag-aware input/textarea setters**; focus-unverified path avoids typing into
   the wrong target. (`buildRefSelectorExpr` in `paymentCardFill.ts` was hardened: label
   association, bounded ancestor walk, point containment, null fail-closed.)

6. **Profile autofill correctness** — `apps/api/src/runtime/profileFieldFill.ts`. Do **not**
   skip a field just because it is non-empty; compare the current value against the expected
   protected value **server-side**. Statuses: `filled` / `already_correct` /
   `corrected_existing_value` / `failed`. The Taylor → Ann Arbor mis-prefill is fixed. No old/
   expected raw values leak.

7. **Payment fill ordering** — `apps/api/src/runtime/paymentCardFill.ts`,
   `apps/api/src/routes/agent-api.ts`. `recommended_fill_order` puts **top-level
   `antigen_ref` fields before OPPWA iframe fields**; iframe fills can mark
   `page_refs_likely_stale` after the top-level refs are already consumed. **Stale refs still
   fail closed.**

8. **Screenshot-time remask / redaction resilience** —
   `apps/api/src/runtime/screenshotRedaction.ts`,
   `apps/api/src/runtime/protectedIframeRedaction.ts`. Top-level payment fields are registered
   server-side; the screenshot capture **re-resolves / remasks** protected top-level fields
   after DOM remounts (OPPWA widget re-init can replace a masked node and wipe its marker).
   If remask fails, the screenshot **fails closed** with `SCREENSHOT_REDACTION_FAILED` +
   `redaction_mismatch` instead of returning an image — it **never claims 4/4 while a
   protected value is visible**. Expiry stays protected; do **not** downgrade the metric to
   3/4.

## Latest live smoke results

- Profile city was naturally prefilled as **Taylor** and **corrected to Ann Arbor**; a second
  fill returned **`already_correct`**.
- Payment execution order used: **`expiry_combined → cardholder_name → card_number → cvv`**;
  all four fields filled.
- **4/4 redaction** reached in the prior full pass.
- A later regression surfaced **expiry visual-mask-loss** (OPPWA re-render wiped the marker),
  which was then fixed by the screenshot-time remask path (item 8) with real-Chromium tests.
- **No final Pay click; no raw sensitive values leaked.**
- **Caveat:** the final remask fix has strong real-Chromium coverage but was **not re-smoked
  live** after the tab/session was closed. Re-verify it on the next payment-stage smoke (see
  `antigen-browser-qa.md` → "Next QA milestone — focused payment-stage smoke").

## Known open issues / not blockers

- Some **adapter tests** have pre-existing banner/regex drift failures. Confirm they exist on
  clean `HEAD` before attributing them to this milestone.
- `npx tsc --noEmit` has **pre-existing unrelated errors** — do not treat them as introduced
  by this milestone unless a diff proves otherwise.
- IKEA runtime **UX noise** (chat widget, Family upsell, slow delivery-option loading) is not
  a blocker.
- **Direct navigation after the homepage must remain blocked/avoided** in the QA flow.
- If the **API background task dies**, Chrome/session/cart may be lost — restart the API and
  rerun Step 0.

## Required Step 0 flags (API process)

Set these in the shell that runs `apps/api` (not the adapter/MCP shell):

```sh
ANTIGEN_CLICK_VERIFY=true
ANTIGEN_ACTIVE_SURFACES=true
ANTIGEN_SURFACE_RESOLVE=true
ANTIGEN_LOGICAL_REF_RECOVERY=true
ANTIGEN_POINTER_TIMING=fast
ANTIGEN_BROWSER_TRACE=true
ANTIGEN_BROWSER_TIMING_DEBUG=true
ANTIGEN_BROWSER_HEADLESS=false
ANTIGEN_FILL_STATE=true
```

Then verify (HARD GATE — capture this output before recording any smoke as operator-verified):

```sh
curl -s http://localhost:4000/api/runtime/status | jq .antigen
```

Expected: `click_verify=true`, `active_surfaces=true`, `surface_resolve=true`,
`logical_recovery=true`, `pointer_timing="fast"`, `browser_trace=true`,
`timing_debug=true` (for timing/debug smoke), `fill_state=true`, `headless=false` (for headed
smoke), `cdp_port_configured=true`. The startup log line
(`[AntigenRuntimeFlags] … fill_state=… …`) must agree. The exact env table lives in
`antigen-browser-qa.md` §1 / §1b — that is the canonical source.

## Navigation discipline

- `browser_navigate` is allowed **only for the initial IKEA homepage** (e.g.
  `https://www.ikea.com/us/en/`).
- After the homepage: `antigen_snapshot` + `browser_click` on fresh `ag_*` refs; act on the
  active-surface **recommended actions** and on `post_click_state` / `post_fill_state`. Search
  goes through the visible search input via `browser_type`.
- **No raw CSS selector or JS escape hatch as a product path.**
- **No deeplink to product / cart / checkout / payment** unless it is an explicitly labeled
  **diagnostic URL-loading test** — which is recorded as a diagnostic, never as a smoke step,
  and never counts toward pass criteria.

## Safety invariants

- No raw profile / card / credential / secret values in agent responses, logs, or traces.
- No raw selectors / ids / boxes / coordinates / CDP expressions exposed.
- **No final purchase click.** Pay / Place order requires the separate
  `request_purchase_confirmation` handoff (card-fill approval is
  `purchase_not_authorized=true`).
- Screenshot redaction **fails closed on mismatch** (`SCREENSHOT_REDACTION_FAILED` +
  `redaction_mismatch`) — never claim 4/4 while a protected value is visible.
- Protected fill reports `filled` only if the value persisted/verified before masking.
- **Stale refs fail closed** and require a fresh snapshot.
- `ag_*` refs are **opaque** and resolved **server-side only**.

## Relevant commits

Milestone cluster (newest → oldest), all already committed:

| Commit | Subject |
| --- | --- |
| `50d68e1` | Expose Antigen refs and ordering for payment fills (HEAD) |
| `a8e4533` | Re-mask protected payment fields during screenshot redaction |
| `9dd3c2b` | Correct prefilled profile fields and order payment fills |
| `776bd21` | Add post-fill state and harden payment field fills |
| `ca6afcc` | Add post-fill state realization |
| `97d4084` | Resolve payment card fields by Antigen ref |
| `bc249ae` | Add Antigen runtime flag diagnostics |
| `bedbb57` | Expose post-click state realization to agents |
| `ca8d0d0` | Add active surface action resolution |
| `5931c06` | Surface active structural overlays in Antigen snapshots |

## Next recommended action

1. **Nothing to commit for the code milestone** — it is already `HEAD` and the tree was clean.
   Do not re-run the "Expose Antigen refs and ordering for payment fills" commit.
2. **Pause IKEA** for now (the payment-stage flow is demonstrated; the remask fix's live
   re-smoke is the one open verification, deferred deliberately).
3. Pick the next engineering path:
   - route-run reliability cleanup / adapter test-drift cleanup, **or**
   - a second-merchant smoke (prove the runtime generalizes beyond IKEA), **or**
   - product demo recording, **or**
   - hardening docs around approvals / receipts / the final-action gate.
