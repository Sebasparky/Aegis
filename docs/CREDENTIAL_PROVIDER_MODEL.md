# Credential Provider Model v1

## Thesis

Domain is a security primitive, not the user mental model.

Users think in services and accounts: "GitHub · Sebasparky", "Google · user@gmail.com". Aegis thinks in login domains: "github.com", "accounts.google.com". Both are right — they serve different purposes.

- **User-facing copy** should use provider/account labels wherever possible.
- **Security enforcement** (injection authorization, domain validation, KMS context) must remain domain-bound.

Loosening domain binding for display convenience is not permitted — `findCredentialProviderByDomain` is a display-only lookup.

---

## Provider Registry

A small curated registry maps `provider_id → { display_name, login_domains[], oauth_provider }`. The registry is intentionally small. Adding providers without clear product need is explicitly out of scope.

The registry lives in:
- `apps/api/src/lib/credentialProviders.ts` — server-side use
- `apps/web/src/lib/credentialProviders.ts` — UI display

> **TODO**: move to a shared package (e.g. `@aegis/credential-providers`) when one is created.

Current providers: GitHub, Google, Microsoft, Apple, Supabase, Vercel, AWS, Stripe, Slack, Discord, Notion, Linear, Figma.

---

## Three-Domain Model

When a user signs into a service that delegates authentication to an OAuth provider, three domains are relevant:

| Domain | Example | Role |
|--------|---------|------|
| `requesting_site` | `supabase.com` | The site the user is trying to log into |
| `credential_provider_domain` | `github.com` | The identity provider that owns the credential |
| `current_injection_domain` | `github.com` | The page hostname where Aegis will inject the field |

**OAuth example — Supabase login via GitHub:**
1. Agent navigates to `supabase.com/dashboard/sign-in`
2. Agent clicks "Sign in with GitHub"
3. Browser redirects to `github.com/login/oauth/authorize`
4. Agent calls `request_secret_field_injection({ domain: "github.com", ... })`
5. Aegis injects the GitHub credential **on github.com only**
6. Agent clicks Authorize / Submit
7. Browser redirects back to supabase.com

The key invariant: **Aegis never injects a credential on the `requesting_site`**. The `current_injection_domain` must match the vault pass's `domain`, and that domain belongs to the credential provider (GitHub), not the originating site (Supabase).

The `getInjectionSafetyCopy` function produces the approval UI copy that makes this explicit when `requesting_site ≠ injection_domain`:

> "Supabase is asking you to sign in with GitHub. Aegis will only inject this credential on github.com."

---

## Display Helpers

### `normalizeLoginDomain(input: string): string`

Accepts any of: `"github.com"`, `"https://github.com/login"`, `"https://www.github.com/session"`.  
Returns: `"github.com"` — strips protocol, path, port, leading `www.`.

### `findCredentialProviderByDomain(domainOrUrl: string): CredentialProviderMatch | null`

Display-only lookup against the provider registry. Matches exact domain or subdomain (e.g. `accounts.google.com` matches the Google provider). Returns `null` for unrecognized domains.

This function does **not** authorize injection — it is purely for UI labeling.

### `getCredentialDisplayLabel(pass): string`

Returns `"GitHub · Sebasparky"` (if provider found from `pass.domain`) or `"github.com · Sebasparky"` (fallback for unknown domains). Does not require schema migration.

### `getInjectionSafetyCopy(opts): string`

Returns approval UI safety copy. When `requesting_site` differs from `injection_domain`, produces the three-domain clarification sentence. When they are the same (or `requesting_site` is omitted), returns the simpler form.

---

## Non-Goals

- **No huge provider database.** The registry covers common developer-facing services. It is not a comprehensive IdP index.
- **No automatic trust of arbitrary OAuth redirects.** The agent must navigate to the provider's login page. Aegis does not auto-infer the OAuth provider from a redirect.
- **No schema migration yet.** `AegisVaultPass.domain` remains the security binding. `provider_id` is not stored in v1 — it is inferred at display time from `domain`.
- **No injecting provider credentials on requesting sites.** If Supabase redirects to GitHub for OAuth, the GitHub credential is injected on `github.com` only — never on `supabase.com`.
- **No OAuth flow automation.** Aegis does not click OAuth consent screens, scope grant buttons, or "Authorize" buttons. The agent navigates and clicks; Aegis fills only the credential fields.

---

## Future Work

- **Vault schema migration**: add `provider_id?: string` to `AegisVaultPass` for explicit provider binding (instead of domain inference)
- **Password import / migration UI v1**: bulk import credentials with provider selection
- **Signup Credential Custody v1**: extend the model to cover new account creation flows
