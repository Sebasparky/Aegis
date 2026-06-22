# Antigen Visual Judgment — Activation-Gated Runtime Seam (design only)

> **Status: DESIGN SEAM ONLY. Nothing in this document is wired into runtime.**
> No behavior changes ship with this file. It defines *where* and *under what
> rules* a future shadow-mode visual-judgment call would attach — so that when we
> do wire it, the privacy boundary is already fixed and unmistakable.

Companion artifacts:

- Offline trainer/harness: `scripts/hv_vision_*.py`, `scripts/HV_VISION_README.md`
  (shadow / offline / dev-only; never imported by runtime).
- Existing Phase-1 shadow pipeline + safe type contracts:
  `apps/api/src/runtime/visualBlockerClassifier/` and
  `docs/visual-blocker-classifier-pipeline.md`.
- Lightweight TS types for this seam:
  `apps/api/src/runtime/visualBlockerClassifier/runtimeSeam.ts` (pure `type`/
  `interface` declarations; imported by nothing; emits no runtime JS).

---

## 0. The one rule you cannot miss

**Antigen must never continuously watch or classify the agent's screen.**
Visual judgment is **activation-gated**: a screenshot is taken and a model is
asked **only** when an existing suspicious-state trigger has already fired.

```
NO activation reason  ⇒  NO screenshot  ⇒  NO model call.
```

There is no "always-on" mode, no per-page-load classification, no background
frame sampling, and no polling loop. The activation reason is the *only* thing
that may open the visual channel, and it is logged on every request so the gate
is auditable after the fact.

### Safety boundary (detect and route only)

The visual judgment layer **detects page state and routes**. It must **never**:

- solve, click, press, hold, drag, type into, or otherwise interact with a
  CAPTCHA or human-verification challenge;
- OCR, transcribe, or classify the *answer* to any challenge;
- bypass, defeat, or "get past" CAPTCHA, 2FA, passkeys, or any human-presence
  check.

Its entire job is to produce an **advisory page-state estimate** (e.g. "looks
like a page-level HV wall") that an *existing* policy/heuristic may then use to
route to **human takeover** — never to act on the challenge itself.

---

## 1. Where this seam sits

Two layers already exist below this seam and must not be collapsed into it:

| Layer | Owns | Lives in |
|---|---|---|
| **Suspicious-state logic** (heuristics) | Detecting that something is wrong (no progress, stale refs, HV signals) and making the *runtime decision today* | existing runtime (VGC, surfaceBoundary, recheck, etc.) |
| **Visual judgment seam** (this doc) | The *gate*: deciding whether the suspicious state is allowed to open the visual channel, and the request/result contract | `runtimeSeam.ts` (types) + this doc |
| **Visual classifier** | Turning one redacted frame into a page-state label | offline `scripts/hv_vision_*` today; a future in-runtime `model` adapter |

The seam is deliberately a thin contract between "heuristics noticed something"
and "ask for an advisory page-state label." It does not own detection and it
does not own the model.

---

## 2. Activation reasons (the only doors in)

A visual judgment request may be created **only** when one of these existing
suspicious states is already true. Each maps to an established runtime concept.

| `activationReason` | Fires when… | Already represented in runtime by |
|---|---|---|
| `repeated_no_progress` | Multiple actions produced no observable page-state change | `no_progress` / no-progress backstop marker |
| `action_failed` | A runtime action returned a hard failure | failure codes (e.g. `REALISTIC_CLICK_FAILED`) |
| `navigation_timeout` | A navigation did not settle within the budget | nav-state settle/timeout path |
| `ref_stale_loop` | The same ref keeps going stale / re-find keeps failing | `repeated_stale` / `stale-ref` recovery |
| `possible_human_verification` | HV heuristics suspect a verification wall | `HUMAN_VERIFICATION_REQUIRED` / VGC detection |
| `protected_boundary` | A protected/sensitive boundary was hit and state is unclear | protected-observation / capability gating |
| `agent_requested_help` | The agent explicitly asked Antigen for help on a stuck state | agent-initiated escalation |
| `user_requested_review` | A human explicitly asked for a visual review of the current state | UI-initiated review |

If none of these is true, there is no request and no capture. Full stop.

---

## 3. `VisualJudgmentRequest` (what goes in)

Safe-fields-only, mirroring the existing module's discipline. Correlation is by
**id**, not by content. See `runtimeSeam.ts` for the typed shape.

| Field | Type | Notes |
|---|---|---|
| `sessionId` | `string` | Browser/task session correlation id. |
| `activationReason` | `VisualJudgmentActivationReason` | One of §2. **Required** — there is no default/empty reason. |
| `captureId` | `string?` | Preferred handle to an already-captured **redacted** frame (e.g. dataset `candidate_id`). |
| `framePath` | `string?` | **Dev-only.** Local, gitignored path to a redacted frame (e.g. `dev-artifacts/hv-vision-dataset/.../frame.png`). Never sent to the agent, never logged, never in any API response. Present only in local shadow runs. |
| `triggerBasis` | `VisualClassifierTriggerBasis?` | Reuses the existing enum when the surface router already produced one. |
| `recentFailureCodes` | `string[]` | Coarse failure-code strings already surfaced by runtime (no payloads). |
| `lastAgentAction` | `string?` | Coarse action kind (e.g. `"click"`, `"navigate"`) — never selectors, coordinates, or typed values. |
| `pageMetadata` | `{ originHost?: string; titleHint?: string }?` | **Origin host only** (hostname, never full URL/path/query) and a short sanitized title hint, *only if already available and safe*. Follows the existing module's choice to keep `page_url` out — prefer omitting over leaking. |

**No screenshot bytes, base64, rects/coordinates, selectors, iframe `src`, raw
page text, field values, cookies, or storage ever appear in a request object,
log line, or API response.** The redacted frame referenced by `captureId` /
`framePath` is produced only by the **existing** capture mechanism
(`captureRedactedScreenshot` / dataset capture) — this seam adds **no new
screenshot path**.

---

## 4. `VisualJudgmentResult` (what comes back)

Advisory page-state estimate. See `runtimeSeam.ts`.

| Field | Type | Notes |
|---|---|---|
| `predictedLabel` | `string` | Page-state label from the model's own vocabulary (e.g. `page_level_hv_wall`, `cookie_banner`, `false_positive_normal_page`). Model-version dependent. |
| `confidence` | `number` | Top-label confidence in `[0, 1]`. |
| `topLabels` | `{ label: string; confidence: number }[]` | Top-k (typically 3), sorted descending. |
| `needsHumanReview` | `boolean` | True when confidence is below threshold (or the label is high-consequence). |
| `advisoryOnly` | `true` | **TypeScript literal `true`** — like `enforced: false` in the existing policy type. Never set through a variable. A result can never be promoted to an enforcing decision by mutating this field. |
| `modelVersion` | `string?` | e.g. an offline-harness artifact id; absent for non-model sources. |
| `source` | `VisualClassifierSource` | Reuses the existing enum: `shadow_stub` / `dev_heuristic` / `manual_qa` / `model`. |

The result contains **no challenge answer, no coordinates, no text, no “how to
solve” guidance** — by construction it is a label + confidence, nothing the
agent could act on against a challenge.

---

## 5. v0 invariant: advisory / shadow-only

In v0 the `VisualJudgmentResult` is **advisory and shadow-only**:

- It **cannot** independently interrupt the user.
- It **cannot** independently stop, pause, or redirect the agent.
- It **cannot** mint a VGC, return a 409, change capsule state, or flip any
  `enforced` decision.
- It is **logged for evaluation** and otherwise discarded by the call site —
  exactly as today's `shadowStubAdapter` output is discarded.

The runtime decision in v0 is made entirely by the **existing heuristics**. The
visual result rides alongside as an observation, never as an authority.

---

## 6. Promotion rule (how a model could ever earn a vote)

Promotion is staged and one-directional. A visual model does not get to act
until it has earned trust against the heuristics:

1. **Heuristics own runtime decisions first.** The existing suspicious-state
   logic remains the sole authority for interrupt/route/stop.
2. **The visual model logs disagreement and low-confidence cases.** In shadow
   mode it records where it agrees/disagrees with the heuristic outcome and
   where it was unsure — building an offline evaluation record.
3. **Only after evaluation** (sufficient agreement, understood failure modes,
   acceptable false-positive rate on `false_positive_normal_*`) may it become
   **one signal in a hybrid decision** — combined with heuristics, never
   replacing them, and still gated by the same activation reasons and the same
   detect-and-route-only safety boundary.

At no promotion stage does the model gain the ability to interact with a
challenge. Promotion only ever changes how much weight its *advisory label*
carries in routing to **existing** human-takeover / approval flows.

---

## 7. Examples

**✅ Allowed — repeated stale refs trigger one screenshot + one shadow prediction**
The ref-stale recovery path keeps failing (`ref_stale_loop`). Runtime opens the
visual channel **once**, reuses the existing redacted capture, asks for an
advisory label, logs the result, and continues to let the heuristics decide.

**❌ Not allowed — continuously classifying every page load**
There is no activation reason on a normal navigation. Sampling frames on every
page load (or on a timer) is forbidden — it is exactly the continuous-watching
the privacy rule prohibits.

**✅ Allowed — possible HV wall routes to human takeover (only if HV policy agrees)**
`possible_human_verification` fires. The advisory label comes back
`page_level_hv_wall`. Because the **existing** HV policy *also* concludes a wall
is present, runtime routes to the established human-takeover / VGC flow. The
visual label is corroboration, not the trigger of record.

**❌ Not allowed — the model attempts to solve or interact with the challenge**
Under no circumstances may visual judgment click, press-and-hold, drag, type,
OCR the prompt, or compute an answer. It detects and routes only; solving is
out of scope and explicitly prohibited.

---

## 8. Future implementation steps (later shadow-mode wiring)

When we are ready to wire shadow mode (a separate, behavior-neutral change):

1. **Flag.** Add a dedicated default-off env flag (sibling of
   `ANTIGEN_HV_VISION_CLASSIFIER`), e.g. `ANTIGEN_VISUAL_JUDGMENT_SHADOW`. Off ⇒
   byte-identical; the seam never activates.
2. **Activation hook.** At each existing suspicious-state site (no-progress
   backstop, stale-ref recovery, nav timeout, HV detection, protected boundary,
   agent/user help requests), construct a `VisualJudgmentRequest` with the
   correct `activationReason`. Do **not** add detection — only read states that
   already exist.
3. **Reuse capture.** Reference the already-redacted frame via `captureId` /
   `framePath` from the existing capture/dataset path. Add **no** new screenshot
   mechanism.
4. **Adapter, not Python-in-runtime.** Implement an in-process inference adapter
   (or a sidecar service the runtime calls over a local boundary) that loads an
   exported model artifact. **Do not shell out to / import the Python
   `scripts/hv_vision_*` harness from runtime.** The Python harness stays offline.
5. **Advisory only.** Return a `VisualJudgmentResult` with `advisoryOnly: true`;
   the call site logs it and **discards** it for routing (shadow), exactly like
   the current `shadowStubAdapter`.
6. **Evaluation.** Accumulate agreement/disagreement vs. heuristic outcomes and
   low-confidence cases offline (per §6.2).
7. **Hybrid (only after evaluation).** Behind another explicit gate, allow the
   advisory label to become *one weighted signal* feeding existing
   human-takeover / approval routing — never a new authority, never an actor on
   the challenge.

Each step is independently flag-gated and behavior-neutral until explicitly
turned on. The activation gate and the detect-and-route-only boundary hold at
every step.
