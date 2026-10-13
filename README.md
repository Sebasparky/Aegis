# Aegis

**A local trust layer for AI browser agents.** It provides scoped delegation, human approval gates, credential injection that withholds plaintext from the agent tool protocol, human-verification stop conditions, and signed audit receipts.

An autonomous agent keeps its own planner and browser tools. Aegis sits at the points where the agent would commit to something: logging in, paying, submitting, or getting past a verification wall. At each one it decides whether the action is allowed, blocked, or needs a person to approve it, and it records what happened.

I built this solo as a research prototype: 346 commits on `main` between April and June 2026, in TypeScript across a Fastify API, a Next.js UI, a Playwright runtime, and MCP tool servers. It runs on localhost only. It is not a hosted product and has no user authentication.

> The web UI is branded **Antigen**. "Antigen" also names the browser adapter and snapshot subsystem (`ANTIGEN_*` flags, `ag_N` element references). The code, packages, and environment variables use **Aegis**. Both names refer to this one project.

**Key links:** [Architecture](#architecture) · [Quick start](#quick-start) · [Security model](docs/security-model.md) · [Verification status](docs/verified-status.md) · [Demo runbook](docs/demo.md)

### What is implemented

- **Scoped delegation ("collars").** Collars are revocable policy objects that define allowed actions, actions that need approval, blocked actions, spending limits, and expiry. External agents authenticate with a bearer pass, and the server resolves it to a delegation. Identity is never read from the request body.
- **Rule-based sensitive-action detection and policy evaluation.** Detected actions include purchases, logins, OAuth grants, deletions, and credential saving. Policy is evaluated in a fixed order, and when an action is uncertain the default is to require approval.
- **Approval gates that fail closed.** On five paths, authority is released only after an Ed25519-signed approval record has been created, and if signing fails, the approval fails. The five are the guard loop, route runs, credential authorizations (the primary login path), card fills, and purchase confirmations. Six secondary or experimental approval paths do not yet require a signed record before release: standalone injection, authenticated sessions, extension credential sessions, account creation, challenge-code submission, and email-challenge resolution. They are listed in the [security model](docs/security-model.md#4-approval-gates-and-where-they-fail-closed). External agents cannot approve their own requests.
- **Credential injection over the Chrome DevTools Protocol.** Secrets are encrypted with AES-256-GCM behind a KMS abstraction. After the user approves, the API decrypts the secret server-side and types it into the agent's browser. The plaintext is never returned by any Aegis API response, Aegis MCP tool, receipt, or Antigen snapshot. (Forwarded Playwright tools can still read the filled page; see [Limitations](#limitations).)
- **Antigen browser adapter.** An MCP proxy wraps `@playwright/mcp` and adds stable `ag_N` element references with revalidation and click verification. It also provides an exact-replacement form fill that refuses credential, identity, and payment fields.
- **Human-verification stop conditions.** The adapter detects CAPTCHA, press-and-hold, and cross-origin verification walls and returns `409 HUMAN_VERIFICATION_REQUIRED`. It never tries to solve them. Email, SMS, and TOTP codes are entered by the user in the UI, injected once, and never returned to the agent.
- **Audit receipts.** Approval receipts and route-run authorizations are EdDSA-signed but not chained. Route-run execution receipts are hash-chained and signed. For the optional Supabase backend, a provided SQL migration adds an append-only trigger ([`docs/supabase/002_signed_immutable_receipts.sql`](docs/supabase/002_signed_immutable_receipts.sql)). It has not been verified against a live project.
- **Agent-facing surfaces.** A versioned `/api/agent/v1` HTTP contract, plus an MCP tool server with 76 tools that any MCP-capable agent can use.

The repository has no screenshots or recordings. To see the system, run the [local demo](#quick-start).

---

## Architecture

```
 External agent (any MCP client, e.g. Claude Code)
   │
   ├── examples/antigen-browser-adapter.mjs   MCP proxy around @playwright/mcp:
   │                                          ag_N refs, exact fill, sensitive-field refusal,
   │                                          human-verification detection
   └── examples/aegis-tool-server.mjs         MCP server (76 tools) → HTTP
                │
                ▼  Authorization: Bearer <pass>
 apps/api  (Fastify, loopback only)
   routes/agent-api.ts        /api/agent/v1: pass → delegation → collar
   detection/                 rule-based sensitive-action classification
   policies/evaluate.ts       collar + session + spending + counterparty rules
   routes/approvals.ts,       approval inbox; signed approval receipt before release
     route-runs.ts
   runtime/                   Playwright runtime, CDP secret injection, task-browser
                              lifecycle, Antigen snapshot runtime, HV detection
   lib/kms.ts                 AES-256-GCM vault behind a KMS provider interface
   lib/receiptHash.ts,        hash chaining + Ed25519 JWS
     receiptSigning.ts
   store/persistence.ts       local JSON file (default) or Supabase for vault + receipts
                │
                ▼
 apps/web (Next.js)           approvals, receipts, collars, demo, human-verification UI
 apps/mock-store              static fake store, bank, and checkout pages for demos and tests
 packages/types               shared types; "never revealed" fields are literal `false` types
```

The agent does the browsing, reading, and planning. Aegis steps in only at the sensitive boundary: credential fields, payment steps, approval gates, verification walls, and receipts.

Other directories: `apps/extension` is an optional Chrome MV3 recorder used to teach routes. `apps/mcp-server` is an early 8-tool MCP server for the original guard loop and has been superseded by `examples/aegis-tool-server.mjs`.

## Engineering decisions

- **Enforcement sits outside the model.** Collars, approvals, and secret release are enforced by the API and runtime, not by prompt instructions. An agent that ignores its instructions still cannot approve itself, read a vault secret through the API, or fill a password field with the generic fill tool.
- **The trust boundary is the loopback interface, enforced in code.** Internal routes have no authentication and act as one mock user. The API therefore refuses to bind to anything other than `127.0.0.1`, `::1`, or `localhost` and exits with `UNSAFE_API_BIND_HOST` otherwise. No override flag exists ([`apps/api/src/lib/apiBindHost.ts`](apps/api/src/lib/apiBindHost.ts)).
- **The type system encodes secrecy invariants.** Fields such as `raw_value_revealed_to_agent` and `raw_code_revealed_to_agent` are declared as the literal type `false`, so the compiler rejects code that tries to set them to anything else.
- **Approvals fail closed.** The main approval paths refuse to release authority unless a signed approval receipt was created (for example [`apps/api/src/routes/approvals.ts`](apps/api/src/routes/approvals.ts)).
- **One approval covers one use.** A credential authorization lets the username be filled once and the password once. After that it is marked fulfilled and refuses any reuse.
- **Each task gets an ephemeral browser.** Chrome launches with a fresh temporary profile. Password saving, autofill, and sync are disabled, and the profile is deleted on exit.
- **Routes are declarative.** Verified workflow routes are inspectable data (steps, semantic locators, value policies) and contain no executable scripts.

## Quick start

This runs the local synthetic demo. No real website, account, card, or credential is used. Requires Node 20 and npm 10; it has been tested on macOS. Full runbook and troubleshooting: [docs/demo.md](docs/demo.md).

```bash
npm ci
npx playwright install chromium
cp .env.example .env
```

Generate a receipt-signing keypair. The command prints two lines and writes nothing to disk. Paste them into `.env`, replacing the two `AEGIS_RECEIPT_JWS_*` placeholder lines:

```bash
node apps/api/scripts/generate-receipt-keypair.mjs
```

Generate a local KMS key and set it as the `AEGIS_LOCAL_KMS_KEY_B64` value in `.env`, replacing the placeholder:

```bash
openssl rand -base64 32
```

Check the configuration (this prints variable names and pass/fail only), seed the demo data, and start the services:

```bash
npm run demo:preflight
npm run seed:demo
npm run dev
```

`npm run dev` starts the API on `127.0.0.1:4000`, the web UI on `127.0.0.1:3000`, and the mock store on `127.0.0.1:3001`. It also starts the legacy stdio MCP server, which you can ignore. Open **http://localhost:3000/demo** and use `localhost` rather than `127.0.0.1`, because the API's CORS allowlist names `localhost`. Then click **Run demo**:

1. A pass tied to the seeded collar opens a Chromium session on the fake checkout page and clicks "Place Order".
2. Aegis classifies the click as a purchase. The collar requires approval, so the session pauses with `approval_required`.
3. Click **Approve**. Aegis creates a signed approval receipt, a runner completes the step with seeded fake data, and a receipt appears.

## Verification

```bash
npm -w apps/api test
node --test examples/antigen-browser-adapter.test.mjs
node --test examples/aegis-tool-server.test.mjs
node --test scripts/validate-antigen-qa-mcp.test.mjs
```

On the most recent local run (macOS, Node 20.20), all four commands passed. The API suite ran 2,716 tests, with 12 skipped by design; the three `node:test` files ran 208 tests. The API suite uses Vitest with a single fork because the tests share one in-memory store. Tests run against local fixtures; Chromium-backed suites skip automatically when Chromium is not installed. Some suites run only when you opt in with `ANTIGEN_VGC_REAL_SESSION_TEST=true` or `ANTIGEN_BENCHMARK=true`. There is no CI.

**Known failures:**

- `npm run typecheck` fails in `apps/api` with 202 TypeScript errors, most of them in test files. Vitest does not type-check, so the tests still pass.
- `npm run build` fails on those same errors. It also fails because the `/demo-travel` page cannot be prerendered.

Neither failure affects `npm run dev`. Details and the environment of the recorded run are in [docs/verified-status.md](docs/verified-status.md).

## Current status

The local demo, the external agent API, the MCP tool server, and the browser adapter all work against the code in this repository. Beyond the synthetic fixtures, about a dozen documented sessions have run on real sites. They include an approval-gated GitHub username/password login and an IKEA flow from search through card-field fill; the final purchase click was never made. Details are in [docs/verified-status.md](docs/verified-status.md).

## Limitations

- **Credential secrecy is protocol-level, not browser isolation.** Aegis keeps plaintext out of the agent tool protocol and gates its release behind approval. The agent controls the same browser, though, and by default the adapter forwards `@playwright/mcp` tools such as `browser_snapshot`, `browser_evaluate`, and `browser_run_code_unsafe`. After an approved injection, an agent could therefore read the filled field from the page.
- **The injection domain is checked when the request is made, not when it executes.** If no open tab matches the domain at execution time, CDP target selection falls back to another tab.
- **There is no user authentication, and the API runs on loopback only.** A single mock user is assumed, and the seeded demo bearer tokens are public.
- **Key management is development-grade.** The `local_dev` KMS provider is for development only; the cloud KMS provider is a stub that always throws. Persistence defaults to a local JSON file. Supabase is optional and covers only the vault and receipts.
- **Not every approval path is signed.** Six secondary or experimental approval paths release without requiring a signed record (see above).
- **Receipt guarantees vary by type.**
  - Approval receipts and route-run authorizations are hashed and signed but not chained.
  - Route-run receipts are chained and signed. In local mode, though, signing is best-effort and the chain metadata is held in memory.
  - The general `/demo` activity receipt is a plain record.
- **No real payments.** The payment and travel demos use mock pages and a seeded test card. The one live checkout run stopped before the final purchase click, and no real payment has been submitted.
- **Human-verification detection is narrowly validated:** on synthetic fixtures and one live press-and-hold wall.
- **Some paths are macOS-specific or need the network.** The task-browser launcher expects macOS Chrome paths; the `/demo` path uses bundled Chromium. The browser adapter fetches `@playwright/mcp@latest` through `npx` when it starts.
- **Design notes are mixed in.** Much of `docs/` is working design notes and session logs from development. For the current, code-backed picture, start with the three documents linked below.

## Documentation

- [docs/security-model.md](docs/security-model.md): what is enforced, where, and what is not
- [docs/verified-status.md](docs/verified-status.md): test inventory, recorded runs, and what has not been verified
- [docs/demo.md](docs/demo.md): demo runbook and troubleshooting
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/AEGIS_RAILS.md](docs/AEGIS_RAILS.md), [docs/antigen-snapshot/](docs/antigen-snapshot/): design documents (broader than the current implementation)
- [examples/README.md](examples/README.md): external-agent client examples

## License

No license has been chosen yet. Until one is added, all rights are reserved.
