# CDP Injection Runtime

## Browser endpoint selection — secret injection

`execute_secret_field_injection` resolves the CDP endpoint using a 5-tier precedence (first match wins):

| Tier | Source | CDP URL | preferredTargetUrl |
|------|--------|---------|-------------------|
| 1 | `body.browser_session_id` | `session.cdp_url` | `session.current_url` |
| 2 | stored `injection.browser_session_id` | `session.cdp_url` | `session.current_url` |
| 3 | `body.external_cdp_url` | body value | `injection.page_url` |
| 4 | stored `injection.external_cdp_url` | stored value | `injection.page_url` |
| 5 | env fallback | `AEGIS_PLAYWRIGHT_CDP_URL` | none |

**Prefer `browser_session_id`** — it carries both the CDP URL and `current_url`, giving the CDP target selector the best hint for picking the right tab. `external_cdp_url` is for dev/manual flows where no Aegis-managed session exists. Env fallback is last resort.

Execute-time overrides (`body.browser_session_id`, `body.external_cdp_url`) **never mutate the stored injection record**. They apply only to this execution.

Profile fill (`execute_profile_field_fill`) follows the same pattern; both now have parity.

## Why CDP pointer events don't move the OS cursor

CDP `Input.dispatchMouseEvent` fires browser-internal input events — the browser processes them as genuine pointer input, but the macOS window server is not involved. The physical cursor stays in place. This is expected.

To verify that pointer events actually fired inside the browser, use diagnostic mode:

```bash
ANTIGEN_CDP_DIAGNOSTICS=true ANTIGEN_POINTER_DEBUG_OVERLAY=true npm run dev
```

Logs to look for:

```
[CdpInjection] endpoint selection { path: "secret", source: "body_browser_session_id", cdp_url: "...", preferred_target_url: "..." }
[PointerFocus] box found { path: "secret", width: ..., height: ... }
[PointerFocus] dispatch start { path: "secret", mode: "native", point_count: ... }
[PointerDebugOverlay] enabled
[PointerDebugOverlay] update x=... y=... type=move
```

No secrets, selectors, page content, or field values appear in any diagnostic log.
