# Antigen HV Visual Judgment Progress

Internal engineering memo. Branch: `feature/vgc-live-press-hold-relay`.
Status as of this milestone: dev-only live suppression v0 has landed behind
explicit gates on an exact-host allowlist.

---

## Current status

Antigen now has an **activation-gated** HV (human-verification) visual judgment
pipeline that can:

- run **only when existing heuristics already suspect** a human-verification
  surface (it does not scan every page),
- classify the rendered page/snapshot with the offline-trained visual model,
- write safe visual-judgment telemetry into the runtime review queue,
- compute a **pure** live-policy decision (`decideVisualLivePolicy(...)`),
- and, **only behind explicit dev-only gates**, suppress a false-positive
  snapshot HV stop (return a normal `200` instead of a `409`).

### This is explicitly NOT

- **Not** challenge solving.
- **Does not** click, press, hold, type, or otherwise bypass verification.
- **Does not** watch continuously — it runs at the moment a snapshot-mint
  heuristic already flagged a suspected wall.
- **Does not** apply to:
  - VGC capsule reuse guards,
  - cached HV marker guards,
  - action no-progress backstops (ambiguous or structural),
  - sensitive action approvals,
  - payment approvals,
  - credential release.
- **Default behavior remains fail-closed** — without all gates satisfied, the
  existing `409 HUMAN_VERIFICATION_REQUIRED` behavior is unchanged.

---

## Timeline / commits

The capability was built up in the following progression:

1. **Offline model / review loop**
   - runtime visual judgment queue
     (`dev-artifacts/hv-vision-review/runtime-judgment-queue.jsonl`),
   - manual review labels,
   - train/eval manifests,
   - threshold-aware error report.

2. **Shadow live-policy function**
   - pure `decideVisualLivePolicy(...)`
     (`apps/api/src/runtime/visualBlockerClassifier/livePolicy.ts`),
   - default thresholds:
     - `hv_action_threshold = 0.85`
     - `benign_suppression_threshold = 0.95`
   - no runtime action initially — shadow telemetry only.

3. **Safe 409 attribution**
   - all `HUMAN_VERIFICATION_REQUIRED` responses expose a safe
     `human_verification_attribution`,
   - the adapter surfaces attribution to Antigen browser tools,
   - attribution identifies the source path:
     - `snapshot_mint_visual_judgment`
     - `vgc_capsule_reuse_guard`
     - `cached_hv_marker_guard`
     - `action_no_progress_ambiguous_backstop`
     - `action_no_progress_structural_backstop`

4. **Stale cross-origin state fix** (commit `d059030`)
   - VGC / HV-marker reuse now compares the **stored hostname** against
     `host(session.current_url)` (helper `originHostOf()` in `agent-api.ts`),
   - **same-origin** reuse still blocks (unchanged),
   - **cross-origin** stale VGC / HV state is cleared / terminalized and does
     **not** block,
   - concretely: `example.com` no longer gets poisoned by leftover Etsy/session
     state.

5. **Post-fix offline review / training**
   - imported/reviewed fresh benign examples:
     - hCaptcha → `false_positive_normal_page`
     - HubSpot → `false_positive_normal_modal`
     - example.com → `false_positive_normal_page`
   - threshold-aware report at `hv_action_threshold = 0.85`:
     - `false_hv_any_count = 0`
     - `false_hv_actionable_count = 0`
     - `false_hv_low_confidence_count = 0`
     - `missed_hv_count = 0`
   - the only high-confidence wrong examples were benign↔benign subclass
     confusions, **not** HV-vs-benign errors.

6. **Dev-only live suppression v0** (commit `1a5c0f8`)
   - suppression **authority** now comes from `decideVisualLivePolicy(...)`,
   - `decideOutcome(...)` remains **only** for review taxonomy (it uses a
     separate `0.8` benign threshold for labeling; it does **not** gate live
     suppression),
   - the snapshot-mint path can return a normal `200` instead of a `409` only
     when **all** gates pass.

---

## Live suppression v0 gates

Suppression occurs **only** when every one of these holds:

- `ANTIGEN_VISUAL_JUDGMENT_ENABLED=true`
- `ANTIGEN_VISUAL_JUDGMENT_LIVE_POLICY=true`
- `ANTIGEN_VISUAL_JUDGMENT_DRY_RUN=false`
- `ANTIGEN_VISUAL_JUDGMENT_LIVE_ALLOWLIST=<exact-hosts>`
- model available (sidecar reachable),
- domain **exactly** allowlisted,
- predicted label is **benign**,
- confidence is **≥ 0.95**.

### Default fail-closed cases (no suppression — existing 409 stands)

- live flag absent / off,
- dry-run true,
- allowlist empty / missing,
- domain not allowlisted,
- sidecar / model unavailable,
- unknown label,
- `page_level_hv_wall` at **any** confidence,
- benign confidence `< 0.95`,
- any **non-snapshot** reuse / backstop path (VGC reuse, cached HV marker,
  action no-progress backstops).

---

## Runtime behavior (exact path)

1. Existing snapshot HV heuristics suspect a wall.
2. `evaluateVisualJudgment(...)` runs because visual judgment is
   activation-gated (it only runs when heuristics already flagged).
3. The model result is passed into `decideVisualLivePolicy(...)`.
4. If the policy action is `suppress_heuristic_stop`, then `judgment.suppress`
   is set to `true`.
5. Existing snapshot-mint code sees `judgment.suppress` and does **not** mint
   the `409`.
6. Otherwise, existing `409` behavior remains.

> Note: No new `agent-api.ts` mint-site logic was needed for v0, because the
> snapshot decision already flowed through `judgment.suppress`. The change is in
> who decides that flag (`decideVisualLivePolicy`), not in the mint site.

---

## Telemetry

Each judgment writes a `live_policy_shadow` object into the runtime review
queue. Interpret it as follows.

**Suppression actually happened only when:**

- `policy_action = suppress_heuristic_stop`
- `should_suppress_heuristic_stop = true`
- `live_policy_runtime_action_taken = true`
- `shadow_only = false`
- `domain_allowed = true`
- `live_policy_enabled = true`

**No suppression happened when:**

- `policy_action = dry_run_only` or `allow_heuristic_stop`
- `live_policy_runtime_action_taken = false`
- `shadow_only = true`

### Telemetry safety

- safe scalar fields only,
- no full URLs / path / query,
- no selectors,
- no coordinates,
- no raw text,
- no screenshot / base64,
- no frame paths in HTTP bodies.

---

## Manual QA recipe

**Terminal 1 — sidecar:**

```bash
cd ~/Desktop/aegis
npm run vision:judgment:sidecar
```

**Terminal 2 — API with live suppression enabled:**

```bash
cd ~/Desktop/aegis/apps/api
ANTIGEN_BROWSER_TRACE=true \
ANTIGEN_BROWSER_REQUIRE_ANTIGEN_TOOLS=true \
ANTIGEN_BROWSER_REQUIRE_REALISTIC_NAVIGATION=true \
ANTIGEN_INPUT_REALISM=realistic \
ANTIGEN_VISUAL_GESTURE_CAPSULE=true \
ANTIGEN_HUMAN_VERIFICATION=true \
ANTIGEN_HV_DEBUG=true \
ANTIGEN_VISUAL_JUDGMENT_ENABLED=true \
ANTIGEN_VISUAL_JUDGMENT_DRY_RUN=false \
ANTIGEN_VISUAL_JUDGMENT_LIVE_POLICY=true \
ANTIGEN_VISUAL_JUDGMENT_LIVE_ALLOWLIST=www.hubspot.com,www.hcaptcha.com,www.example.com \
ANTIGEN_VISUAL_JUDGMENT_SIDECAR_URL=http://127.0.0.1:8782 \
ANTIGEN_VISUAL_REVIEW_MANUAL_CAPTURE=true \
npm run dev
```

**Runtime status check:**

```bash
curl -s http://127.0.0.1:3000/api/runtime/status | python3 -m json.tool | grep visual_judgment
```

Expected:

- `visual_judgment_enabled: true`
- `visual_judgment_dry_run: false`
- `visual_judgment_live_policy: true`

### Manual QA matrix

- **Live policy enabled + allowlist:**
  - hcaptcha.com → normal `200`, live suppression telemetry
  - hubspot.com → normal `200`, live suppression telemetry
  - example.com → normal `200`, live suppression telemetry
- **Live policy disabled or dry-run true:**
  - HubSpot returns `409` again with attribution `snapshot_mint_visual_judgment`
  - attribution remains present
  - `visual_judgment_suppress = false`
- **True HV walls** should remain `409`.
- If a true wall is not reproduced live, **unit tests still cover**
  `page_level_hv_wall` → no suppression.

### Queue inspection

```bash
cd ~/Desktop/aegis
python3 <<'PY'
import json
from pathlib import Path
from collections import Counter
q = Path("dev-artifacts/hv-vision-review/runtime-judgment-queue.jsonl")
rows = [json.loads(x) for x in q.read_text().splitlines() if x.strip()]
recent = rows[-20:]
for e in recent:
    shadow = e.get("live_policy_shadow")
    print("host:", e.get("origin_host"))
    print("  model:", e.get("model_predicted_label"), e.get("model_confidence"))
    print("  outcome:", e.get("outcome"))
    print("  runtime_action_taken_by_model:", e.get("runtime_action_taken_by_model"))
    print("  live_policy_shadow:", shadow)
    print()
print("policy decisions:", Counter((e.get("live_policy_shadow") or {}).get("policy_decision") for e in recent))
PY
```

---

## Latest QA result

**Run with live policy enabled:**

- hcaptcha.com → normal `200`
- hubspot.com → normal `200`
- etsy.com → normal `200` this run, so a true wall was **not** reproduced
  manually
- example.com → normal `200`

Queue confirmed live suppression for:

- `www.hcaptcha.com`
- `www.hubspot.com`
- `www.example.com`

Each had:

- `policy_action = suppress_heuristic_stop`
- `should_suppress_heuristic_stop = true`
- `live_policy_runtime_action_taken = true`
- `shadow_only = false`
- `domain_allowed = true`
- `live_policy_enabled = true`

**Run with live policy disabled:**

- HubSpot returned `409` again
- attribution source was `snapshot_mint_visual_judgment`
- `visual_judgment_suppress = false`
- queue showed `policy_action = dry_run_only`

---

## Remaining known limitations

- Live suppression is still **dev-only**.
- Allowlist is **exact-host only** — no wildcard / subdomain expansion.
- True-wall live manual QA depends on reproducing a live wall; tests cover the
  safety invariant (`page_level_hv_wall` → no suppression) when a live wall is
  not reproduced.
- Benign **subclass** accuracy is not perfect; the current **HV-vs-benign**
  gating metrics are the critical safety metric, and those were clean
  post-training.
- This should **not** be promoted beyond the dev allowlist without more
  broad-domain shadow telemetry and another review/training loop.

---

## Next recommended steps

1. Run a wider allowlisted dev QA batch on known benign false-positive surfaces.
2. Keep importing / reviewing runtime judgment events.
3. Add an operator checklist for promoting a domain into the live allowlist.
4. Only after repeated clean QA, consider a very small private beta allowlist.
5. Do **not** generalize live suppression beyond allowlisted hosts yet.
