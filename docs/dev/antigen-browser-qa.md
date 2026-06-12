# Antigen Browser QA — End-to-End Manual Runbook

**Dev/QA only.** This doc records the **current verified known-good state** of the Antigen
mediated-browser QA milestone and how to reproduce it. It does **not** change product
behavior, approvals, receipts, scoring, credential policy, or checkout confirmation.

For the MCP routing/config details (why the agent must attach to the Antigen adapter and
not raw `@playwright/mcp`, the fail-closed guard, and the `npm run qa:validate-mcp`
check), see the companion doc: [`antigen-qa-mcp.md`](./antigen-qa-mcp.md). This doc is the
**full end-to-end browser QA recipe**; it intentionally does not duplicate the routing
deep-dive.

---

## What Antigen browser QA proves

The goal is to prove that an autonomous agent can browse the **real web** through
**Antigen-controlled browser tools** — not raw browser access — while:

- using realistic, human-like **navigation discipline** (no shortcut deeplinks around
  visible refs);
- using realistic **pointer movement** for clicks and typing;
- resolving elements through **`antigen_snapshot`** `ag_*` refs (not `browser_snapshot`);
- keeping **sensitive actions guarded**; and
- never exposing raw CDP URLs, coordinates, secrets, cookies/storage, or card/credential
  data in tool output.

### State boundary (read this first)

- ✅ **Verified through add-to-bag** on real IKEA: homepage → snapshot → dismiss cookie
  banner → search → results → open product → scroll Add to bag into view → add to bag →
  confirmation observed.
- ⏳ **Not yet tested:** checkout, login, shipping, contact, payment/card entry, and final
  place-order. **Place-order protection has not been proven yet.** See
  [Next QA milestone](#next-qa-milestone).

Do not describe checkout/payment/place-order as tested or protected based on this
milestone.

---

## Required local environment

The hard-mode browser logic (navigation discipline, `antigen_snapshot` ownership,
pointer realism, trace dispositions) only runs when the QA env flags are set. The
**canonical source of these vars** is the wrapper script
[`scripts/run-antigen-browser-adapter-qa.sh`](../../scripts/run-antigen-browser-adapter-qa.sh):

| Var | Where | Value | Purpose |
|---|---|---|---|
| `AEGIS_API_BASE` | adapter | `http://localhost:4000` | API base. Adapter exits if unset. |
| `AEGIS_AGENT_TOKEN` | adapter | `pass_demo_001` | Delegation/bearer token. Adapter exits if unset. |
| `ANTIGEN_BROWSER_HEADLESS` | adapter | `false` | Visible mode → enables realistic-input interception. |
| `ANTIGEN_INPUT_REALISM` | adapter | `realistic` | Per-char typing / pointer realism. |
| `ANTIGEN_BROWSER_TRACE` | adapter | `true` | POST tool/navigation disposition events to the run trace. |
| `ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS` | adapter | `true` | Hard mode: Antigen-owned actions fail loudly; raw `browser_snapshot` blocked. |
| `ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION` | adapter | `true` | Navigation-discipline hard mode. |
| `ANTIGEN_ADAPTER_REQUIRE_QA_ENV` | adapter | `true` | Fail-closed guard. Adapter FATALs before serving tools if any QA flag is missing. |
| `ANTIGEN_POINTER_DEBUG_OVERLAY` | **API** | `true` | Pointer-path debug overlay (set on the API process, not the adapter). |
| `ANTIGEN_CDP_DIAGNOSTICS` | **API** | `true` | CDP diagnostics (set on the API process). |
| `ANTIGEN_FILL_STATE` | **API** | `true` | `post_fill_state` realization envelope on the profile/payment fill execute responses (+ `post_fill_summary` in adapter output). |
| `ANTIGEN_ACTIVE_SURFACES` | **API** | `true` | Active-surface enrichment in snapshots and surface actions in post-states. |
| `ANTIGEN_CLICK_VERIFY` | **API** | `true` | `post_click_state` verification on `browser_click`. |
| `ANTIGEN_SURFACE_RESOLVE` | **API** | `true` | Surface-scoped stale-ref re-resolution inside live overlays. |
| `ANTIGEN_LOGICAL_REF_RECOVERY` | **API** | `true` | Same-page logical re-find for box-drift stale refs (click-only). |

> The CDP endpoint is **not** an env var — the adapter resolves it at runtime via
> `POST /api/agent/v1/runtime/browser-endpoint`. The rows marked **API** are
> **API-process** flags: export them in the shell that runs `npm run dev` for
> `apps/api` — NEVER only in the adapter/MCP shell. A flag set on the adapter but
> not the API silently looks inactive (this exact mistake made `post_fill_state`
> absent during a live smoke while everyone believed it was on). Step 0 below
> catches it.

**The invariant that matters is not wrapper-vs-inline launch** (see
[Launching the adapter](#launching-the-adapter-macos--claude-local-mcp)) — it is that the
adapter starts with **all required QA env present** and the **fail-closed guard on**.

---

## Reproduce the known-good QA state

### 1. Start the API for visible realistic QA

Run the API with the FULL API-side env (hard mode + realization flags):

```sh
ANTIGEN_BROWSER_TRACE=true \
ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS=true \
ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION=true \
ANTIGEN_INPUT_REALISM=realistic \
ANTIGEN_BROWSER_HEADLESS=false \
ANTIGEN_POINTER_DEBUG_OVERLAY=true \
ANTIGEN_CDP_DIAGNOSTICS=true \
ANTIGEN_FILL_STATE=true \
ANTIGEN_ACTIVE_SURFACES=true \
ANTIGEN_CLICK_VERIFY=true \
ANTIGEN_SURFACE_RESOLVE=true \
ANTIGEN_LOGICAL_REF_RECOVERY=true \
npm run dev
```

### 1b. Step 0 — verify the API process flags (HARD GATE, before any smoke)

```sh
curl -s http://localhost:4000/api/runtime/status | jq .antigen
```

Require, at minimum: `fill_state=true`, `active_surfaces=true`, `click_verify=true`,
`headless=false`, `cdp_port_configured=true`. The startup log line
(`[AntigenRuntimeFlags] … fill_state=… …`) must agree.

**A smoke run may NOT be recorded as "operator-verified" unless this gate's
output was captured first.** In the 2026-06-11 live IKEA smoke, Step 0 was
skipped ("recorded as operator-verified" without curling) and `ANTIGEN_FILL_STATE`
turned out to be unset on the API process — every `post_fill_state` assertion was
silently vacuous. The flags endpoint exists precisely to make this a 2-second check.

### 2. Seed demo data

```sh
npm run seed:demo
```

This writes the demo routes/skills/delegations/collars/workspace **and real `passes`
records** for `pass_demo_001` and `pass_demo_002`
(`apps/api/scripts/seed-demo-data.mjs`). This is required: `requireAgentToken()`
resolves a bearer token by **raw token against `passes.values()`**. If the `passes`
records are missing (older seed data wrote `passes: []`), bearer auth returns
**`401 INVALID_TOKEN`** even when the matching `agentDelegations` row exists.

After (re)seeding, **restart or reload the API** so it picks up the seeded store.

### 3. Verify the runtime browser endpoint

Confirm bearer auth + runtime provisioning work before driving the agent:

```sh
curl -i -X POST http://localhost:4000/api/agent/v1/runtime/browser-endpoint \
  -H "Authorization: Bearer pass_demo_001" \
  -H "Content-Type: application/json" -d '{}'
```

Expect **`201 Created`** with a runtime body that includes a `cdp_url`. (`cdp_url` is for
internal runtime use only — it is never forwarded to agent-facing tool output.) A `401`
here means re-run step 2 and restart the API.

### 4. Launching the adapter (macOS / Claude local MCP)

The adapter must be the agent's browser surface. The canonical env lives in the wrapper
script, **but on macOS with Claude's local MCP launcher, executing the wrapper script
directly can fail with "Operation not permitted."** The known-good form is to **inline**
the wrapper's exports through `/bin/bash -lc … exec node …` in `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "antigen-browser": {
      "command": "/bin/bash",
      "args": [
        "-lc",
        "export AEGIS_API_BASE='http://localhost:4000'; export AEGIS_AGENT_TOKEN='pass_demo_001'; export ANTIGEN_BROWSER_HEADLESS='false'; export ANTIGEN_INPUT_REALISM='realistic'; export ANTIGEN_BROWSER_TRACE='true'; export ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS='true'; export ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION='true'; export ANTIGEN_ADAPTER_REQUIRE_QA_ENV='true'; exec /usr/local/bin/node <ABSOLUTE_PATH_TO_REPO>/examples/antigen-browser-adapter.mjs"
      ]
    }
  }
}
```

This is exactly the wrapper script's body, inlined. The wrapper
(`scripts/run-antigen-browser-adapter-qa.sh`) remains the canonical source of these vars
and is still convenient for terminal/manual runs — it is just not the right launch shape
for Claude's MCP launcher on macOS. Either way, the requirement is identical: **all QA
env present + fail-closed guard on.** Restart the agent's MCP session after editing the
config — changes are not picked up live.

> Do **not** register a raw `playwright` server or pre-allowlist `mcp__playwright__*`
> tools during QA — that lets the agent bypass the adapter. See
> [`antigen-qa-mcp.md`](./antigen-qa-mcp.md) and run `npm run qa:validate-mcp`.

### 5. Confirm "good" adapter logs

In the `antigen-browser` MCP server's **stderr**, at startup you must see:

```
[antigen-browser@<VERSION>] ANTIGEN BROWSER ADAPTER ACTIVE — this is the Antigen adapter, NOT raw @playwright/mcp. ...
[antigen-browser@<VERSION>] adapter loaded headless=false realism=realistic interception_will_be=ENABLED_pending_runtime
[antigen-browser@<VERSION>] qa_flags require_realistic_navigation=true require_antigen_tools=true browser_trace=true
```

Then, once the first browser tool initializes the runtime, you must also see:

```
[antigen-browser@<VERSION>] headed_intent=visible cdp_url=http://localhost:9222 browser_runtime_id=tbsess_... reused_existing=false
[antigen-browser@<VERSION>] expected to be VISIBLE/headed — a Chrome window should be on screen. ...
```

- `headed_intent=visible` confirms the adapter sent `mode:"visible"` to the runtime
  endpoint (the launch decision is server-side; the adapter propagates the intent). If you
  see `headed_intent=headless`, `ANTIGEN_BROWSER_HEADLESS` is not `false` in the adapter env.
- The matching **API** log line proves the launch mode: `[TaskBrowser] launched … mode=visible
  headless_arg=false …`. If the API shows `mode=headless` while the adapter requested
  `visible`, a **stale headless session was reused** (`[RuntimeEndpoint] mode_mismatch …`) —
  kill Chrome on 9222 and restart (see the visibility checklist below).
- `headless=false realism=realistic` confirms visible + realistic-input mode.
- `require_realistic_navigation=true require_antigen_tools=true browser_trace=true`
  confirms hard mode.
- If you instead see the **`FATAL: Antigen QA adapter launched without required QA env`**
  block, Claude launched a **cached direct command** with no QA env — fix the MCP config
  (step 4) and restart the session.
- If you see **neither** the banner nor the FATAL block, the agent is on **raw
  Playwright** — fix the config and restart.

---

## Headed runtime visibility checklist

If actions appear to succeed but **no Chrome window is visible**, the runtime almost
certainly launched **headless**. The headed/headless choice is made **server-side** in
`createTaskBrowserSession` (`apps/api/src/runtime/taskBrowserSessions.ts`); the adapter's
`ANTIGEN_BROWSER_HEADLESS` env only governs adapter-side realism. The adapter now
propagates intent by sending `mode:"visible"` to the runtime endpoint when
`ANTIGEN_BROWSER_HEADLESS=false`, so a **fresh** launch is headed — but a **reused** stale
headless session on 9222 stays invisible. Run through this before each visible QA:

1. **Kill any stale Chrome bound to 9222** (so reuse can't bind a leftover headless session):

   ```sh
   lsof -ti tcp:9222 | xargs kill        # then confirm the port is free:
   lsof -nP -iTCP:9222 -sTCP:LISTEN || echo "9222 free"
   ```

2. **Restart the API and the Claude MCP servers.** Start the API with
   `ANTIGEN_BROWSER_HEADLESS=false` (step 1 of the reproduce section) as belt-and-suspenders —
   the adapter `mode:"visible"` propagation is the primary mechanism, but a headed API env is a
   valid fallback. Restart the agent's MCP session so adapter env changes are picked up.

3. **Run the diagnostic:**

   ```sh
   npm run diagnose:antigen-browser        # add --no-provision for a pure read-only pass
   ```

4. **What good output looks like:**
   - `token … pass_demo_001` resolves to `agent_id agent_demo_001` / `delegation_id delg_demo_001`;
   - CDP reachable on `http://localhost:9222`;
   - **exactly one usable page target** (a real page, not `about:blank`/`chrome://`);
   - runtime endpoint returns the **same** `cdp_url` (`http://localhost:9222`);
   - **Warnings: none**;
   - adapter stderr shows `headless=false`, `headed_intent=visible`, and `token_self_check ok`;
   - API log shows `[TaskBrowser] launched … mode=visible headless_arg=false`.

5. **What bad output means:**
   - **multiple page targets** → `@playwright/mcp` may bind the wrong tab; close extra tabs;
   - **`chrome://settings/help` selected** → target-selection confusion; open the real page first;
   - **CDP unreachable** → no browser on 9222; start QA / re-provision;
   - **runtime endpoint `cdp_url` differs** from the diagnostic's → adapter and inspection are on
     different Chrome instances; kill strays and restart;
   - **API log shows `mode=headless`** (or `[RuntimeEndpoint] mode_mismatch …`) → env not reaching
     the launch, or a stale headless session was reused → repeat step 1 and restart.

---

## Navigation discipline for smoke prompts (binding)

Smoke prompts must instruct the agent — and reports must verify — the following:

- **Direct `browser_navigate` is allowed ONLY for the initial homepage load**
  (e.g. `https://www.ikea.com/us/en/`). Everything after that is normal site flow.
- All subsequent movement: `antigen_snapshot` → `browser_click` on fresh `ag_*`
  refs → act on `post_click_state` / `post_fill_state` and the active-surface
  recommended actions. Search happens through the visible search input via
  `browser_type`.
- **Never `browser_navigate` directly to product / cart / checkout / payment
  URLs.** The adapter's `ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION=true` hard
  mode enforces this fail-closed (`ANTIGEN_REALISTIC_NAVIGATION_REQUIRED`), but
  the prompt must not ask for it in the first place.
- The sole exception is an **explicitly labeled diagnostic URL-loading test** —
  which must be recorded in the report as a diagnostic, never as a smoke step,
  and never counts toward smoke pass criteria.
- A run that reaches payment through clicks is a **full site-flow setup** and the
  report should say so; a deeplink shortcut is not a valid payment-stage smoke.

## Successful IKEA QA recipe

Drive the agent through this exact flow. **Stop before checkout/login/shipping/payment/
place-order.**

1. Navigate to the IKEA homepage.
2. Take an **`antigen_snapshot`** (not `browser_snapshot`) to obtain `ag_*` refs.
3. Dismiss the cookie banner via the `ag_*` **Ok** button.
4. Search **"bookcase"** through the **visible search input** using `browser_type`.
5. Confirm search results render.
6. Open the **BILLY** bookcase product via its `ag_*` ref.
7. Scroll **Add to bag** into view with `browser_scroll_to_ref`.
8. Take a fresh `antigen_snapshot` and click **Add to bag** via a **fresh** `ag_*` ref.
9. Observe the confirmation: **"BILLY was added to your shopping bag."**
10. **Stop.** Do not proceed to checkout, login, shipping, or payment.

### Expected successful `browser_type` markers

A good realistic-input `browser_type` returns:

- `path=realistic_success`
- `submitted=true`
- a **positive** `pointer_path_point_count`
- `pointer_start_source=session`
- `pointer_state_persisted=true`

`browser_click` likewise returns realistic pointer metadata, and pointer state persists
across actions.

### Expected direct-navigation blocked result

Direct same-site search-URL navigation is **fail-closed**. Navigating directly to, e.g.:

```
https://www.ikea.com/us/en/search/?q=bookcase
```

is blocked with **`ANTIGEN_REALISTIC_NAVIGATION_REQUIRED`**. The supported path is
input-driven search via a visible `ag_*` search input, which returns
`path=realistic_success`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `FATAL: … launched without required QA env` in adapter stderr | Claude ran a **cached direct command** (`node examples/antigen-browser-adapter.mjs`) with no QA env | Point `.mcp.json` at the inline-bash form (step 4); restart the MCP session. The fail-closed guard is working as designed. |
| Wrapper script won't launch; "Operation not permitted" | macOS blocks Claude's MCP launcher from executing the `.sh` directly | Use the **inline `/bin/bash -lc … exec node …`** form (step 4) instead of pointing at the wrapper. |
| `401 INVALID_TOKEN` on `/runtime/browser-endpoint` | No `passes` record for `pass_demo_001` (`agentDelegations` exists but `passes` was empty) | `npm run seed:demo`, then restart/reload the API. Verify with the step-3 curl. |
| No visible Chrome / no `cdp_url` | CDP port **9222** not listening; runtime not provisioned | Confirm the API is running with the step-1 env; re-call the browser-endpoint; check that `headless=false`. |
| Actions succeed but **no Chrome window appears** | Runtime launched **headless** (API env not set), or a **stale headless session on 9222 was reused** | Run the [Headed runtime visibility checklist](#headed-runtime-visibility-checklist): kill Chrome on 9222, restart API+MCP, run `npm run diagnose:antigen-browser`, confirm API log `mode=visible`. |
| Click/scroll fails on a known element | **Stale / out-of-viewport `ag_*` ref** | Take a **fresh `antigen_snapshot`** and/or `browser_scroll_to_ref`, then use the new ref. Never reuse a stale ref — ref validation is fail-closed (stale/expired/out-of-viewport/not-found/not-clickable/invalid all reject). |
| Adapter says realism `DISABLED` / no interception | `headless` not `false`, or `realism` is `fast`/`disabled`/`false` | Set `ANTIGEN_BROWSER_HEADLESS=false` and `ANTIGEN_INPUT_REALISM=realistic`. Visible mode is required for realistic interception **and** for watching QA. |

---

## Invariants (must remain true)

- `ag_*` ref validation is **fail-closed** for stale, expired, out-of-viewport, not-found,
  not-clickable, or invalid refs.
- Realistic-navigation QA is **fail-closed** for direct same-site URL jumps
  (`ANTIGEN_REALISTIC_NAVIGATION_REQUIRED`).
- Browser tool output must **never** expose raw CDP URLs, coordinates, secrets, raw
  cookies/storage, raw card data, or raw credential data. **Coordinates are
  dev-log-only.**
- `browser_snapshot` is **not** used in QA flows — use `antigen_snapshot`. In hard mode,
  raw `browser_snapshot` is blocked.
- Pointer paths are **viewport-bounded** (generated path points are clamped to the
  viewport before dispatch while the real final click target is preserved). Intermediate
  human-like overshoot is **not** fail-closed — only the dispatched path is bounded.

---

## Current checkout blocker / next milestone

**Status (2026-06-07):** the IKEA checkout-boundary QA reached the contact/shipping form. The
following are **verified**: add-to-bag, cart, checkout start, continue-as-guest, and arriving at the
customer-information / billing-address form. Navigation, `antigen_snapshot`, viewport-bounded
realistic pointer paths, and realistic `browser_type` on the search input all worked.

**What blocked profile fill, and the fix (Checkout Profile Field Fill v1):**

1. **MCP token mismatch (root cause of `INVALID_TOKEN`).** The `antigen-browser` adapter and the
   `aegis` MCP server were configured with **different delegation tokens** (`pass_demo_001` vs
   `pass_demo_002`), so `request_profile_field_fill` ran under a different delegation than the one
   that owned the browser session. Fixed by aligning both to **one delegation** (`pass_demo_001`,
   `delg_demo_001`). Both adapters now run a **startup token self-check** against
   `GET /api/agent/v1/me` and print the resolved `agent`/`delegation` to stderr — a mismatch is now
   loud at boot instead of a confusing `INVALID_TOKEN` mid-checkout. The
   `TASK_BROWSER_SESSION_FORBIDDEN` error now names the token-mismatch cause explicitly.
2. **Checkout DOM volatility.** Delivery/billing panels re-render and regenerate element ids, so a
   captured snapshot ref or `#id` selector missed (`ELEMENT_NOT_FOUND` / `ANTIGEN_REF_EXPIRED` /
   `ANTIGEN_REF_STALE` / `ROLE_KIND_MISMATCH`). The profile-field-fill executor now **resolves fields
   semantically**: it enumerates candidate fields once (structural metadata only — never values) and
   a pure scorer (`pickProfileFieldCandidate`) picks the best match by autocomplete, accessible
   label, placeholder, and name/id, then **verifies kind consistency and fails closed** on a
   mismatch. Resolution is reused via a stable `[data-antigen-fill-id]` handle, immune to id
   regeneration. This recovery lives **only** inside the profile-field-fill executor — generic
   `browser_type` / `browser_click` / `ag_*` ref validation are unchanged and remain fail-closed.

**Scope of this increment:** contact/shipping profile fields only
(`email, phone, first_name, last_name, shipping_address_line1/2, city, region, postal_code,
country`). **Payment card fill and final place-order/purchase approval are NOT in scope and are NOT
proven.** Do not claim payment entry or place-order protection has been tested.

**Local fixture:** `apps/mock-store/hydrated-checkout.html` re-renders contact/shipping inputs with
fresh ids every 2.5s while keeping labels/placeholders/autocomplete stable — use it to demonstrate
the executor resolves fields that a fixed-id selector or generic `browser_type` would miss.

**Seeded profile data (no mid-run prompt):** `seedProfileMemory()` in
`apps/api/src/store/persistence.ts` auto-seeds **fake, regression-safe** profile values for
`user_001` on **every** API start — including the load-from-existing-store path (it is idempotent by
`user_id`+`field_kind`, so it never overwrites a value you supplied via the missing-value prompt).
Seeded fields: `first_name=Alex`, `last_name=Demo`, `email=alex@aegisdemo.local`,
`phone=15551234567`, `shipping_address_line1=123 Main St`, `city=Ann Arbor`, `region=MI`,
`postal_code=48104`, `country=US`. These are fake test values only — never real PII. Raw values are
KMS-encrypted and flow **only** through the protected CDP profile-fill path
(`request_profile_field_fill` → `execute_profile_field_fill`); the agent receives masked summaries
and `raw_profile_value_revealed_to_agent: false`. Because of this, the IKEA checkout smoke should get
`status: "pending"` (a real `fill_request_id`) — **not** `pending_user` — for these fields and must
not prompt you mid-run.

**Masked / placeholder values are not "filled":** the snapshot reports `value.present: false`
(and `value.placeholder_only: true`) for input-mask templates such as `+1-___-___-____`, partially
filled masks (`+1-555-___-____`), and formatting-only values. A field counts as filled only when it
holds a real, complete value. `value.length` is still the raw length, and emails/usernames with an
embedded underscore (`a_b@example.com`) are **not** misclassified. This only changes what the
snapshot reports — `browser_set_value`/`browser_fill` exact-replacement + idempotency are unchanged.

---

## Next QA milestone — focused payment-stage smoke

The 2026-06-11 live IKEA smoke verified the checkout flow through payment with two
defects, both since fixed in code: `post_fill_state` absent (API flag unset — see
Step 0) and the cardholder_name `Illegal invocation` (floating-label resolution —
fixed in `buildRefSelectorExpr` + the protected-fill tag gate). The next run
re-verifies the payment stage:

1. **Step 0 hard gate first** (section 1b): capture `/api/runtime/status` output;
   `fill_state`, `active_surfaces`, `click_verify` must be `true`.
2. Reach payment through **full site flow** (navigation discipline above): homepage
   navigate once → cookie → search → product → add to bag → cart → checkout →
   continue as guest → profile fill (`request_profile_field_fill` →
   `execute_profile_field_fill`) → one-snapshot + one-click handoff to payment.
3. Card fill: `request_payment_card_fill` for **card_number, cvv, expiry_combined,
   cardholder_name** with fresh `ag_*` refs; user approves at `/route-run-approvals`;
   `execute_payment_card_fill_handoff` per field.
4. Pass criteria:
   - **cardholder_name fills** via `element_hint.antigen_ref` — no
     `Illegal invocation`, no `TARGET_NOT_FILLABLE`.
   - Every fill execute response includes **`post_fill_state`** (realized outcome —
     not absent) and the adapter output includes **`post_fill_summary`**.
   - **Redaction metric = 4/4 means ACTUAL visible protection**: card_number, cvv,
     expiry_combined, AND cardholder_name are each genuinely blacked out (or
     otherwise visually protected) **in the rendered screenshot** — not merely
     counted by a registry or by leftover `data-antigen-masked` markers. A stale
     marker on a detached/replaced node does NOT count. (All four have
     `visualMask=true` in `paymentCardFill.ts`; billing ZIP is intentionally
     visible and excluded from the metric.)
   - **Re-render resilience**: hydrated checkouts (OPPWA widget re-init after
     PAN/CVV iframe fills) can replace a masked top-level node and wipe its
     marker. The screenshot path verifies every registry-recorded top-level
     protected field at capture time and re-masks the live node; if a field
     cannot be safely re-located it FAILS CLOSED with
     `SCREENSHOT_REDACTION_FAILED` + `redaction_mismatch` instead of returning an
     image — it must never claim 4/4 while a protected value is visible. A
     mismatch failure or a `post_fill_state.masking.top_level_mask_missing` flag
     is a defect to investigate — do **not** lower the metric to 3.
   - No raw sensitive values in any response, snapshot, screenshot, or the network
     trace.
   - **Pay / place-order is never clicked.** Card-fill approval is
     `purchase_not_authorized=true`; final submission requires the separate
     `request_purchase_confirmation` handoff, which must NOT be invoked.
5. Close the session; the report must state the run was a full site-flow setup
   (not a deeplink shortcut).

Until this milestone is run and verified, do not claim payment entry or place-order
protection has been re-proven after the cardholder/post_fill_state fixes.
