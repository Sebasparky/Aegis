# Local synthetic demo

A sixty-second walk through the guard loop: an agent with scoped authority tries to place an order on a fake store, Aegis pauses it, a human approves, a signed approval receipt is recorded, and the step completes.

Everything in this demo is synthetic:

- **No real website.** The store is static HTML served from `apps/mock-store` on `127.0.0.1:3001`. Its "Place Order" button posts nowhere.
- **No real account.** The pass and collar are created by the seed script and bound to one mock user.
- **No real payment method.** The seeded card is Stripe's published test number, encrypted at seed time with a local development key.
- **No real credentials.** The seeded login pass uses a fake username and a fake password.
- **No network exposure.** The API refuses to start on a non-loopback address.

## Prerequisites

Node 20 LTS and a clean checkout. The commands below install project dependencies and one Chromium build used only by the local runtime.

```bash
npm ci
npx playwright install chromium
```

## Keys

Approvals fail closed without an Ed25519 signing keypair. Generate one locally; it prints two lines and writes nothing to disk.

```bash
cp .env.example .env
node apps/api/scripts/generate-receipt-keypair.mjs
```

Paste the two printed lines into `.env`, replacing the placeholder `AEGIS_RECEIPT_JWS_*` lines. Then generate a local KMS key and put it in place of the `AEGIS_LOCAL_KMS_KEY_B64` placeholder:

```bash
openssl rand -base64 32
```

`.env` is gitignored. Do not commit it and do not paste its contents anywhere.

## Preflight

The preflight script checks the keys without printing them and fails with the exact fix if something is missing.

```bash
npm run demo:preflight
```

## Run

```bash
npm run seed:demo
npm run dev
```

This starts the API on `127.0.0.1:4000`, the web UI on `127.0.0.1:3000`, and the mock store on `127.0.0.1:3001`. Then confirm all three are up:

```bash
npm run demo:preflight:live
```

## The sixty seconds

1. Open `http://localhost:3000/collars` and open the starter collar. This is the scoped authority: browsing and adding to cart are allowed; purchases require approval.
2. Open `http://localhost:3000/demo` and click **Run demo**. The page creates a pass tied to that collar, opens a protected Chromium session, navigates to the fake checkout, and clicks "Place Order".
3. The guard classifies the click as a purchase, checks the collar, and pauses. The page shows `approval_required` with the rule that triggered it. Nothing has been submitted.
4. Click **Approve**. Before any authority is released, Aegis creates an Ed25519-signed approval receipt. If signing fails, the approval fails.
5. The runner completes the step with seeded fake checkout data. A receipt ID appears, and `http://localhost:3000/receipts` lists the record. That session receipt is a plain record; the signed artifact for this flow is the user-approval receipt from step 4 (see `docs/security-model.md` section 8).

Use `http://localhost:…` rather than `http://127.0.0.1:…` in the browser, because the API's CORS allowlist names `localhost`.

The "simulated · local · fake data" badge on the demo page is accurate.

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Approve returns `APPROVAL_RECEIPT_SIGNING_FAILED` | Keys missing from `.env` | Run the keypair generator; restart |
| "Expected approval_required but got …" | Mock store not running | `npm -w apps/mock-store run dev` |
| "No collars found" | Store not seeded | `npm run seed:demo` |
| API exits with `UNSAFE_API_BIND_HOST` | `AEGIS_API_BIND_HOST` set to a non-loopback value | Remove it or set `127.0.0.1` |
| Chromium launch error | Browser not installed | `npx playwright install chromium` |

Reset between runs: stop the servers, delete `apps/api/.data/aegis-store.json`, re-seed, restart.

## Running the tests

```bash
npm -w apps/api test
node --test examples/antigen-browser-adapter.test.mjs
node --test examples/aegis-tool-server.test.mjs
node --test scripts/validate-antigen-qa-mcp.test.mjs
```

The API suite runs in a single process because the tests share one in-memory store. Chromium-backed suites skip automatically when Chromium is absent.

Known failures (present at commit `e0a1392` and unchanged by the working tree; see `docs/verified-status.md`): `npm run typecheck` fails in `@aegis/api` with TypeScript errors, mostly in test files; Vitest does not type-check, so the suite still passes. `npm run build` fails in `@aegis/web` while prerendering `/demo-travel`. Neither affects `npm run dev`.
