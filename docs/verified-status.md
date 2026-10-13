# Verified status

This page separates what has been verified from what is only implemented or only described. "Verified" below means one of three things, and each table says which:

- **Test case** — an automated assertion in the repository. Counts are of cases present in the tree, not of a recorded passing run.
- **Chromium integration** — an automated test that launches local headless Chromium against a synthetic HTML fixture. These skip automatically when Chromium is not installed.
- **Documented live run** — a manual session on a real website written up in `docs/` with its outcome, including failures.

No test in the repository reaches the internet.

## Test inventory (as of this checkout)

| Kind | Count | Where |
|---|---|---|
| Test files | 108 | 105 vitest files in `apps/api/src/__tests__/`, 3 `node:test` files in `examples/` and `scripts/` |
| Test cases in the repository | about 2,800 | `it(` and `test(` declarations |
| Unit and in-process API cases | about 2,540 | Fastify `inject` against mocked runtimes; no browser |
| Chromium integration cases | about 72 in 8 files | gated by `describe.skipIf(!chromium.executablePath())` |
| Double-gated suites | 3 files | need Chromium and `ANTIGEN_VGC_REAL_SESSION_TEST=true` or `ANTIGEN_BENCHMARK=true` |
| Spawned-process cases | about 190 | adapter and tool-server tests that spawn the real scripts against a mock API on loopback |
| Synthetic HTML fixtures | 17 files, 44 KB | `apps/api/src/__tests__/fixtures/` |

These are approximate counts of cases present in the tree; the recorded run below gives exact executed counts.

## Recorded run (2026-10-13)

Environment: macOS 26.4, Node v20.20.2, npm 10.8.2, working tree on top of commit `e0a1392` with the uncommitted release-hygiene changes. Results are from a local machine; there is no CI.

| Command | Result |
|---|---|
| `npm -w apps/api test` | Pass: 102 files passed, 3 skipped; 2,716 tests passed, 0 failed, 12 skipped (opt-in and Chromium-gated suites) |
| `node --test examples/antigen-browser-adapter.test.mjs` | Pass: 201 passed, 0 failed |
| `node --test examples/aegis-tool-server.test.mjs` | Pass: 2 passed, 0 failed |
| `node --test scripts/validate-antigen-qa-mcp.test.mjs` | Pass: 5 passed, 0 failed |
| `npm run typecheck` | **Fails** in `@aegis/api` with 202 TypeScript errors (184 in test files, the rest in `routes/agent-api.ts`, `lib/loginDiagnostics.ts`, `lib/routePreviewCapture.ts`). `@aegis/types`, `@aegis/web`, and `@aegis/mcp-server` pass. Identical at `e0a1392`. |
| `npm run build` | **Fails**: the `@aegis/api` build hits the same TypeScript errors, and the `@aegis/web` build fails prerendering `/demo-travel` (`useSearchParams()` outside a Suspense boundary). Identical at `e0a1392`. |
| `npm run demo:preflight` | Pass |

Vitest does not type-check, so the test suite passes while `tsc` reports errors. The dev servers (`tsx watch`, `next dev`) do not depend on either failing command.

## Capabilities

| Capability | Status | Verified by |
|---|---|---|
| Scoped delegation (collars, bearer passes resolved server-side) | Implemented | Test cases (policy evaluation, token consistency, delegation expiry) |
| Approval gates that fail closed without a signed receipt | Implemented on five paths (guard loop, route runs, credential authorizations, card fills, purchase confirmations); six secondary or experimental paths do not yet require one (`docs/security-model.md` section 4); the guard loop is exercised by the local demo | Test cases (approval receipts, route-run approval signing) |
| Protocol-level credential secrecy (plaintext withheld from tool inputs and responses; CDP injection after approval) | Implemented | Test cases (masking, injection lifecycle, CDP selector); one documented live GitHub login |
| Reference-based navigation (Antigen `ag_N` snapshot refs, revalidation, click verification) | Implemented | Test cases (about 570) and Chromium integration on fixtures; documented live runs on IKEA |
| Exact-replacement form fill that refuses sensitive fields | Implemented | Test cases and Chromium integration |
| Human-verification stop conditions (wall detection, `409`, Visual Gesture Capsule) | Implemented | Test cases (about 200), Chromium integration on synthetic walls; one documented live press-and-hold wall |
| Challenge-code relay (email, SMS, TOTP entered in the UI, injected once) | Implemented | Test cases |
| Ephemeral no-save agent browser | Implemented | Test cases (profile persistence, orphan cleanup) |
| Ed25519-signed receipts | Implemented: user-approval receipts and route-run action authorizations are signed but not chained; route-run receipts are hash-chained and signed, best-effort in local mode with in-memory chain metadata; the `/demo` session receipt is unsigned | Test cases with real keys (tamper, revocation); no dedicated hash-chain unit test yet |
| Loopback-only API bind | Implemented | Test cases (default, IPv6, refusal of non-loopback) |
| Multi-agent workspaces with permission intersection | Implemented | Test cases (about 150); four documented two-agent trials over HTTP |
| Observe-only dry run on real sites | Implemented | Test cases; documented runs |
| Payment card fill and purchase confirmation | Implemented, approval-gated | Test cases and Chromium integration on fixtures; card fields filled once on a live checkout, final purchase never clicked |
| Durable persistence, cloud KMS, user authentication | Not implemented | Supabase is optional for vault and receipts only; cloud KMS is a stub; there is one mock user |

## Documented live runs

The repository documents about 18 sessions in total: roughly 12 real-site browser runs, 4 two-agent workspace trials over HTTP, and 2 local mock-store runs. The real-site runs cover:

| Site | What ran | Outcome recorded |
|---|---|---|
| Wikipedia | Route recording and replay; agent-runnable recipe via MCP | Succeeded; produced the first signed route receipt |
| GitHub | Username and password login via approval-gated CDP injection | Succeeded; a third injection attempt on the fulfilled authorization was correctly refused |
| IKEA | Search, product, add to bag, checkout up to card fields | Add-to-bag verified; four card fields filled; expiry mask lost after an iframe re-render; final purchase never clicked |
| A PerimeterX-protected retailer | Navigation until a press-and-hold wall | Wall defeated DOM probing; drove cross-origin iframe detection and the Visual Gesture Capsule |
| Several merchants (unnamed) | Cart-building smoke | Exposed a search box misclassified as a credential field; fixed |

Failures recorded along the way include stale element references after navigation, a floating-label field whose `focus()` call failed under CDP, a search box misclassified as a credential field, an expiry mask lost on iframe re-render, and a fulfilled credential authorization refusing a third use. Each has a corresponding fix and, where feasible, a regression test.

## What has not been verified

- A green test run on a clean checkout (no CI exists; tests have only been run locally during development).
- Any payment submission on a real site.
- Human-verification detection on more than one live wall.
- Supabase persistence against a live project in this checkout.
- Linux support for the system-Chrome launch path.
