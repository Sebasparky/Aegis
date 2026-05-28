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

## Persistent pointer state

Aegis-managed task browser sessions maintain a `pointer_state` on the `TaskBrowserSession` record. This represents the browser-internal CDP pointer position — coordinates only, no secrets.

**Key properties:**
- CDP `Input.dispatchMouseEvent` does not move the macOS OS cursor. The debug overlay is an in-page representation of the browser-internal pointer.
- On each fill (`execute_secret_field_injection`, profile field fill), the saved `pointer_state` is loaded first. The next pointer movement starts from the last saved position.
- After `clickBoxWithPointer` completes, the final `x/y` is persisted back to `TaskBrowserSession.pointer_state`.
- If no saved state exists yet, the pointer is initialized to viewport center (`Math.round(viewport.width * 0.5), Math.round(viewport.height * 0.5)`) rather than `(0, 0)`. Fallback is `(80, 80)` if viewport dimensions are unavailable.
- **`browser_session_id` is required** for persistent pointer continuity. Without it (`external_cdp_url` or env fallback mode), state is per-request and not persisted across fills.

**Debug overlay behavior:**
- The cursor dot (`__aegis_pointer_debug_dot`) persists at the final position after each action — it is NOT removed on release.
- The trail (`__aegis_pointer_debug_trail`) and SVG path (`__aegis_pointer_debug_path`) are temporary evidence for calibration and are removed after 8 seconds.
- On the next fill, the dot moves from its last position to the new target, showing path continuity.

**Logs to look for:**
```
[PointerState] loaded   { browser_session_id, x, y, initialized }
[PointerState] initialized { browser_session_id, x, y, source: "viewport_center" | "fallback" }
[PointerState] saved    { browser_session_id, x, y }
[PointerFocus] dispatch start { path, mode, generator: "bezier_fallback", point_count, start_x, start_y, end_x, end_y, distance_px, duration_ms }
```

## Pointer Coverage v1 — navigate_task_browser_session

Starting with Pointer Coverage v1, `navigate_task_browser_session` participates in the same persistent pointer continuity as secret/profile field injection.

**What happens during navigation:**
1. The session's saved `pointer_state` is loaded (or initialized from viewport center if none exists).
2. The pointer moves to a page-level navigation marker at `{ x: viewportWidth/2, y: 24 }` using `clickPointWithPointer`.
3. `page.goto(url)` performs the actual navigation.
4. After navigation, the debug cursor is rehydrated at the nav marker position on the new page (DOM overlays are destroyed on navigation).
5. The nav marker coordinates are saved back to `TaskBrowserSession.pointer_state`.
6. Subsequent fill actions (secret injection, profile fill) start from the nav marker — not from `(0, 0)` or viewport center.

**Why we can't click the Chrome address bar:**
`Input.dispatchMouseEvent` targets the page viewport coordinate space. Chrome's browser UI (address bar, tabs, toolbar) is rendered outside the page viewport and cannot be controlled by page-level CDP events. V1 uses a viewport nav marker as an honest approximation.

**`nav_mode` field:**
- `"page_level_nav_marker_direct_goto"` — pointer moved to the nav marker successfully; `final_pointer` is set and saved.
- `"direct_fallback"` — pointer prep failed (CDP session creation error, etc.); `page.goto` still ran and navigation succeeded, but `final_pointer` is absent and pointer state is not updated.

`page.goto` failures are never swallowed by the pointer try/catch — `NAVIGATION_FAILED` propagates normally regardless of pointer state.

**`generator: "bezier_fallback"` in `[PointerFocus]` logs:**
Every pointer dispatch currently uses Bézier path generation. The `generator` field marks which path source was used. When calibrated template traces are wired in (Track B), the field will show `"template_trace"` for recorded arcs and `"bezier_fallback"` for generated ones, making it easy to distinguish in logs.

**Logs to look for during navigation:**
```
[PointerState] loaded/initialized { browser_session_id, x, y, surface: "navigation" }
[PointerNav] pointer pre-navigation marker { browser_session_id, x, y, url }
[PointerFocus] dispatch start { path: "nav_marker", mode, generator: "bezier_fallback", point_count, ... }
[PointerState] saved { browser_session_id, x, y, surface: "navigation" }
[PointerDebugOverlay] cursor rehydrated { x, y, label: "post_nav" }
```
