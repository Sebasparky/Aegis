/**
 * Antigen Snapshot Runtime — DOM candidate extraction (v1, increment 1).
 *
 * The first primitive toward Antigen-owned snapshots:
 *
 *   live CDP page → DOM/CDP extraction → visible interactive candidate list
 *                   with internal bounding boxes + safe semantic metadata
 *
 * This module is intentionally NOT wired into browser_click, browser_type,
 * browser_snapshot, the adapter, any API endpoint, the snapshot store, or
 * ag_* refs. It only proves that Antigen can independently inspect the live
 * page over CDP and return sanitized internal candidate records. Later phases
 * add ref assignment, the snapshot store, revalidation, and scoring.
 *
 * Source of truth: docs/antigen-snapshot/{extraction-strategy,internal-model,
 * security-and-privacy,scoring-and-fallback-resolution}.md
 *
 * Security invariants (enforced by construction; asserted in tests):
 * - The page-side IIFE NEVER reads `.value` for any field except
 *   input[type=submit|button|reset] (where value is the button label).
 *   Password / hidden / payment / identity field values are never read.
 * - input[type=hidden] is skipped entirely.
 * - Returned candidates contain ONLY the AntigenSnapshotCandidate fields.
 *   They never contain cdp_url, user_data_dir, profile_key, pass_id,
 *   secret_ref, field values, cookies, localStorage/sessionStorage, raw HTML,
 *   the full DOM, or browser profile paths.
 * - Bounding boxes ARE included here because this runtime function is internal
 *   (Antigen-only) and not yet agent-facing. Future API endpoints keep boxes
 *   internal per docs/antigen-snapshot/security-and-privacy.md.
 *
 * The page-side IIFE is a raw JS string (NOT a TypeScript arrow function): the
 * Node tsconfig has no DOM lib, so DOM code lives in strings evaluated in the
 * page via CDP Runtime.evaluate — same convention as buildElementFindExpr in
 * realisticBrowserActions.ts. buildAntigenExtractionExpr and the pure helpers
 * are exported for unit testing without a real browser.
 */

import WebSocket from "ws";

import type { HumanVerificationChallengeType } from "@aegis/types";

import { BrowserTimingScope } from "./browserTiming.js";
import { isHumanVerificationEnabled } from "./humanVerificationState.js";

// ─── Public types ────────────────────────────────────────────────────────────

export type AntigenCandidateKind =
  | "link"
  | "button"
  | "input"
  | "textarea"
  | "select"
  | "control"
  | "editable"
  | "summary"
  | "unknown";

export interface AntigenSnapshotCandidate {
  index: number;
  tag: string;
  kind: AntigenCandidateKind;
  role: string | null;
  name: string;
  normalized_name: string;
  id: string | null;
  href: string | null;
  href_path: string | null;
  visible: boolean;
  enabled: boolean;
  typeable: boolean;
  clickable: boolean;
  /**
   * Bounding box. `x`/`y` are viewport-relative (used by the realistic pointer
   * click). `doc_x`/`doc_y` are document-space (viewport coord + page scroll
   * offset at snapshot time) and exist only so an offscreen ref can be scrolled
   * into view later. All geometry is internal — never exposed to the agent.
   */
  box: { x: number; y: number; width: number; height: number; doc_x?: number; doc_y?: number };
  /**
   * Bounded, visible-page-derived disambiguation context for repeated/generic
   * controls (e.g. two "Add to bag" buttons on different product cards).
   * `label`/`section` are agent-facing; `nearby_text` is internal-only.
   * Never carries input values, secrets, raw DOM, hrefs, or coordinates.
   */
  context?: AntigenSnapshotContext;
  /**
   * Safe, redacted current-value metadata for field-like candidates so the agent
   * can SEE whether a field is already filled (and skip it during exact fill).
   * Present only for input/textarea/select/contenteditable. Sensitive fields
   * (credential/payment/identity/financial) expose only present/length/flags —
   * never the raw value. See AntigenRawValueMeta.
   */
  value_meta?: AntigenRawValueMeta;
  /**
   * Active-overlay membership for this candidate (modal/dialog/popover/toast/
   * drawer/top-layer overlay). Present only when the element sits inside a
   * detected overlay container. See AntigenOverlayInfo.
   */
  overlay?: AntigenOverlayInfo;
}

/** Bounded disambiguation context. label≤120, section≤80, nearby_text≤160. */
export interface AntigenSnapshotContext {
  label?: string;
  section?: string;
  nearby_text?: string;
}

/**
 * Structural overlay/top-layer kind a candidate belongs to. Derived from the
 * page-side IIFE by walking ancestors (role=dialog/alertdialog, aria-modal,
 * native <dialog open>, [popover] showing, fixed high-z-index large-coverage
 * containers, and toast/drawer panels) — NOT from section-keyword matching.
 */
export type AntigenOverlayType =
  | "dialog"
  | "alertdialog"
  | "popover"
  | "toast"
  | "drawer"
  | "overlay";

/**
 * Per-candidate active-overlay membership. Attached when the element sits inside
 * a detected overlay container so the agent can SEE that a ref belongs to an
 * active modal/popover/toast and act on it first.
 *
 * SAFETY: `modal_title` is derived ONLY from the container's accessible name
 * (aria-label / aria-labelledby / inner heading / title attribute) — it NEVER
 * reads an input value. `in_inert` / `bg_hidden` are internal ranking signals
 * (background content behind a blocking modal) and are stripped from the
 * agent-facing view. This mirrors the redaction discipline of
 * AntigenSnapshotContext.
 */
export interface AntigenOverlayInfo {
  overlay_type: AntigenOverlayType;
  /** True for aria-modal / native :modal / large fixed high-z backdrop. */
  blocking: boolean;
  /** Accessible title of the overlay container (clipped, value-free). */
  modal_title?: string;
  /** This element is the overlay's close/dismiss control. */
  is_dismiss?: boolean;
  /**
   * The overlay container classified as a human-verification challenge
   * ("Press & Hold to confirm you are a human", reCAPTCHA-style checkboxes,
   * captcha prompts). Detected ONLY on structurally-blocking containers via
   * strong text phrases — never on ordinary promo/marketing modals. Derived
   * from value-free container text/titles/accessible names only.
   */
  human_verification?: true;
  /** Challenge sub-type when `human_verification` is set. */
  hv_challenge_type?: HumanVerificationChallengeType;
  /**
   * Internal: this element is the challenge's interactive control (the
   * press-and-hold button or the human checkbox). Targeting metadata for the
   * Human Presence Relay — stripped from the agent-facing view.
   */
  hv_control?: true;
  /** Internal: element is inside an [inert] ancestor (non-interactive background). */
  in_inert?: boolean;
  /** Internal: element is inside an aria-hidden background while a modal is open. */
  bg_hidden?: boolean;
  /**
   * Internal: this is a background-behind-modal marker (set via in_inert /
   * bg_hidden only), NOT a positive overlay membership. The page map uses it to
   * demote/exclude the element; the external view omits the overlay block
   * entirely so the agent is never told a background element "is" an overlay.
   */
  background?: boolean;
}

/**
 * Safe, redacted current-value metadata for a field-like candidate.
 *
 * Added so the agent can detect already-filled fields and use the exact-
 * replacement (browser_set_value) path idempotently instead of appending.
 *
 * REDACTION RULE — enforced in the page IIFE AND re-enforced by
 * `sanitizeValueMeta`: when `sensitive` is true, ONLY `value_present`,
 * `value_length`, `checked`, `required`, `readonly`, `aria_invalid` survive.
 * `value`, `selected_value`, `selected_text`, and `validation_message` are
 * dropped. This metadata NEVER carries a password, card number, CVV, or any
 * credential/payment/identity value. This is the deliberate, scoped exception
 * to the "snapshot never reads .value" rule — it applies ONLY to the Antigen
 * snapshot, not to AgentSafeObservationSnapshot.
 */
export interface AntigenRawValueMeta {
  /** True when the field classifies as credential/payment/identity/financial. */
  sensitive: boolean;
  /** Sensitivity kind when sensitive: credential | payment | identity | financial. */
  sensitivity: string | null;
  /** Non-sensitive text input / textarea / contenteditable current value (clipped). */
  value?: string;
  /** Whether the field currently holds any value (length > 0). Safe for sensitive. */
  value_present?: boolean;
  /** Current value length. Safe for sensitive fields — carries no content. */
  value_length?: number;
  /**
   * True when the field's value is only a mask/placeholder template (e.g.
   * "+1-___-___-____") or formatting, not a real user-provided value. When set,
   * value_present is false. Carries no content — safe for sensitive fields.
   */
  value_placeholder_only?: boolean;
  /** <select> currently-selected option value (non-sensitive only). */
  selected_value?: string | null;
  /** <select> currently-selected option visible text (non-sensitive only, clipped). */
  selected_text?: string | null;
  /** checkbox / radio checked state. */
  checked?: boolean;
  /** required attribute present. */
  required?: boolean;
  /** readonly attribute present. */
  readonly?: boolean;
  /** aria-invalid="true". */
  aria_invalid?: boolean;
  /** Native validity message (non-sensitive only, clipped). */
  validation_message?: string;
}

/**
 * Page-level metadata captured alongside (but independently of) candidate
 * extraction. INTERNAL ONLY — consumed server-side by the Snapshot v2 page map
 * to derive QUALITATIVE fields (page_kind, viewport_status, current_scroll,
 * visible_text_hash). Raw numbers here NEVER reach the agent. `text_excerpt` is
 * derived from `document.body.innerText`, which excludes form-control values, so
 * no field values or secrets are captured. Bounded in the IIFE.
 */
export interface AntigenPageMeta {
  viewport_w?: number;
  viewport_h?: number;
  scroll_x?: number;
  scroll_y?: number;
  doc_h?: number;
  heading?: string;
  text_excerpt?: string;
}

/**
 * Pre-resolved CDP target (browser WS endpoint + the single page target) threaded
 * in by the snapshot handler so DOM extraction, page-metadata extraction, and the
 * stored snapshot URL all bind to the SAME live target — selected once via
 * `pickBestPageTarget`. When omitted, the extraction function falls back to its own
 * `/json/list` fetch + `pickAntigenPageTarget` (unchanged legacy behavior).
 */
export interface PreResolvedSnapshotTarget {
  browserWsUrl: string;
  pageTarget: { id: string; url: string };
}

export interface ExtractAntigenSnapshotCandidatesParams {
  /** CDP http endpoint, e.g. http://localhost:9222 (not a ws:// URL). */
  cdpUrl: string;
  /** Hard cap on returned candidates. Default 200. */
  maxCandidates?: number;
  /** If true (default), only elements intersecting the current viewport. */
  viewportOnly?: boolean;
  /** Optional single target to bind to; skips this function's own fetch+pick. */
  resolvedTarget?: PreResolvedSnapshotTarget;
}

/**
 * Raw, JSON-serializable record returned by the page-side IIFE for a single
 * surviving (visible) element. Carries only safe signals — never values for
 * sensitive fields. The TS layer derives kind / typeable / clickable /
 * normalized_name / href_path from these signals.
 */
export interface RawAntigenCandidate {
  tag: string;
  type: string | null;
  role: string | null;
  content_editable: boolean;
  id: string | null;
  href: string | null;
  disabled: boolean;
  aria_disabled: boolean;
  read_only: boolean;
  name: string;
  box: { x: number; y: number; width: number; height: number; doc_x?: number; doc_y?: number };
  /** Raw, page-derived disambiguation context (bounded in the IIFE). */
  context?: AntigenSnapshotContext;
  /** Raw, page-derived redacted value metadata for field-like elements. */
  value_meta?: AntigenRawValueMeta | null;
  /** Raw, page-derived active-overlay membership (bounded in the IIFE). */
  overlay?: AntigenOverlayInfo | null;
}

const DEFAULT_MAX_CANDIDATES = 200;

// ─── Context bounds (shared by IIFE + TS sanitizer) ──────────────────────────
const CONTEXT_LABEL_MAX = 120;
const CONTEXT_SECTION_MAX = 80;
const CONTEXT_NEARBY_MAX = 160;

// ─── Value-meta bounds (shared by IIFE + TS sanitizer) ───────────────────────
const VALUE_TEXT_MAX = 200;
const VALIDATION_MESSAGE_MAX = 120;

// ─── Overlay bounds / enum (shared by IIFE + TS sanitizer) ───────────────────
const OVERLAY_TITLE_MAX = 120;
const OVERLAY_TYPES: ReadonlySet<string> = new Set<AntigenOverlayType>([
  "dialog",
  "alertdialog",
  "popover",
  "toast",
  "drawer",
  "overlay",
]);

/** Valid hv_challenge_type values (mirrors HumanVerificationChallengeType). */
export const HV_CHALLENGE_TYPES: ReadonlySet<string> = new Set<HumanVerificationChallengeType>([
  "press_and_hold",
  "checkbox_human",
  "image_captcha",
  "text_captcha",
  "puzzle_captcha",
  "unknown_human_verification",
]);

/**
 * The candidate selector list from docs/antigen-snapshot/extraction-strategy.md.
 * Generic visible interactive elements — deliberately site-agnostic.
 */
export const ANTIGEN_CANDIDATE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "details > summary",
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

// ─── Pure helpers (browser-agnostic; unit-testable) ──────────────────────────

const TEXTLIKE_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "tel",
  "url",
  "number",
  "password",
]);

const BUTTONLIKE_INPUT_TYPES = new Set(["submit", "button", "reset"]);

const TYPEABLE_ROLES = new Set(["textbox", "searchbox", "combobox"]);

const CONTROL_ROLES = new Set(["checkbox", "radio", "switch", "option"]);

/**
 * Deterministic name normalization for `normalized_name`, per the pipeline in
 * docs/antigen-snapshot/scoring-and-fallback-resolution.md. Only the minimal
 * normalization needed for normalized_name is implemented here; tokenization,
 * generic-word removal, and scoring are deferred to a later phase.
 *
 * lowercase → replace -_/| with space → strip .,!?;:'"()[]{} (keep &)
 *  → collapse whitespace → trim.
 */
export function normalizeName(name: string): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[-_/|]+/g, " ")
    .replace(/[.,!?;:'"()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Re-clamps and cleans raw page-derived context (defense-in-depth against a
 * malicious page that ignores the IIFE bounds). Trims, collapses whitespace,
 * enforces per-field maxima, drops fields that merely echo the element name,
 * and returns `undefined` when nothing useful remains. Never reads or carries
 * values, secrets, hrefs, DOM, or coordinates.
 */
export function sanitizeContext(
  raw: AntigenSnapshotContext | null | undefined,
  name: string,
): AntigenSnapshotContext | undefined {
  if (!raw) return undefined;
  const echo = normalizeName(name);
  const clean = (value: unknown, max: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.replace(/\s+/g, " ").trim().slice(0, max);
    if (!trimmed) return undefined;
    if (echo && normalizeName(trimmed) === echo) return undefined; // pure name echo
    return trimmed;
  };
  const out: AntigenSnapshotContext = {};
  const label = clean(raw.label, CONTEXT_LABEL_MAX);
  const section = clean(raw.section, CONTEXT_SECTION_MAX);
  const nearby = clean(raw.nearby_text, CONTEXT_NEARBY_MAX);
  if (label) out.label = label;
  if (section) out.section = section;
  if (nearby) out.nearby_text = nearby;
  return out.label || out.section || out.nearby_text ? out : undefined;
}

/**
 * Re-clamps and HARD-REDACTS raw page-derived value metadata (defense-in-depth
 * against a malicious page that ignores the IIFE redaction). When `sensitive` is
 * true, `value`, `selected_value`, `selected_text`, and `validation_message` are
 * dropped unconditionally — only `value_present`/`value_length`/`checked`/
 * `required`/`readonly`/`aria_invalid` survive. Never carries credential,
 * payment, or identity values.
 */
export function sanitizeValueMeta(
  raw: AntigenRawValueMeta | null | undefined,
): AntigenRawValueMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const sensitive = raw.sensitive === true;
  const out: AntigenRawValueMeta = {
    sensitive,
    sensitivity: typeof raw.sensitivity === "string" ? raw.sensitivity : null,
  };
  const clipText = (value: unknown, max: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.replace(/\s+/g, " ").trim().slice(0, max);
    return trimmed ? trimmed : undefined;
  };
  if (typeof raw.value_present === "boolean") out.value_present = raw.value_present;
  if (typeof raw.value_length === "number" && raw.value_length >= 0) out.value_length = raw.value_length;
  if (raw.value_placeholder_only === true) out.value_placeholder_only = true;
  if (typeof raw.checked === "boolean") out.checked = raw.checked;
  if (raw.required === true) out.required = true;
  if (raw.readonly === true) out.readonly = true;
  if (raw.aria_invalid === true) out.aria_invalid = true;
  // Value-bearing fields survive ONLY for non-sensitive controls.
  if (!sensitive) {
    const value = clipText(raw.value, VALUE_TEXT_MAX);
    if (value !== undefined) out.value = value;
    if (typeof raw.selected_value === "string") out.selected_value = raw.selected_value.slice(0, VALUE_TEXT_MAX);
    const selectedText = clipText(raw.selected_text, VALUE_TEXT_MAX);
    if (selectedText !== undefined) out.selected_text = selectedText;
    const validationMessage = clipText(raw.validation_message, VALIDATION_MESSAGE_MAX);
    if (validationMessage !== undefined) out.validation_message = validationMessage;
  }
  return out;
}

/**
 * Re-validates and clamps raw page-derived overlay membership (defense-in-depth
 * layer 2, mirroring `sanitizeContext`). Drops unknown `overlay_type` values,
 * coerces `blocking`/flags to literal booleans, and clips `modal_title` —
 * dropping a title that merely echoes the element's own name. `modal_title`
 * NEVER carries a field value (the IIFE sources it from accessible
 * name/heading/title only). Returns `undefined` when nothing valid remains.
 */
export function sanitizeOverlay(
  raw: AntigenOverlayInfo | null | undefined,
  name: string,
): AntigenOverlayInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const type = raw.overlay_type;
  if (typeof type !== "string" || !OVERLAY_TYPES.has(type)) return undefined;
  const out: AntigenOverlayInfo = {
    overlay_type: type,
    blocking: raw.blocking === true,
  };
  const echo = normalizeName(name);
  if (typeof raw.modal_title === "string") {
    const title = raw.modal_title.replace(/\s+/g, " ").trim().slice(0, OVERLAY_TITLE_MAX);
    if (title && !(echo && normalizeName(title) === echo)) out.modal_title = title;
  }
  if (raw.is_dismiss === true) out.is_dismiss = true;
  if (raw.in_inert === true) out.in_inert = true;
  if (raw.bg_hidden === true) out.bg_hidden = true;
  if (raw.background === true) out.background = true;
  // Human-verification classification: booleans/enum only — the matched text
  // never leaves the page. Unknown sub-type strings clamp to the safe default.
  if (raw.human_verification === true) {
    out.human_verification = true;
    const hvType = raw.hv_challenge_type;
    out.hv_challenge_type =
      typeof hvType === "string" && HV_CHALLENGE_TYPES.has(hvType)
        ? (hvType as HumanVerificationChallengeType)
        : "unknown_human_verification";
    if (raw.hv_control === true) out.hv_control = true;
  }
  return out;
}

/** Pathname-only portion of an href. Origin and query string are dropped. */
export function hrefPath(href: string | null): string | null {
  if (!href) return null;
  const raw = href.trim();
  if (!raw) return null;
  // Skip non-navigational hrefs that have no meaningful path.
  if (raw.startsWith("#") || raw.toLowerCase().startsWith("javascript:")) return null;
  try {
    // Base lets relative hrefs resolve; absolute hrefs ignore the base.
    return new URL(raw, "http://antigen.invalid").pathname || null;
  } catch {
    return null;
  }
}

/** kind inference per the table in extraction-strategy.md. */
export function inferKind(raw: RawAntigenCandidate): AntigenCandidateKind {
  const tag = raw.tag;
  const type = raw.type;
  const role = raw.role;

  // ARIA role takes priority for semantic classification where unambiguous.
  if (role === "link") return "link";
  if (role === "button" || role === "menuitem" || role === "tab") return "button";
  if (role === "combobox") return "select";
  if (role === "searchbox" || role === "textbox") return tag === "textarea" ? "textarea" : "input";
  if (role && CONTROL_ROLES.has(role)) return "control";

  if (tag === "a") return raw.href ? "link" : "unknown";
  if (tag === "button") return "button";
  if (tag === "select") return "select";
  if (tag === "textarea") return "textarea";
  if (tag === "summary") return "summary";

  if (tag === "input") {
    if (type && BUTTONLIKE_INPUT_TYPES.has(type)) return "button";
    if (type === "checkbox" || type === "radio") return "control";
    // text, search, email, tel, url, number, password, or untyped → input
    return "input";
  }

  if (raw.content_editable) return "editable";

  return "unknown";
}

/**
 * The semantic role surfaced on the candidate. Explicit role attribute wins;
 * otherwise a reasonable default is inferred from tag/type. May be null.
 */
export function inferRole(raw: RawAntigenCandidate): string | null {
  if (raw.role) return raw.role;
  const { tag, type } = raw;
  if (tag === "a" && raw.href) return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "summary") return "button";
  if (tag === "input") {
    if (type === "search") return "searchbox";
    if (type && BUTTONLIKE_INPUT_TYPES.has(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (!type || TEXTLIKE_INPUT_TYPES.has(type)) return "textbox";
  }
  if (raw.content_editable) return "textbox";
  return null;
}

/** enabled = not disabled and not aria-disabled. (readonly affects typeable.) */
export function computeEnabled(raw: RawAntigenCandidate): boolean {
  return !raw.disabled && !raw.aria_disabled;
}

/** A field is typeable if it accepts text input and is enabled and editable. */
export function inferTypeable(raw: RawAntigenCandidate): boolean {
  if (!computeEnabled(raw) || raw.read_only) return false;
  if (raw.tag === "textarea") return true;
  if (raw.content_editable) return true;
  if (raw.role && TYPEABLE_ROLES.has(raw.role)) return true;
  if (raw.tag === "input") {
    const type = raw.type;
    if (!type) return true; // untyped input defaults to text
    return TEXTLIKE_INPUT_TYPES.has(type);
  }
  return false;
}

/**
 * Clickable = the element is primarily an action/navigation target rather than
 * a text field. Text inputs, textareas, and editable regions are typeable, not
 * click targets, so they are not marked clickable here.
 */
export function inferClickable(raw: RawAntigenCandidate): boolean {
  const kind = inferKind(raw);
  switch (kind) {
    case "link":
    case "button":
    case "control":
    case "summary":
    case "select":
      return true;
    case "input":
    case "textarea":
    case "editable":
      return false;
    default:
      // unknown: clickable only if it is not a typeable field.
      return !inferTypeable(raw);
  }
}

/** Assemble a final candidate from a raw record + its position. */
export function mapRawToCandidate(raw: RawAntigenCandidate, index: number): AntigenSnapshotCandidate {
  const candidate: AntigenSnapshotCandidate = {
    index,
    tag: raw.tag,
    kind: inferKind(raw),
    role: inferRole(raw),
    name: raw.name,
    normalized_name: normalizeName(raw.name),
    id: raw.id,
    href: raw.href,
    href_path: hrefPath(raw.href),
    visible: true, // raw records only exist for elements that passed the visibility filter
    enabled: computeEnabled(raw),
    typeable: inferTypeable(raw),
    clickable: inferClickable(raw),
    box: raw.box,
  };
  // Only attach context when something useful survives sanitization — keeps the
  // key off candidates that have no disambiguation context.
  const context = sanitizeContext(raw.context, raw.name);
  if (context) candidate.context = context;
  // Redacted current-value metadata for field-like candidates (skip-aware fill).
  const valueMeta = sanitizeValueMeta(raw.value_meta);
  if (valueMeta) candidate.value_meta = valueMeta;
  // Active-overlay membership (modal/popover/toast/drawer/top-layer).
  const overlay = sanitizeOverlay(raw.overlay, raw.name);
  if (overlay) candidate.overlay = overlay;
  return candidate;
}

// ─── Shared active-overlay / top-layer structural snippet ────────────────────

/**
 * Raw-JS snippet (no TS — Node tsconfig has no DOM lib) that declares the
 * structural overlay classifier (`overlayKindOf` / `computeOverlay`) and its
 * helpers. It is the SINGLE source of overlay structural detection, concatenated
 * by both the full snapshot extraction IIFE (`buildAntigenExtractionExpr`) and
 * the post-click page-state probe (`buildPageStateProbeExpr` in
 * antigenClickVerification.ts), so the two surfaces can never drift in how they
 * classify modals/toasts/drawers/chat-widgets and what counts as blocking.
 *
 * Assumes these are already in scope where it is concatenated:
 *   txt, clip, attr (string helpers), and the constants OVERLAY_TITLE_MAX,
 *   OVERLAY_WALK_DEPTH, OVERLAY_DRAWER_RE, OVERLAY_DISMISS_RE, OVERLAY_CHAT_RE.
 */
export function buildOverlaySnippetJs(screenHvEnabled: boolean = false): string {
  return `
    // Screen-level (split-overlay) human-verification gate. Threaded in from the
    // env flag (ANTIGEN_HUMAN_VERIFICATION) at the snapshot call site; default
    // false keeps every other caller byte-identical. When false the decoupled
    // detector below returns null instantly and emits no new overlay members.
    var SCREEN_HV_ENABLED=${JSON.stringify(!!screenHvEnabled)};
    // ─── Active-overlay / top-layer detection (structural, not keyword) ────
    function cssOf(el){ try{ return window.getComputedStyle?window.getComputedStyle(el):null; }catch(e){ return null; } }
    function matchesSafe(el,sel){ try{ return !!(el.matches&&el.matches(sel)); }catch(e){ return false; } }
    // ─── Human-verification challenge classification (Human Presence Relay) ──
    // STRONG phrases only — deliberately NO bare "challenge"/"verify"/"security"
    // so promo/marketing modals ("We Missed You — 10% off") can never classify.
    // Declared INSIDE this shared snippet (single definition for the snapshot
    // extraction IIFE and post-click probes — zero drift). Only booleans/enums
    // escape the page; the matched text never does.
    var HV_TEXT_RE=/(confirm|verify|prove)\\s+(that\\s+)?you\\s*['\\u2019]?\\s*a?re\\s+(a\\s+)?human|i\\s*['\\u2019]?\\s*m\\s+not\\s+a\\s+robot|are\\s+you\\s+a\\s+robot|not\\s+a\\s+(ro)?bot|human\\s+verification|press\\s*(&|and)\\s*hold|security\\s+check|captcha|unusual\\s+(traffic|activity)|robot\\s+check|security\\s+challenge/i;
    var HV_HOLD_RE=/press\\s*(&|and)\\s*hold|tap\\s*(&|and)\\s*hold|hold\\s+(the\\s+)?button|hold\\s+to\\s+confirm/i;
    var HV_IMG_RE=/select\\s+(all\\s+)?(the\\s+)?(images|squares|pictures|tiles)/i;
    var HV_TXT_RE=/(type|enter)\\s+the\\s+(characters|text|letters|words)/i;
    var HV_PUZZLE_RE=/slide\\s+(the\\s+)?(puzzle|piece)|drag\\s+(the\\s+)?(puzzle|piece)|complete\\s+the\\s+puzzle/i;
    var HV_CHECKBOX_SEL='input[type="checkbox"],[role="checkbox"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="turnstile"]';
    // Per-container memo (containers repeat across member elements; the scan is
    // bounded but not free). Parallel arrays — container counts are tiny.
    var _hvMemoK=[],_hvMemoV=[];
    // Classify a container as a human-verification challenge. Returns the
    // challenge sub-type string or null. Scans ONLY value-free text: the
    // container's accessible title, a bounded normalized textContent slice, and
    // button aria-labels. Never reads .value.
    // Shared sub-type cascade — used by BOTH the per-container scan
    // (humanVerificationOf) and the screen-level split-overlay scan, so the two
    // can never drift. Input is value-free, normalized, bounded scan text plus a
    // checkbox-present boolean. STRONG phrases only (HV_TEXT_RE) — bare
    // "challenge"/"verify"/"security" never trigger. Returns an enum or null.
    function hvTypeFromScan(scan,hasCheckbox){
      if(!HV_TEXT_RE.test(scan)) return null;
      if(HV_HOLD_RE.test(scan)) return 'press_and_hold';
      if(hasCheckbox||/i\\s*['\\u2019]?\\s*m\\s+not\\s+a\\s+robot/i.test(scan)) return 'checkbox_human';
      if(HV_IMG_RE.test(scan)) return 'image_captcha';
      if(HV_TXT_RE.test(scan)) return 'text_captcha';
      if(HV_PUZZLE_RE.test(scan)) return 'puzzle_captcha';
      return 'unknown_human_verification';
    }
    function humanVerificationOf(container){
      for(var m=0;m<_hvMemoK.length;m++){ if(_hvMemoK[m]===container) return _hvMemoV[m]; }
      var res=null;
      try{
        var scan='';
        try{ scan=overlayTitle(container)+' '; }catch(e){}
        var t=''; try{ t=String(container.textContent||''); }catch(e){ t=''; }
        scan+=txt(t).slice(0,600);
        try{
          if(container.querySelectorAll){
            var bs=container.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]');
            for(var i=0;i<bs.length&&i<8;i++){ var bl=attr(bs[i],'aria-label'); if(bl) scan+=' '+String(bl); }
          }
        }catch(e){}
        var cb=null; try{ cb=container.querySelector?container.querySelector(HV_CHECKBOX_SEL):null; }catch(e){ cb=null; }
        res=hvTypeFromScan(scan,!!cb);
      }catch(e){ res=null; }
      _hvMemoK.push(container); _hvMemoV.push(res);
      return res;
    }
    // Is this element the challenge's interactive control? (press-hold button /
    // human checkbox). Internal targeting metadata only.
    function isHvControl(el,name,hvt){
      var tg=(el.tagName||'').toLowerCase();
      var role=(attr(el,'role')||'').toLowerCase();
      var type=(attr(el,'type')||'').toLowerCase();
      var nm=(name||'')+' '+(attr(el,'aria-label')||'');
      if(hvt==='press_and_hold'){
        var btn=tg==='button'||role==='button'||(tg==='input'&&(type==='button'||type==='submit'));
        return btn&&HV_HOLD_RE.test(nm);
      }
      if(hvt==='checkbox_human'){
        return (tg==='input'&&type==='checkbox')||role==='checkbox';
      }
      return false;
    }
    // Memoized page-level check: is any modal-ish container currently open?
    var _hasModal;
    function hasModalMemo(){
      if(_hasModal===undefined){
        var f=false; try{ f=!!document.querySelector('[aria-modal="true"],dialog[open]'); }catch(e){ f=false; }
        _hasModal=f;
      }
      return _hasModal;
    }
    // Viewport-coverage fraction for a fixed/sticky high-z container; -1 if the
    // node is not a positioned, meaningfully-stacked overlay candidate. This is
    // the guard against marking sticky headers / low-z banners as overlays.
    function fixedCoverage(node){
      var cs=cssOf(node); if(!cs) return -1;
      var pos=(cs.position||''); if(pos!=='fixed'&&pos!=='sticky') return -1;
      var z=parseInt(cs.zIndex,10); if(isNaN(z)) z=0;
      if(z<10) return -1;
      var r; try{ r=node.getBoundingClientRect(); }catch(e){ return -1; }
      if(!r) return -1;
      var vw=window.innerWidth||0, vh=window.innerHeight||0;
      if(vw<=0||vh<=0) return -1;
      var w=Math.min(r.width,vw), h=Math.min(r.height,vh);
      if(w<=0||h<=0) return -1;
      return (w*h)/(vw*vh);
    }
    // ─── Screen-level human-verification (split overlay) ─────────────────────
    // PerimeterX/B&BW-style challenges ship as a TEXTLESS full-page dimmer plus a
    // SEPARATE centered card carrying the strong phrase. Neither container alone
    // passes the per-container test above (dimmer = blocking but textless; card =
    // text-positive but not full-coverage / not aria-modal / not role=dialog), so
    // the structural classifier misses them. This decoupled check fires ONLY when
    // BOTH (a) a full-page blocking affordance AND (b) a strong human-verification
    // phrase are present in the viewport — they need NOT share a container.
    // Gated by SCREEN_HV_ENABLED so flag-off is byte-identical (returns null
    // instantly). Memoized — runs at most once per snapshot. Bounded scans only;
    // no matched text / selectors / boxes escape — the function returns an enum.
    var _scrHvDone=false,_scrHvType=null;
    function screenHumanVerification(){
      if(_scrHvDone) return _scrHvType;
      _scrHvDone=true;
      if(!SCREEN_HV_ENABLED) return null;
      // (1) full-page blocking affordance: a fixed/sticky high-z >=0.5-coverage
      // dimmer/backdrop. Bounded scan of body's top two DOM levels — reuses
      // fixedCoverage(), the SAME blocking test the structural path uses.
      var blocker=false;
      try{
        var roots=[];
        if(document.body){
          var ch=document.body.children;
          for(var i=0;i<ch.length&&i<80;i++) roots.push(ch[i]);
        }
        for(var i=0;i<roots.length&&!blocker;i++){
          if(fixedCoverage(roots[i])>=0.5){ blocker=true; break; }
          var gc=roots[i].children;
          for(var j=0;gc&&j<gc.length&&j<24;j++){ if(fixedCoverage(gc[j])>=0.5){ blocker=true; break; } }
        }
      }catch(e){}
      if(!blocker) return null;
      // (2) strong human-verification phrase, built value-free and length-capped
      // from ONLY (a) visible buttons' names + aria-labels and (b) the text of
      // FOREGROUND positioned (fixed/absolute/sticky) high-z containers (the
      // card). No unbounded document.body text scan. STRONG phrases only via
      // hvTypeFromScan → promo/marketing copy can never match.
      var scan='',hasCheckbox=false;
      try{
        var bs=document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]');
        for(var i=0;i<bs.length&&i<40&&scan.length<1600;i++){
          var b=bs[i],br=null; try{ br=b.getBoundingClientRect(); }catch(e){}
          if(!br||!(br.width>0&&br.height>0)) continue;
          var al=attr(b,'aria-label'); if(al) scan+=' '+String(al);
          var bt=b.textContent; if(bt) scan+=' '+txt(String(bt)).slice(0,80);
        }
      }catch(e){}
      try{
        var pos=document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog,div,section,aside,main,form');
        var scanned=0;
        for(var i=0;i<pos.length&&scanned<240&&scan.length<3000;i++){
          var n=pos[i]; var cs=cssOf(n); if(!cs) continue;
          var p=cs.position||''; if(p!=='fixed'&&p!=='absolute'&&p!=='sticky') continue;
          var z=parseInt(cs.zIndex,10); if(isNaN(z)) z=0; if(z<10) continue;
          scanned++;
          var tt=n.textContent; if(tt) scan+=' '+txt(String(tt)).slice(0,400);
          if(!hasCheckbox){ try{ if(n.querySelector&&n.querySelector(HV_CHECKBOX_SEL)) hasCheckbox=true; }catch(e){} }
        }
      }catch(e){}
      scan=txt(scan);
      _scrHvType=hvTypeFromScan(scan,hasCheckbox);
      return _scrHvType;
    }
    // Accessible title of an overlay container — VALUE-FREE (aria-label /
    // aria-labelledby / inner heading / title attr only; never reads .value).
    function overlayTitle(node){
      var al=txt(attr(node,'aria-label')); if(al) return clip(al,OVERLAY_TITLE_MAX);
      var lb=attr(node,'aria-labelledby');
      if(lb){
        var ids=lb.split(/\\s+/), parts=[];
        for(var i=0;i<ids.length;i++){ try{ var ref=document.getElementById(ids[i]); if(ref) parts.push(ref.textContent||''); }catch(e){} }
        var t=txt(parts.join(' ')); if(t) return clip(t,OVERLAY_TITLE_MAX);
      }
      try{ if(node.querySelector){ var h=node.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]'); if(h){ var ht=txt(h.innerText!=null?h.innerText:h.textContent); if(ht) return clip(ht,OVERLAY_TITLE_MAX); } } }catch(e){}
      var ti=txt(attr(node,'title')); if(ti) return clip(ti,OVERLAY_TITLE_MAX);
      return '';
    }
    // Classify a single ancestor as an overlay container. Precedence:
    // native modal dialog → ARIA dialog/alertdialog → popover → toast/live →
    // drawer/flyout keyword → generic fixed high-z large-coverage overlay.
    function overlayKindOf(node){
      var tg=(node.tagName||'').toLowerCase();
      var role=attr(node,'role'); role=role?String(role).toLowerCase():'';
      var ariaModal=attr(node,'aria-modal')==='true';
      // Chat/help/support widgets float over the page but never trap the user.
      // Detected FIRST so a large open chat panel (even one using role=dialog or
      // a >=0.5 coverage backdrop) is reported as a NONBLOCKING popover and can
      // never win active_overlay over a real blocking modal. Signal = container
      // class/id/aria-label only — never element text or values.
      var chatSig=(attr(node,'class')||'')+' '+(attr(node,'id')||'')+' '+(attr(node,'aria-label')||'');
      if(OVERLAY_CHAT_RE.test(chatSig)) return {type:'popover',blocking:false};
      if(tg==='dialog'){
        var open=false; try{ open=(node.open===true)||(attr(node,'open')!=null); }catch(e){ open=attr(node,'open')!=null; }
        if(open) return {type:'dialog',blocking:ariaModal||matchesSafe(node,':modal')};
      }
      if(role==='dialog'||role==='alertdialog'){
        return {type:role==='alertdialog'?'alertdialog':'dialog',blocking:ariaModal||fixedCoverage(node)>=0.5};
      }
      // A [popover] ancestor with a visible candidate inside is, by construction,
      // showing (closed popovers render display:none and are filtered upstream).
      if(attr(node,'popover')!=null) return {type:'popover',blocking:ariaModal};
      if(role==='alert'||role==='status') return {type:'toast',blocking:false};
      var live=attr(node,'aria-live'); if(live){ live=String(live).toLowerCase(); if(live==='polite'||live==='assertive') return {type:'toast',blocking:false}; }
      var cls=(attr(node,'class')||'')+' '+(attr(node,'id')||'');
      if(OVERLAY_DRAWER_RE.test(cls)) return {type:'drawer',blocking:fixedCoverage(node)>=0.5};
      // Human-verification interstitial WITHOUT dialog ARIA: PerimeterX-style
      // "Press & Hold" widgets often ship as a bare fixed full-coverage dimmer
      // with no role=dialog. A fixed high-coverage container whose text STRONGLY
      // matches a human-verification phrase is a blocking challenge overlay.
      // The strong-phrase regex plus the >=0.5 coverage requirement keeps promo
      // heroes / sticky chrome excluded (they fail the text test). This is the
      // ONLY keyword-assisted overlay branch, scoped to human verification.
      if(fixedCoverage(node)>=0.5&&humanVerificationOf(node)) return {type:'dialog',blocking:true};
      // NO generic fixed-coverage overlay branch: a positioned high-z container
      // with no ARIA role / native dialog / popover / toast / drawer signal is
      // NOT treated as an overlay. Sticky filter toolbars, promo heroes, and
      // header bars are positioned + high-z but are page chrome, not modals —
      // marking them overlays produced live false positives. Real overlays expose
      // an explicit role (e.g. role=dialog), so structural signals are the sole
      // authority. fixedCoverage remains the BLOCKING test for real dialogs and
      // drawers above.
      return null;
    }
    function hasInertAncestor(el){
      var node=el, depth=0;
      while(node&&depth<OVERLAY_WALK_DEPTH){
        var inert=false; try{ inert=(node.inert===true)||(attr(node,'inert')!=null); }catch(e){ inert=attr(node,'inert')!=null; }
        if(inert) return true;
        node=node.parentElement; depth++;
      }
      return false;
    }
    // Element's OWN aria-hidden is already filtered by rectOf; start at parent.
    function hasAriaHiddenAncestor(el){
      var node=el.parentElement, depth=0;
      while(node&&depth<OVERLAY_WALK_DEPTH){
        if(attr(node,'aria-hidden')==='true') return true;
        node=node.parentElement; depth++;
      }
      return false;
    }
    function isDismissEl(el,name){
      var al=txt(attr(el,'aria-label')); if(al&&OVERLAY_DISMISS_RE.test(al)) return true;
      if(attr(el,'data-dismiss')!=null||attr(el,'data-close')!=null) return true;
      var nm=name?String(name).trim():'';
      if(/^(close|dismiss|×|x|✕|✖|⨯)$/i.test(nm)) return true;
      if(nm&&OVERLAY_DISMISS_RE.test(nm)) return true;
      return false;
    }
    // Bounded ancestor walk: innermost match sets type/title; blocking ORs up.
    function computeOverlay(el,name){
      var type=null, container=null, blocking=false, node=el, depth=0;
      while(node&&depth<OVERLAY_WALK_DEPTH){
        var k=null; try{ k=overlayKindOf(node); }catch(e){ k=null; }
        if(k){ if(!type){ type=k.type; container=node; } if(k.blocking) blocking=true; }
        node=node.parentElement; depth++;
      }
      var inInert=false; try{ inInert=hasInertAncestor(el); }catch(e){ inInert=false; }
      if(!type){
        // Screen-level human-verification (split overlay): the challenge control
        // (e.g. the Press & Hold button) has NO overlay ancestor — the dimmer is
        // a sibling. When the decoupled screen detector is active and THIS element
        // is the challenge control, emit the single blocking human_verification
        // member the lifecycle needs to arm. Background refs are then blocked via
        // the existing blocking_active path (no per-background mutation). Gated by
        // SCREEN_HV_ENABLED inside screenHumanVerification() — null when flag off.
        var scrHv=null; try{ scrHv=screenHumanVerification(); }catch(e){ scrHv=null; }
        if(scrHv){
          var isCtl=false; try{ isCtl=isHvControl(el,name,scrHv); }catch(e){ isCtl=false; }
          if(isCtl) return { overlay_type:'dialog', blocking:true, human_verification:true, hv_challenge_type:scrHv, hv_control:true };
        }
        // No positive overlay membership — emit a background marker ONLY when the
        // element is inert, or aria-hidden background while a REAL modal
        // (aria-modal / native <dialog open>) is open. Both are precise ARIA
        // modality primitives. We deliberately do NOT infer modals from container
        // class names or large aria-hidden regions: real marketing pages (e.g.
        // hero carousels with an "...overlay" class behind an aria-hidden region)
        // would be misread as blocking modals. Structural detection above
        // (role=dialog/alertdialog, native <dialog>, popover, toast, drawer,
        // fixed-coverage) is the authority. The page map uses this marker to
        // demote/exclude; the external view drops it.
        var bgHidden=false; try{ bgHidden=hasAriaHiddenAncestor(el)&&hasModalMemo(); }catch(e){ bgHidden=false; }
        if(!inInert&&!bgHidden) return null;
        var bg={ overlay_type:'overlay', blocking:false, background:true };
        if(inInert) bg.in_inert=true;
        if(bgHidden) bg.bg_hidden=true;
        return bg;
      }
      var ov={ overlay_type:type, blocking:blocking };
      var title=''; try{ title=overlayTitle(container); }catch(e){ title=''; }
      if(title) ov.modal_title=title;
      try{ if(isDismissEl(el,name)) ov.is_dismiss=true; }catch(e){}
      if(inInert) ov.in_inert=true;
      // Human-verification classification — STRUCTURE FIRST (only blocking
      // containers are scanned), strong keywords second. Emits booleans/enum
      // only; the matched text never escapes the page.
      if(blocking&&container){
        var hvt=null; try{ hvt=humanVerificationOf(container); }catch(e){ hvt=null; }
        if(hvt){
          ov.human_verification=true;
          ov.hv_challenge_type=hvt;
          try{ if(isHvControl(el,name,hvt)) ov.hv_control=true; }catch(e){}
        }
      }
      // Screen-level augmentation: the element has an overlay ancestor that the
      // structural pass did NOT classify as human-verification, but a split-overlay
      // screen challenge is active and THIS element is its control. Mark it as the
      // blocking HV member. Gated via screenHumanVerification() (null when flag off).
      if(!ov.human_verification){
        var scrHv2=null; try{ scrHv2=screenHumanVerification(); }catch(e){ scrHv2=null; }
        if(scrHv2){
          var isCtl2=false; try{ isCtl2=isHvControl(el,name,scrHv2); }catch(e){ isCtl2=false; }
          if(isCtl2){ ov.human_verification=true; ov.hv_challenge_type=scrHv2; ov.hv_control=true; ov.blocking=true; }
        }
      }
      return ov;
    }`;
}

// ─── Page-side extraction IIFE builder ───────────────────────────────────────

/**
 * Builds the raw JS string IIFE evaluated in the page via Runtime.evaluate.
 *
 * It returns an array of RawAntigenCandidate. The IIFE:
 *   1. Queries the candidate selector list.
 *   2. Skips input[type=hidden] entirely.
 *   3. Filters by visibility (box, display, visibility, opacity, aria-hidden,
 *      and — when viewportOnly — viewport intersection).
 *   4. Resolves a safe accessible name WITHOUT reading sensitive field values.
 *   5. Captures the current getBoundingClientRect() box.
 *   6. Caps at maxCandidates in DOM order.
 *
 * Options are interpolated via JSON.stringify — never raw string concatenation.
 */
export function buildAntigenExtractionExpr(opts: {
  maxCandidates: number;
  viewportOnly: boolean;
}): string {
  const selector = JSON.stringify(ANTIGEN_CANDIDATE_SELECTOR);
  const maxCandidates = JSON.stringify(opts.maxCandidates);
  const viewportOnly = JSON.stringify(opts.viewportOnly);
  const labelMax = JSON.stringify(CONTEXT_LABEL_MAX);
  const sectionMax = JSON.stringify(CONTEXT_SECTION_MAX);
  const nearbyMax = JSON.stringify(CONTEXT_NEARBY_MAX);
  const valueMax = JSON.stringify(VALUE_TEXT_MAX);
  const validationMax = JSON.stringify(VALIDATION_MESSAGE_MAX);
  const overlayTitleMax = JSON.stringify(OVERLAY_TITLE_MAX);

  return `(function(){
    var SELECTOR=${selector};
    var MAX=${maxCandidates};
    var VIEWPORT_ONLY=${viewportOnly};
    var CTX_LABEL_MAX=${labelMax};
    var CTX_SECTION_MAX=${sectionMax};
    var CTX_NEARBY_MAX=${nearbyMax};
    var VALUE_MAX=${valueMax};
    var VALIDATION_MAX=${validationMax};
    var OVERLAY_TITLE_MAX=${overlayTitleMax};
    var OVERLAY_WALK_DEPTH=12;
    var OVERLAY_DRAWER_RE=/(drawer|flyout|off-?canvas|side-?panel|slide-?over|snackbar)/i;
    var OVERLAY_DISMISS_RE=/\\b(close|dismiss|no thanks|not now|maybe later)\\b/i;
    // Chat/help/support widget container signal — these float over the page but
    // must NEVER be treated as blocking modals (they don't trap the user).
    var OVERLAY_CHAT_RE=/(chat|messeng|intercom|zendesk|drift|live\\s*help|support\\s*widget|help\\s*widget|chat\\s*widget|launcher)/i;
    var CTX_WALK_DEPTH=8;
    // Page scroll offset, captured once for this snapshot. Box x/y stay
    // viewport-relative (used by the realistic pointer click); doc_x/doc_y add
    // document-space geometry so an offscreen ref can be scrolled into view
    // later. Internal only — never exposed to the agent.
    var SX=(window.pageXOffset||(document.documentElement&&document.documentElement.scrollLeft)||0);
    var SY=(window.pageYOffset||(document.documentElement&&document.documentElement.scrollTop)||0);
    function txt(s){ return (s==null?'':String(s)).replace(/\\s+/g,' ').trim(); }
    function clip(s,max){ s=txt(s); return s.length>max?s.slice(0,max):s; }
    function attr(el,n){ try{ return el.getAttribute(n); }catch(e){ return null; } }
    function rectOf(el){
      var r=el.getBoundingClientRect();
      if(!(r.width>0&&r.height>0)) return null;
      var cs=null; try{ cs=(window.getComputedStyle?window.getComputedStyle(el):null); }catch(e){ cs=null; }
      if(cs){
        if(cs.display==='none') return null;
        if(cs.visibility==='hidden'||cs.visibility==='collapse') return null;
        if(String(cs.opacity)==='0') return null;
      }
      if(attr(el,'aria-hidden')==='true') return null;
      if(VIEWPORT_ONLY){
        var right=r.left+r.width, bottom=r.top+r.height;
        var vw=window.innerWidth, vh=window.innerHeight;
        if(!(r.left<vw&&right>0&&r.top<vh&&bottom>0)) return null;
      }
      return r;
    }
    function nameOf(el,tag,type){
      var al=attr(el,'aria-label'); if(txt(al)) return txt(al);
      var lb=attr(el,'aria-labelledby');
      if(lb){
        var ids=lb.split(/\\s+/); var parts=[];
        for(var i=0;i<ids.length;i++){ try{ var ref=document.getElementById(ids[i]); if(ref) parts.push(ref.textContent||''); }catch(e){} }
        var t=txt(parts.join(' ')); if(t) return t;
      }
      // Associated <label> elements (HTMLInputElement.labels). Never reads value.
      try{
        if(el.labels&&el.labels.length){
          var lp=[]; for(var j=0;j<el.labels.length;j++){ lp.push(el.labels[j].textContent||''); }
          var lt=txt(lp.join(' ')); if(lt) return lt;
        }
      }catch(e){}
      // alt text of an inner <img> (for icon links/buttons).
      try{ if(el.querySelector){ var img=el.querySelector('img'); if(img){ var a=attr(img,'alt'); if(txt(a)) return txt(a); } } }catch(e){}
      var ti=attr(el,'title'); if(txt(ti)) return txt(ti);
      // value is read ONLY for submit/button/reset inputs (the button label).
      // Never for password/hidden/payment/identity/text fields.
      if(tag==='input'&&(type==='submit'||type==='button'||type==='reset')){
        try{ if(el.value!=null){ var v=txt(el.value); if(v) return v; } }catch(e){}
      }
      var it=null; try{ it=(el.innerText!=null?el.innerText:el.textContent); }catch(e){ it=null; }
      if(txt(it)) return txt(it);
      var ph=attr(el,'placeholder'); if(txt(ph)) return txt(ph);
      return '';
    }
    // ─── Search-intent override (anti-overfire guard for weak rules) ───────
    // An explicitly search-shaped field is not a secret sink. Consulted by
    // classifySensitivity AFTER the strong rules (password type, cc-*, ssn,
    // routing) so sensitive signals always win; vetoed by sensitive wording,
    // sensitive autocomplete, or a checkout/payment/login form ancestor.
    // Fail-closed: it can only suppress the weak substring heuristics.
    var SEARCH_TOKEN_RE=/[\\s_-](search|query|q|keywords|keyword|find)[\\s_-]/;
    var SEARCH_TEXT_RE=/\\bsearch\\b|what are you looking for/;
    var SEARCH_VETO_RE=/password|passcode|secret|otp|one.time|verification|cvv|cvc|card.?number|cc-|ssn|social.security|routing|account.?number|iban|e-?mail|user.?name|login|sign.?in|phone|telephone|address|postal|zip.?code|birth|dob/;
    var SENSITIVE_FORM_RE=/checkout|payment|billing|login|sign.?in|register/;
    function isSearchIntent(el,type,name,id,ac,ph,combined){
      if(SEARCH_VETO_RE.test(combined)) return false;
      if(/cc-|current-password|new-password|one-time-code/.test(ac)) return false;
      var role=(attr(el,'role')||'').toLowerCase();
      var al=(attr(el,'aria-label')||'').toLowerCase();
      var signal = type==='search' || role==='searchbox'
        || SEARCH_TOKEN_RE.test(' '+name+' '+id+' ')
        || SEARCH_TEXT_RE.test(ph) || SEARCH_TEXT_RE.test(al);
      // Bounded ancestor walk: a search landmark approves; a checkout/payment/
      // login form vetoes (sensitive context overrides search-like signals).
      var node=el.parentElement, depth=0;
      while(node&&depth<CTX_WALK_DEPTH){
        var tg=(node.tagName||'').toLowerCase();
        var r=(attr(node,'role')||'').toLowerCase();
        if(tg==='form'){
          var fsig=((attr(node,'action')||'')+' '+(attr(node,'id')||'')+' '+(attr(node,'aria-label')||'')).toLowerCase();
          if(SENSITIVE_FORM_RE.test(fsig)) return false;
          if(/search/.test(fsig)) signal=true;
        }
        if(r==='search') signal=true;
        node=node.parentElement; depth++;
      }
      return signal;
    }
    // ─── Redacted current-value metadata (skip-aware exact fill) ───────────
    // Sensitivity classification transcribed from agentSafeObservation.ts —
    // keep the two copies in sync (see classifySensitivity there) — so
    // credential/payment/identity/financial fields are NEVER read into a value.
    function classifySensitivity(el){
      // Read property OR attribute — properties reflect in real browsers; the
      // attr fallback keeps classification correct under DOM emulators/tests and
      // for framework-managed inputs.
      var type=(el.type||attr(el,'type')||'').toLowerCase();
      var name=(el.name||attr(el,'name')||'').toLowerCase();
      var id=(el.id||attr(el,'id')||'').toLowerCase();
      var ac=(el.autocomplete||attr(el,'autocomplete')||'').toLowerCase();
      var ph=(el.placeholder||attr(el,'placeholder')||'').toLowerCase();
      var combined=' '+name+' '+id+' '+ac+' '+ph+' ';
      if(type==='password'||/current-password|new-password|one-time-code/.test(ac)) return 'credential';
      if(/cc-number|cardnumber|card.number|cc-name/.test(combined)) return 'payment';
      if(/cc-csc|cvv|cvc|security.code|card.cvc/.test(combined)) return 'payment';
      if(/cc-exp/.test(ac)) return 'payment';
      if(/ssn|social.security|passport|license|dob|birthdate|date.of.birth/.test(combined)) return 'identity';
      if(/routing|account.number|bank.account|account_number/.test(combined)) return 'financial';
      // Search override — only here; the strong rules above always win.
      try{ if(isSearchIntent(el,type,name,id,ac,ph,combined)) return null; }catch(e){}
      if(/password|passcode|pin |secret|token|api.?key|passkey|[\\s_-]key[\\s_-]/.test(combined)) return 'credential';
      if(/card|payment|billing|checkout/.test(combined)) return 'payment';
      return null;
    }
    // ─── Mask / placeholder detection (skip-aware exact fill) ──────────────
    // An input-mask library writes its template into .value (e.g. a phone field
    // shows "+1-___-___-____"). That is NOT a user-provided value, so it must
    // not count as "filled". Returns true when the value is empty, an unfilled
    // or partially-filled mask, or formatting-only. Only the derived boolean
    // escapes the page, so this is safe to run on sensitive fields too.
    function isPlaceholderOnlyValue(s){
      if(s==null) return true;
      if(s.replace(/\\s/g,'').length===0) return true; // empty / whitespace-only
      // Unfilled mask slots: a run of underscores, or an underscore next to a
      // mask separator. Guard: never apply to emails/usernames (they may carry a
      // single embedded underscore between alphanumerics, e.g. a_b@example.com).
      if(s.indexOf('@')===-1 && (/_{2,}/.test(s) || /[_][\\s\\-)\\/.]|[\\s\\-(\\/.][_]/.test(s))) return true;
      // Formatting / placeholder-glyph only (no real alphanumeric content left).
      var stripped=s.replace(/[\\s\\-()+.\\/_#•]/g,'');
      if(!/[0-9a-z]/i.test(stripped)) return true;
      return false;
    }
    function valueMetaOf(el,tag,type,editable){
      var isInput=tag==='input', isTextarea=tag==='textarea', isSelect=tag==='select';
      if(!(isInput||isTextarea||isSelect||editable)) return null;
      // Buttons/hidden are not value fields.
      if(isInput&&(type==='submit'||type==='button'||type==='reset'||type==='hidden')) return null;
      var sensitivity=null; try{ sensitivity=classifySensitivity(el); }catch(e){ sensitivity=null; }
      if(!sensitivity&&type==='password') sensitivity='credential';
      var sensitive=!!sensitivity;
      var meta={ sensitive:sensitive, sensitivity:sensitivity };
      try{ if(el.required===true) meta.required=true; }catch(e){}
      try{ if(el.readOnly===true) meta.readonly=true; }catch(e){}
      if(attr(el,'aria-invalid')==='true') meta.aria_invalid=true;
      // checkbox / radio
      if(isInput&&(type==='checkbox'||type==='radio')){
        try{ meta.checked=el.checked===true; }catch(e){}
        return meta;
      }
      // select
      if(isSelect){
        try{
          var idx=el.selectedIndex;
          if(idx!=null&&idx>=0&&el.options&&el.options[idx]){
            var opt=el.options[idx];
            var ov=opt.value!=null?String(opt.value):'';
            meta.value_present=ov.length>0;
            meta.value_length=ov.length;
            if(!sensitive){
              meta.selected_value=ov;
              var stx=txt(opt.textContent); if(stx) meta.selected_text=clip(stx,VALUE_MAX);
            }
          }
        }catch(e){}
        return meta;
      }
      // text input / textarea / contenteditable
      var cur='';
      try{ cur=editable?(el.innerText!=null?String(el.innerText):(el.textContent||'')):(el.value!=null?String(el.value):''); }catch(e){ cur=''; }
      var placeholderOnly=false; try{ placeholderOnly=isPlaceholderOnlyValue(cur); }catch(e){ placeholderOnly=false; }
      // A field is "present" only when it holds a real, complete value — a mask
      // template / unfilled placeholder does not count. value_length stays raw.
      meta.value_present=cur.length>0&&!placeholderOnly;
      meta.value_length=cur.length;
      if(cur.length>0&&placeholderOnly) meta.value_placeholder_only=true;
      if(!sensitive){
        var cv=txt(cur); if(cv) meta.value=clip(cv,VALUE_MAX);
        try{ var vm=el.validationMessage; if(vm){ var vmt=txt(vm); if(vmt) meta.validation_message=clip(vmt,VALIDATION_MAX); } }catch(e){}
      }
      return meta;
    }
    // ─── Disambiguation context (bounded, visible-text only) ───────────────
    function isHeading(node){
      if(!node||!node.tagName) return false;
      var t=node.tagName.toLowerCase();
      if(t==='h1'||t==='h2'||t==='h3'||t==='h4'||t==='h5'||t==='h6') return true;
      return attr(node,'role')==='heading';
    }
    // Nearest section: a preceding-sibling heading at some ancestor level
    // (captures "Complete with"), else an ancestor's aria-label
    // (captures "Cookie consent banner").
    // Returns {text, fromHeading}: a heading-derived section ("Complete with") is
    // a real product sub-group and blocks the main-product fallback; an ancestor
    // aria-label is a weaker grouping that does not, on its own, block it.
    function findSection(el){
      var node=el, depth=0;
      while(node&&depth<CTX_WALK_DEPTH){
        var sib=node.previousElementSibling, scan=0;
        while(sib&&scan<6){
          if(isHeading(sib)){ var h=txt(sib.innerText!=null?sib.innerText:sib.textContent); if(h) return {text:clip(h,CTX_SECTION_MAX),fromHeading:true}; }
          sib=sib.previousElementSibling; scan++;
        }
        var al=txt(attr(node,'aria-label'));
        if(al) return {text:clip(al,CTX_SECTION_MAX),fromHeading:false};
        node=node.parentElement; depth++;
      }
      return {text:'',fromHeading:false};
    }
    // Meaningful descendants of a container: peer links, headings, emphasis,
    // and images. Used both to measure breadth and to harvest identity text.
    function harvestNodes(container){
      var ns;
      try{ ns=container.querySelectorAll('a,h1,h2,h3,h4,h5,h6,strong,b,[role="heading"],img'); }catch(e){ return null; }
      try{ return Array.prototype.slice.call(ns); }catch(e){ return null; }
    }
    // Bounded identity text from a node set. Never reads input values or
    // serialized DOM; per-snippet and total length capped; de-duplicated; the
    // control's own name and the section heading are excluded.
    // Returns {text, fromLinkOrHeading}. fromLinkOrHeading marks that a
    // contributing node was a product link or heading — i.e. strong card-local
    // identity that must never be overridden by the page product header.
    function harvestFrom(ns,nameLow,sectionLow){
      var seen={}, parts=[], total=0, strong=false;
      for(var i=0;i<ns.length;i++){
        var n=ns[i]; if(!n) continue;
        var tg=(n.tagName||'').toLowerCase(), t='';
        if(tg==='img'){ t=txt(attr(n,'alt')); }
        else { try{ t=txt(n.innerText!=null?n.innerText:n.textContent); }catch(e){ t=''; } }
        if(!t) continue;
        var low=t.toLowerCase();
        if(nameLow&&low===nameLow) continue;       // skip the control's own label
        if(sectionLow&&low===sectionLow) continue; // avoid echoing the section
        if(seen[low]) continue; seen[low]=1;
        if(t.length>80) t=clip(t,80);
        if(tg==='a'||isHeading(n)) strong=true;
        parts.push(t); total+=t.length+1;
        if(parts.length>=6||total>=CTX_NEARBY_MAX) break;
      }
      return {text:clip(parts.join(' '),CTX_NEARBY_MAX),fromLinkOrHeading:strong};
    }
    // Walk ancestors and return the first one whose harvested text is non-empty.
    // Empty wrapper levels (e.g. a tiny button container) are skipped so a
    // generic button still picks up its sibling product link / title text. The
    // walk STOPS before entering a page-level region (one with too many
    // matches), so a control never inherits unrelated page-wide text such as
    // the product H1 from a sibling header.
    function harvestLabel(el,nameLow,sectionLow){
      var node=el.parentElement, depth=0;
      while(node&&depth<CTX_WALK_DEPTH){
        var ns=harvestNodes(node);
        if(ns&&ns.length>0){
          if(ns.length>14) return {text:'',fromLinkOrHeading:false}; // page region, not an item card — stop
          var r=harvestFrom(ns,nameLow,sectionLow);
          if(r.text) return r;
        }
        node=node.parentElement; depth++;
      }
      return {text:'',fromLinkOrHeading:false};
    }
    function priceMatch(s){
      try{ var m=String(s).slice(0,400).match(/[$£€]\\s?\\d[\\d.,]*/); return m?txt(m[0]):''; }catch(e){ return ''; }
    }
    // A nearby price from the control's own ancestor chain (e.g. a purchase
    // panel or product card). Bounded scan of a few ancestors.
    function findPriceNear(el){
      var node=el.parentElement, depth=0;
      while(node&&depth<4){
        var t=''; try{ t=(node.innerText!=null?node.innerText:node.textContent); }catch(e){ t=''; }
        var p=priceMatch(t); if(p) return clip(p,16);
        node=node.parentElement; depth++;
      }
      return '';
    }
    // Main-product fallback: the nearest page H1 plus a short following
    // subtitle. Generic for ecommerce product pages; not site-specific.
    function pageProductHeader(){
      var h1=null; try{ h1=document.querySelector('h1'); }catch(e){ h1=null; }
      if(!h1) return '';
      var parts=[];
      var title=''; try{ title=txt(h1.innerText!=null?h1.innerText:h1.textContent); }catch(e){ title=''; }
      if(title) parts.push(clip(title,100));
      var sib=h1.nextElementSibling, scan=0;
      while(sib&&scan<3){
        var st=''; try{ st=txt(sib.innerText!=null?sib.innerText:sib.textContent); }catch(e){ st=''; }
        if(st&&st.length<=80&&!isHeading(sib)){ parts.push(st); break; }
        sib=sib.nextElementSibling; scan++;
      }
      return clip(txt(parts.join(' ')),CTX_NEARBY_MAX);
    }
    // Page product header is computed at most once per snapshot (memoized).
    var _pageHeader;
    function pageHeaderMemo(){
      if(_pageHeader===undefined){ try{ _pageHeader=pageProductHeader()||''; }catch(e){ _pageHeader=''; } }
      return _pageHeader;
    }
    // A generic add-to-cart/bag/basket control. No brand/site strings; the
    // source intentionally avoids the literal phrase the brand-string test
    // forbids. \\badd\\b avoids matching "address".
    function isAddToCartName(n){ return /\\badd\\b[\\s\\S]{0,12}\\b(cart|bag|basket)\\b/.test(n); }
    // Clearly unrelated regions (cookie/nav/footer/modal/legal) block the
    // main-product fallback — by section keyword or by a structural landmark
    // ancestor. Bounded ancestor walk.
    function isUnrelatedRegion(el,sectionLow){
      if(sectionLow&&/cookie|consent|nav|navigation|menu|footer|modal|dialog|legal|privacy|terms|newsletter|subscribe/.test(sectionLow)) return true;
      var node=el, depth=0;
      while(node&&depth<CTX_WALK_DEPTH){
        var tg=(node.tagName||'').toLowerCase();
        if(tg==='nav'||tg==='footer') return true;
        var role=attr(node,'role');
        if(role){ role=String(role).toLowerCase(); if(role==='navigation'||role==='dialog'||role==='banner'||role==='contentinfo'||role==='menu') return true; }
        node=node.parentElement; depth++;
      }
      return false;
    }
    function extractContext(el,name){
      var nameLow=name?txt(name).toLowerCase():'';
      var sec=findSection(el);
      var section=sec.text;
      var sectionLow=section?section.toLowerCase():'';
      var hv=harvestLabel(el,nameLow,sectionLow);
      var raw=hv.text;
      // Main-product fallback: adopt the page product header when there is no
      // card-local context at all, or when a generic add-to-cart/bag/basket
      // control sits in a shallow neutral wrapper whose local text is blank or
      // weak (not a product link/heading and carrying no price). A real heading
      // sub-section ("Complete with") and clearly unrelated regions
      // (cookie/nav/footer/modal/legal) keep their own identity and block the
      // fallback; a tiny neutral wrapper aria-label ("Purchase options") does not.
      var unrelated=isUnrelatedRegion(el,sectionLow);
      var isPurchase=isAddToCartName(nameLow);
      var weak=!raw||(!priceMatch(raw)&&!hv.fromLinkOrHeading);
      if(!unrelated&&!sec.fromHeading&&((!raw&&!section)||(isPurchase&&weak))){ var ph=pageHeaderMemo(); if(ph) raw=ph; }
      var price=findPriceNear(el);
      if(raw&&price&&raw.indexOf(price)<0){ raw=clip(raw+' '+price,CTX_NEARBY_MAX); }
      else if(!raw&&price){ raw=price; }
      var ctx={};
      var label=clip(raw,CTX_LABEL_MAX);
      if(label) ctx.label=label;
      if(section) ctx.section=section;
      if(raw) ctx.nearby_text=raw;
      return (ctx.label||ctx.section||ctx.nearby_text)?ctx:null;
    }
    ${buildOverlaySnippetJs(isHumanVerificationEnabled())}
    var out=[];
    var nodes;
    try{ nodes=document.querySelectorAll(SELECTOR); }catch(e){ return []; }
    nodes=Array.prototype.slice.call(nodes);
    for(var k=0;k<nodes.length&&out.length<MAX;k++){
      var el=nodes[k];
      if(!el) continue;
      var tag=(el.tagName||'').toLowerCase();
      var rawType=attr(el,'type');
      var type=rawType?String(rawType).toLowerCase():(tag==='input'?'text':null);
      // Never extract hidden inputs — they carry no interactive surface and
      // their values must never be read.
      if(tag==='input'&&type==='hidden') continue;
      var r=rectOf(el);
      if(!r) continue;
      var contentEditable=false;
      try{ contentEditable=(el.isContentEditable===true)||(attr(el,'contenteditable')==='true'); }catch(e){ contentEditable=false; }
      var theName=nameOf(el,tag,type);
      var ctx=null; try{ ctx=extractContext(el,theName); }catch(e){ ctx=null; }
      var vmeta=null; try{ vmeta=valueMetaOf(el,tag,type,contentEditable); }catch(e){ vmeta=null; }
      var ovl=null; try{ ovl=computeOverlay(el,theName); }catch(e){ ovl=null; }
      out.push({
        tag: tag,
        type: type,
        role: attr(el,'role'),
        content_editable: contentEditable,
        id: attr(el,'id'),
        href: attr(el,'href'),
        disabled: el.disabled===true,
        aria_disabled: attr(el,'aria-disabled')==='true',
        read_only: el.readOnly===true,
        name: theName,
        box: { x:r.left, y:r.top, width:r.width, height:r.height, doc_x:r.left+SX, doc_y:r.top+SY },
        context: ctx,
        value_meta: vmeta,
        overlay: ovl
      });
    }
    return out;
  })()`;
}

// ─── CDP transport ───────────────────────────────────────────────────────────

/**
 * Connects to a live Chromium page over CDP, evaluates the extraction IIFE, and
 * returns sanitized internal candidate records with their current bounding
 * boxes. Opens its own raw CDP WebSocket and closes it when done — same pattern
 * as realisticClickByDescription / executeSecretInjectionViaCDP.
 *
 * Returns [] for an empty page (no candidates). Throws (with an attached error
 * `code`) on connection/attach/evaluate failures.
 */
export async function extractAntigenSnapshotCandidatesViaCDP(
  params: ExtractAntigenSnapshotCandidatesParams,
): Promise<AntigenSnapshotCandidate[]> {
  const { cdpUrl, resolvedTarget } = params;
  const maxCandidates = params.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const viewportOnly = params.viewportOnly ?? true;
  // Stage timing (dev-only, gated): stage labels + durations + scalar counts only.
  const timing = new BrowserTimingScope("antigen_snapshot_extract");

  // Fast path: the snapshot handler already resolved a single live target (via
  // pickBestPageTarget) and threads it in so DOM extraction binds to the SAME
  // target as page-metadata and the stored URL. Otherwise fall back to this
  // function's own one-shot fetch + pickAntigenPageTarget (legacy behavior).
  let browserWsUrl: string;
  let pageTarget: { id: string; url: string };
  if (resolvedTarget) {
    browserWsUrl = resolvedTarget.browserWsUrl;
    pageTarget = resolvedTarget.pageTarget;
  } else {
    let versionData: { webSocketDebuggerUrl?: string };
    let targets: Array<{ id: string; url: string; type: string }>;
    try {
      [versionData, targets] = await Promise.all([
        fetch(`${cdpUrl}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>),
        fetch(`${cdpUrl}/json/list`).then(
          (r) => r.json() as Promise<Array<{ id: string; url: string; type: string }>>,
        ),
      ]);
    } catch (err) {
      throw Object.assign(new Error(`CDP fetch failed: ${(err as Error).message}`), {
        code: "CDP_FETCH_FAILED",
      });
    }

    const ws = versionData.webSocketDebuggerUrl;
    if (!ws) {
      throw Object.assign(new Error("No browser WebSocket debugger URL from CDP."), {
        code: "CDP_FETCH_FAILED",
      });
    }

    const picked = pickAntigenPageTarget(targets);
    if (!picked) {
      throw Object.assign(new Error("No page targets found via CDP."), {
        code: "NO_PAGE_TARGET",
      });
    }
    browserWsUrl = ws;
    pageTarget = picked;
    timing.mark("target_fallback_fetch");
  }

  const expr = buildAntigenExtractionExpr({ maxCandidates, viewportOnly });

  const raw = await new Promise<RawAntigenCandidate[]>((resolve, reject) => {
    const ws = new WebSocket(browserWsUrl);
    let msgId = 1;
    let cdpSessionId: string | null = null;
    let attachId: number;
    let evalId: number;
    let settled = false;

    const timer = setTimeout(() => {
      fail(Object.assign(new Error("Antigen snapshot extraction timed out after 8 seconds."), {
        code: "CDP_EVALUATE_FAILED",
      }));
    }, 8_000);

    const sendMsg = (method: string, p: Record<string, unknown> = {}, sid?: string): number => {
      const id = msgId++;
      const msg: Record<string, unknown> = { id, method, params: p };
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
      return id;
    };

    const succeed = (records: RawAntigenCandidate[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(records);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      reject(err);
    };

    ws.on("open", () => {
      attachId = sendMsg("Target.attachToTarget", { targetId: pageTarget.id, flatten: true });
    });

    ws.on("error", (err: Error) => {
      fail(Object.assign(new Error(`CDP socket error: ${err.message}`), { code: "CDP_FETCH_FAILED" }));
    });

    ws.on("message", (data: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const id = msg.id as number | undefined;
      if (id === undefined) return; // CDP event notification, no id
      const result = msg.result as Record<string, unknown> | undefined;

      if (id === attachId) {
        if (!result?.sessionId) {
          fail(Object.assign(new Error("CDP attach failed: no sessionId."), { code: "CDP_ATTACH_FAILED" }));
          return;
        }
        cdpSessionId = result.sessionId as string;
        timing.mark("connect_attach");
        evalId = sendMsg("Runtime.evaluate", { expression: expr, returnByValue: true }, cdpSessionId);
        return;
      }

      if (id === evalId) {
        timing.mark("eval_iife");
        const evalResult = result?.result as Record<string, unknown> | undefined;
        const value = evalResult?.value;
        if (!Array.isArray(value)) {
          // Empty page or non-array result → no candidates.
          succeed([]);
          return;
        }
        succeed(value as RawAntigenCandidate[]);
      }
    });
  });

  const mapped = raw.slice(0, maxCandidates).map((rec, i) => mapRawToCandidate(rec, i));
  timing.mark("sanitize_map");
  timing.end({ candidate_count: mapped.length, pre_resolved: !!resolvedTarget, viewport_only: viewportOnly });
  return mapped;
}

// ─── Page-level human-verification WALL (cross-origin iframe challenges) ──────

/**
 * Safe page-level human-verification signal. Emitted for full-page denial walls
 * (e.g. PerimeterX on Bath & Body Works) whose challenge TEXT is in the top
 * document ("Access to this page has been denied", "Press & Hold to confirm you
 * are a human") but whose only interactive control sits inside a SINGLE
 * cross-origin iframe — so ZERO top-document candidates are extracted and every
 * element/candidate-based detector misses it. Enum/booleans ONLY: never iframe
 * src, selectors, geometry, boxes, or raw page text. The control is in a
 * cross-origin iframe the relay cannot target, so this is always a manual
 * completion (page_level: true).
 */
export interface PageHumanVerificationWall {
  human_verification: true;
  hv_challenge_type: HumanVerificationChallengeType;
  user_presence_required: true;
  blocking: true;
  page_level: true;
}

/**
 * Builds the page-level wall probe IIFE. Reuses the shared overlay snippet
 * (HV_TEXT_RE / HV_HOLD_RE / fixedCoverage / txt — single source, zero drift)
 * and adds a page-level scan. SCREEN_HV_ENABLED is threaded from the env flag, so
 * flag-off returns null instantly (byte-identical). The function NEVER traverses
 * or reads the cross-origin iframe: `contentDocument` is only TOUCHED inside
 * try/catch to learn that it is inaccessible.
 *
 * Returns a value-free signal object (booleans + a challenge-type enum), NOT a
 * final verdict. Two classification paths consume it:
 *  - TEXT path (`text_classified`): STRONG HV text in the top document AND an
 *    inaccessible iframe — the original B&BW full-denial / overlay-wall shapes. A
 *    generic "access denied" page with no human/bot/press-hold language never
 *    classifies. Carries `press_and_hold` when hold language is present.
 *  - OOPIF path (decided server-side in detectPageHumanVerificationWallViaCDP):
 *    the challenge renders inside a cross-origin iframe so NO HV text is readable
 *    from the top document. The page emits visible/inaccessible-iframe and
 *    fixed-overlay/click-intercept booleans here; the server ANDs them with an
 *    OOPIF child target (observable only via CDP Target.getTargets). Reported as
 *    `unknown_human_verification` — we must not assert press_and_hold for text we
 *    cannot read.
 */
export function buildPageHumanVerificationWallExpr(): string {
  return `(function(){
    var OVERLAY_TITLE_MAX=120;
    var OVERLAY_WALK_DEPTH=12;
    var OVERLAY_DRAWER_RE=/(drawer|flyout|off-?canvas|side-?panel|slide-?over|snackbar)/i;
    var OVERLAY_DISMISS_RE=/\\b(close|dismiss|no thanks|not now|maybe later)\\b/i;
    var OVERLAY_CHAT_RE=/(chat|messeng|intercom|zendesk|drift|live\\s*help|support\\s*widget|help\\s*widget|chat\\s*widget|launcher)/i;
    function txt(s){ return (s==null?'':String(s)).replace(/\\s+/g,' ').trim(); }
    function clip(s,max){ s=txt(s); return s.length>max?s.slice(0,max):s; }
    function attr(el,n){ try{ return el.getAttribute(n); }catch(e){ return null; } }
    ${buildOverlaySnippetJs(isHumanVerificationEnabled())}
    if(!SCREEN_HV_ENABLED) return null;
    // ── Text-INDEPENDENT overlay/iframe signals (always computed) ─────────────
    // These carry the OOPIF wall case (the live B&BW Press & Hold popup) whose
    // challenge text/button render inside a cross-origin iframe and are therefore
    // NOT readable from the top document. Booleans only; the iframe is never read
    // (contentDocument is only TOUCHED in try/catch to learn it is inaccessible).
    var visibleIframe=false, inaccessibleIframe=false;
    try{
      var frames=document.querySelectorAll('iframe');
      for(var i=0;i<frames.length&&i<20;i++){
        var fr=frames[i],r=null; try{ r=fr.getBoundingClientRect(); }catch(e){}
        if(!r||!(r.width>0&&r.height>0)) continue;
        visibleIframe=true;
        var accessible=false; try{ accessible=!!fr.contentDocument; }catch(e){ accessible=false; }
        if(!accessible){ inaccessibleIframe=true; }
      }
    }catch(e){}
    // Fixed/sticky high-z >=0.5-coverage backdrop among body's top two DOM levels.
    // Reuses fixedCoverage() from the shared snippet — the SAME blocking test the
    // structural path uses (zero drift). Sticky headers / promo heroes fail the
    // >=0.5 coverage + z>=10 test so they never count.
    var fixedOverlay=false;
    try{
      if(document.body){
        var ch=document.body.children;
        for(var k=0;k<ch.length&&k<80&&!fixedOverlay;k++){
          if(fixedCoverage(ch[k])>=0.5){ fixedOverlay=true; break; }
          var gc=ch[k].children;
          for(var g=0;gc&&g<gc.length&&g<24;g++){ if(fixedCoverage(gc[g])>=0.5){ fixedOverlay=true; break; } }
        }
      }
    }catch(e){}
    // Click intercept: the element at the viewport center sits beneath a fixed/
    // sticky high-z >=0.5-coverage overlay ancestor (depth<=8). Reuses
    // fixedCoverage() — no new coverage logic. Never reads .value or the iframe.
    function clickInterceptSeen(){
      try{
        var cx=Math.floor((window.innerWidth||0)/2), cy=Math.floor((window.innerHeight||0)/2);
        if(cx<=0||cy<=0) return false;
        var el=document.elementFromPoint(cx,cy), depth=0;
        while(el&&depth<8){ if(fixedCoverage(el)>=0.5) return true; el=el.parentElement; depth++; }
      }catch(e){}
      return false;
    }
    var clickIntercept=clickInterceptSeen();
    // ── Existing top-document TEXT path (classification UNCHANGED) ────────────
    // STRONG human-verification phrase is the necessary condition; the denial
    // banner alone is never sufficient. Two valid shapes when text IS present:
    //  (a) full-denial wall — wall REPLACES the page (normalInteractive<=3);
    //  (b) overlay wall over a STILL-PRESENT background — requires a full-page
    //      blocker OR strong wall-context text (before-we-continue / reference id
    //      / access denied) so a marketing iframe + stray copy can't classify.
    // An inaccessible iframe is REQUIRED for the text path too.
    var bodyText=''; try{ bodyText=txt(document.body?(document.body.innerText||document.body.textContent||''):'').slice(0,4000); }catch(e){ bodyText=''; }
    var titleText=''; try{ titleText=txt(document.title||''); }catch(e){ titleText=''; }
    var hasHold=HV_HOLD_RE.test(bodyText)||HV_HOLD_RE.test(titleText);
    var textClassified=false;
    if((HV_TEXT_RE.test(bodyText)||HV_TEXT_RE.test(titleText))&&inaccessibleIframe){
      var normalInteractive=0;
      try{
        var ctrls=document.querySelectorAll('button,a[href],input,select,textarea,[role="button"]');
        for(var j=0;j<ctrls.length&&j<200;j++){
          var c=ctrls[j],cr=null; try{ cr=c.getBoundingClientRect(); }catch(e){}
          if(cr&&cr.width>0&&cr.height>0){ normalInteractive++; if(normalInteractive>3) break; }
        }
      }catch(e){}
      if(normalInteractive>3){
        var HV_WALL_CTX_RE=/before\\s+we\\s+continue|reference\\s+id|access\\s+(to\\s+this\\s+page\\s+)?(is\\s+|has\\s+been\\s+)?denied/i;
        var hasSupportText=HV_WALL_CTX_RE.test(bodyText)||HV_WALL_CTX_RE.test(titleText);
        textClassified=(fixedOverlay||hasSupportText);
      } else {
        textClassified=true;
      }
    }
    // Booleans/enum only. The OOPIF corroborating decision (which also requires an
    // OOPIF child target, observable ONLY via CDP) is made server-side in
    // detectPageHumanVerificationWallViaCDP — never here.
    return {
      text_classified:!!textClassified,
      hv_challenge_type:hasHold?'press_and_hold':'unknown_human_verification',
      visible_iframe_seen:!!visibleIframe,
      inaccessible_iframe_seen:!!inaccessibleIframe,
      fixed_overlay_seen:!!fixedOverlay,
      click_intercept_overlay_seen:!!clickIntercept
    };
  })()`;
}

/**
 * Browser-wide OOPIF / child-target presence from a CDP `Target.getTargets`
 * `targetInfos` array. An out-of-process (cross-origin) iframe gets its own CDP
 * target of type `iframe` (or `webview`); same-process subframes do not appear
 * here. Booleans only — never returns targetId/url/title.
 *
 * SCOPING NOTE (v1): this is browser-wide, not scoped to the page's frame tree.
 * That is acceptable because the OOPIF flag is CORROBORATING-ONLY: the OOPIF wall
 * classification additionally requires the page-scoped in-page signals (a visible
 * inaccessible iframe AND a blocking overlay/click-intercept), so a stray OOPIF in
 * another tab can never classify a page on its own.
 */
export function hasOopifChildTarget(targetInfos: unknown): boolean {
  if (!Array.isArray(targetInfos)) return false;
  for (const t of targetInfos) {
    const type = (t as { type?: unknown } | null)?.type;
    if (type === "iframe" || type === "webview") return true;
  }
  return false;
}

/**
 * Pure classification of the page-wall probe value + the CDP-only OOPIF flag into
 * a final verdict. Extracted so the dual-path decision is unit-testable without a
 * browser. Returns null unless a path matches.
 *
 * - TEXT path: `text_classified` (strong top-document HV text + inaccessible
 *   iframe, computed in the page IIFE). Honors the page's challenge-type enum
 *   (e.g. press_and_hold).
 * - OOPIF path: STRICT, text-independent —
 *   `visible_iframe_seen && inaccessible_iframe_seen && oopifTargetSeen &&
 *    (fixed_overlay_seen || click_intercept_overlay_seen)`. The OOPIF flag is
 *   corroborating-only and can never classify on its own. Reported as
 *   `unknown_human_verification` (the challenge text is unreadable).
 */
export function classifyPageWallSignals(
  value: unknown,
  oopifTargetSeen: boolean,
): PageHumanVerificationWall | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;

  if (v.text_classified === true) {
    const ct: HumanVerificationChallengeType =
      v.hv_challenge_type === "press_and_hold" ? "press_and_hold" : "unknown_human_verification";
    return {
      human_verification: true,
      hv_challenge_type: ct,
      user_presence_required: true,
      blocking: true,
      page_level: true,
    };
  }

  const visibleIframe = v.visible_iframe_seen === true;
  const inaccessibleIframe = v.inaccessible_iframe_seen === true;
  const blockingOverlay = v.fixed_overlay_seen === true || v.click_intercept_overlay_seen === true;
  if (visibleIframe && inaccessibleIframe && oopifTargetSeen === true && blockingOverlay) {
    return {
      human_verification: true,
      hv_challenge_type: "unknown_human_verification",
      user_presence_required: true,
      blocking: true,
      page_level: true,
    };
  }
  return null;
}

/**
 * Connects to the live page over CDP and evaluates the page-level wall probe.
 * Best-effort and fail-safe: returns null on any transport/parse error or when
 * no resolved target is available — it must NEVER throw into the snapshot path.
 * The result carries enum/booleans only; no iframe internals are read.
 *
 * On the SAME browser WS, a browser-level `Target.getTargets` runs before the
 * page attach to learn whether an OOPIF child target exists (the text-independent
 * corroborating signal for the cross-origin-iframe HV wall).
 */
export async function detectPageHumanVerificationWallViaCDP(params: {
  cdpUrl: string;
  resolvedTarget?: { browserWsUrl: string; pageTarget: { id: string; url: string } };
}): Promise<PageHumanVerificationWall | null> {
  const { resolvedTarget } = params;
  if (!resolvedTarget) return null;
  const expr = buildPageHumanVerificationWallExpr();

  let probe: { value: unknown; oopifTargetSeen: boolean };
  try {
    probe = await new Promise<{ value: unknown; oopifTargetSeen: boolean }>((resolve, reject) => {
      const ws = new WebSocket(resolvedTarget.browserWsUrl);
      let msgId = 1;
      let getTargetsId: number;
      let attachId: number;
      let evalId: number;
      let settled = false;
      let sid: string | null = null;
      let oopifTargetSeen = false;
      const timer = setTimeout(() => fail(new Error("Page-level HV wall probe timed out.")), 6_000);
      const send = (method: string, p: Record<string, unknown>, s?: string): number => {
        const id = msgId++;
        const m: Record<string, unknown> = { id, method, params: p };
        if (s) m.sessionId = s;
        ws.send(JSON.stringify(m));
        return id;
      };
      const done = (v: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.close();
        resolve({ value: v, oopifTargetSeen });
      };
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(e);
      };
      ws.on("open", () => {
        // Browser-level command — no sessionId. Enumerate child targets first so
        // the OOPIF corroborating signal is known before classification.
        getTargetsId = send("Target.getTargets", {});
      });
      ws.on("error", (e: Error) => fail(e));
      ws.on("message", (data: Buffer | string) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const id = msg.id as number | undefined;
        if (id === undefined) return;
        const result = msg.result as Record<string, unknown> | undefined;
        if (id === getTargetsId) {
          oopifTargetSeen = hasOopifChildTarget(result?.targetInfos);
          attachId = send("Target.attachToTarget", { targetId: resolvedTarget.pageTarget.id, flatten: true });
          return;
        }
        if (id === attachId) {
          if (!result?.sessionId) {
            fail(new Error("CDP attach failed: no sessionId."));
            return;
          }
          sid = result.sessionId as string;
          evalId = send("Runtime.evaluate", { expression: expr, returnByValue: true }, sid);
          return;
        }
        if (id === evalId) {
          const evalResult = result?.result as Record<string, unknown> | undefined;
          done(evalResult?.value);
        }
      });
    });
  } catch {
    return null;
  }

  const { value, oopifTargetSeen } = probe;
  // Dual-path classification (TEXT path / corroborating OOPIF path) — pure and
  // unit-tested in classifyPageWallSignals. Never trusts the raw page value
  // blindly: the enum and every term are re-validated there.
  return classifyPageWallSignals(value, oopifTargetSeen);
}

/**
 * Builds the CHEAP page-level human-verification *hint* IIFE evaluated on the
 * already-open snapshot session. It returns `{ hint: boolean }` and is the
 * latency-cheap precheck that decides whether the (separate-connection) full
 * `detectPageHumanVerificationWallViaCDP` confirming probe is worth running on
 * a snapshot whose background DOM is preserved (the overlay-wall shape, where
 * element_count is high and the low-element fast path would otherwise skip the
 * probe). Deliberately conservative — it gates the probe via either NECESSARY
 * wall shape:
 *  - TEXT shape: strong HV text (shared HV_TEXT_RE, zero drift) AND a visible
 *    inaccessible iframe; OR
 *  - OOPIF shape: a visible inaccessible iframe AND a blocking overlay
 *    (fixedCoverage>=0.5 backdrop OR center click-intercept) — NO text required,
 *    so the cross-origin-iframe wall (whose text is unreadable) still gates the
 *    probe. A normal marketing iframe with no blocking overlay does NOT (it lacks
 *    the >=0.5-coverage fixed/sticky high-z backdrop), so clean pages still pay no
 *    extra round-trip.
 * It NEVER reads the cross-origin iframe (contentDocument is only TOUCHED in
 * try/catch to learn it is inaccessible), returns booleans only, and is
 * byte-identical when the flag is off (SCREEN_HV_ENABLED early-return). The full
 * probe (which also requires an OOPIF child target for the OOPIF shape) remains
 * the strict authority — a true hint only gates whether it runs, never what it
 * decides.
 */
export function buildPageHvWallHintExpr(): string {
  return `(function(){
    var OVERLAY_TITLE_MAX=120;
    var OVERLAY_WALK_DEPTH=12;
    var OVERLAY_DRAWER_RE=/(drawer|flyout|off-?canvas|side-?panel|slide-?over|snackbar)/i;
    var OVERLAY_DISMISS_RE=/\\b(close|dismiss|no thanks|not now|maybe later)\\b/i;
    var OVERLAY_CHAT_RE=/(chat|messeng|intercom|zendesk|drift|live\\s*help|support\\s*widget|help\\s*widget|chat\\s*widget|launcher)/i;
    function txt(s){ return (s==null?'':String(s)).replace(/\\s+/g,' ').trim(); }
    function clip(s,max){ s=txt(s); return s.length>max?s.slice(0,max):s; }
    function attr(el,n){ try{ return el.getAttribute(n); }catch(e){ return null; } }
    ${buildOverlaySnippetJs(isHumanVerificationEnabled())}
    if(!SCREEN_HV_ENABLED) return { hint:false };
    // A visible inaccessible iframe is REQUIRED for both shapes.
    var hasInaccessibleIframe=false;
    try{
      var frames=document.querySelectorAll('iframe');
      for(var i=0;i<frames.length&&i<20;i++){
        var fr=frames[i],r=null; try{ r=fr.getBoundingClientRect(); }catch(e){}
        if(!r||!(r.width>0&&r.height>0)) continue;
        var accessible=false; try{ accessible=!!fr.contentDocument; }catch(e){ accessible=false; }
        if(!accessible){ hasInaccessibleIframe=true; break; }
      }
    }catch(e){}
    if(!hasInaccessibleIframe) return { hint:false };
    // TEXT shape: strong HV text in the top document.
    var bodyText=''; try{ bodyText=txt(document.body?(document.body.innerText||document.body.textContent||''):'').slice(0,4000); }catch(e){ bodyText=''; }
    var titleText=''; try{ titleText=txt(document.title||''); }catch(e){ titleText=''; }
    if(HV_TEXT_RE.test(bodyText)||HV_TEXT_RE.test(titleText)) return { hint:true };
    // OOPIF shape: a blocking overlay (fixed >=0.5-coverage backdrop OR center
    // click-intercept), text-independent. Reuses fixedCoverage() — zero drift.
    var fixedOverlay=false;
    try{
      if(document.body){
        var ch=document.body.children;
        for(var k=0;k<ch.length&&k<80&&!fixedOverlay;k++){
          if(fixedCoverage(ch[k])>=0.5){ fixedOverlay=true; break; }
          var gc=ch[k].children;
          for(var g=0;gc&&g<gc.length&&g<24;g++){ if(fixedCoverage(gc[g])>=0.5){ fixedOverlay=true; break; } }
        }
      }
    }catch(e){}
    var clickIntercept=false;
    try{
      var cx=Math.floor((window.innerWidth||0)/2), cy=Math.floor((window.innerHeight||0)/2);
      if(cx>0&&cy>0){
        var el=document.elementFromPoint(cx,cy), depth=0;
        while(el&&depth<8){ if(fixedCoverage(el)>=0.5){ clickIntercept=true; break; } el=el.parentElement; depth++; }
      }
    }catch(e){}
    return { hint: !!(fixedOverlay||clickIntercept) };
  })()`;
}

// ─── Page-level HV wall DEBUG telemetry (ANTIGEN_HV_DEBUG, dev-only) ──────────
//
// Strictly diagnostic. Unlike the production probe (buildPageHumanVerificationWallExpr)
// this NEVER early-returns: it computes every wall signal so the snapshot debug
// object can reveal exactly which condition failed on a live wall. It reuses the
// SAME shared overlay-snippet primitives (HV_TEXT_RE / HV_HOLD_RE / fixedCoverage
// / txt) so its booleans cannot drift from production. It emits booleans, enums,
// and buckets ONLY — never raw title/body text, iframe src, selectors, geometry,
// refs, cookies, storage, or HTML. It does NOT influence response classification.

/** Coarse iframe-count bucket — never the raw count. */
export type IframeCountBucket = "zero" | "one" | "few" | "many";

/** Enumerated CDP/eval failure point for the debug probe (never raw error text). */
export type PageHvWallDebugErrorCode =
  | "cdp_connect_failed"
  | "target_attach_failed"
  | "runtime_eval_failed"
  | "invalid_result"
  | "unknown";

/** Granular, value-free signals from the debug page-eval probe. */
export interface PageHvWallDebugSignals {
  top_doc_title_flags: { access_denied_title: boolean };
  top_doc_text_flags: {
    hv_text_seen: boolean;
    press_hold_seen: boolean;
    before_continue_seen: boolean;
    not_bot_seen: boolean;
    reference_id_phrase_seen: boolean;
  };
  iframe_flags: {
    iframe_count_bucket: IframeCountBucket;
    visible_iframe_seen: boolean;
    inaccessible_iframe_seen: boolean;
  };
  blocker_flags: { full_page_blocker_seen: boolean; support_text_seen: boolean };
  /** Text-independent OOPIF-path blocking-overlay signals. */
  overlay_intercept_flags: { fixed_overlay_seen: boolean; click_intercept_overlay_seen: boolean };
  /** OOPIF / child-target presence (from CDP Target.getTargets, browser-wide). */
  oopif_flags: { oopif_target_seen: boolean };
  /** Mirrors the EXACT production TEXT-path wall decision from the same signals. */
  would_classify: boolean;
  /**
   * Mirrors the EXACT production OOPIF-path decision: visible_iframe_seen &&
   * inaccessible_iframe_seen && oopif_target_seen && (fixed_overlay_seen ||
   * click_intercept_overlay_seen). Lets a live ANTIGEN_HV_DEBUG run confirm the
   * cross-origin-iframe wall path on the real page.
   */
  would_classify_oopif: boolean;
}

/** Result of the debug probe CDP run — discriminated by the connection outcome. */
export type PageHvWallDebugResult =
  | { result: "positive" | "null"; signals: PageHvWallDebugSignals }
  | { result: "error"; error_code: PageHvWallDebugErrorCode };

/**
 * Builds the DEBUG page-eval IIFE. Computes every wall signal without early
 * return and derives `would_classify` using the identical condition chain as
 * buildPageHumanVerificationWallExpr (strong HV text AND a visible inaccessible
 * iframe AND (normalInteractive<=3 OR full-page blocker OR support text)). Raw
 * JS string (no DOM lib / TS arrows). Returns booleans/enums/buckets only.
 */
export function buildPageHvWallDebugExpr(): string {
  return `(function(){
    var OVERLAY_TITLE_MAX=120;
    var OVERLAY_WALK_DEPTH=12;
    var OVERLAY_DRAWER_RE=/(drawer|flyout|off-?canvas|side-?panel|slide-?over|snackbar)/i;
    var OVERLAY_DISMISS_RE=/\\b(close|dismiss|no thanks|not now|maybe later)\\b/i;
    var OVERLAY_CHAT_RE=/(chat|messeng|intercom|zendesk|drift|live\\s*help|support\\s*widget|help\\s*widget|chat\\s*widget|launcher)/i;
    function txt(s){ return (s==null?'':String(s)).replace(/\\s+/g,' ').trim(); }
    function clip(s,max){ s=txt(s); return s.length>max?s.slice(0,max):s; }
    function attr(el,n){ try{ return el.getAttribute(n); }catch(e){ return null; } }
    ${buildOverlaySnippetJs(isHumanVerificationEnabled())}
    // bodyText/titleText are read ONLY to test regexes; their content never leaves.
    var bodyText=''; try{ bodyText=txt(document.body?(document.body.innerText||document.body.textContent||''):'').slice(0,4000); }catch(e){ bodyText=''; }
    var titleText=''; try{ titleText=txt(document.title||''); }catch(e){ titleText=''; }
    var HV_WALL_CTX_RE=/before\\s+we\\s+continue|reference\\s+id|access\\s+(to\\s+this\\s+page\\s+)?(is\\s+|has\\s+been\\s+)?denied/i;
    var ACCESS_DENIED_RE=/access\\s+(to\\s+this\\s+page\\s+)?(is\\s+|has\\s+been\\s+)?denied/i;
    var BEFORE_CONTINUE_RE=/before\\s+we\\s+continue/i;
    var NOT_BOT_RE=/not\\s+a\\s+(ro)?bot|i\\s*['\\u2019]?\\s*m\\s+not\\s+a\\s+robot/i;
    var REF_ID_RE=/reference\\s+id/i;
    var hvTextSeen=HV_TEXT_RE.test(bodyText)||HV_TEXT_RE.test(titleText);
    var pressHoldSeen=HV_HOLD_RE.test(bodyText)||HV_HOLD_RE.test(titleText);
    var beforeContinueSeen=BEFORE_CONTINUE_RE.test(bodyText)||BEFORE_CONTINUE_RE.test(titleText);
    var notBotSeen=NOT_BOT_RE.test(bodyText)||NOT_BOT_RE.test(titleText);
    var refIdSeen=REF_ID_RE.test(bodyText)||REF_ID_RE.test(titleText);
    var accessDeniedTitle=ACCESS_DENIED_RE.test(titleText);
    var supportTextSeen=HV_WALL_CTX_RE.test(bodyText)||HV_WALL_CTX_RE.test(titleText);
    // Iframe scan — counts/visibility/inaccessibility only; contentDocument is
    // only TOUCHED in try/catch to learn it is opaque. src is NEVER read.
    var iframeCount=0,visibleIframe=false,inaccessibleIframe=false;
    try{
      var frames=document.querySelectorAll('iframe');
      iframeCount=frames.length;
      for(var i=0;i<frames.length&&i<20;i++){
        var fr=frames[i],r=null; try{ r=fr.getBoundingClientRect(); }catch(e){}
        if(!r||!(r.width>0&&r.height>0)) continue;
        visibleIframe=true;
        var accessible=false; try{ accessible=!!fr.contentDocument; }catch(e){ accessible=false; }
        if(!accessible){ inaccessibleIframe=true; }
      }
    }catch(e){}
    var bucket = iframeCount===0?'zero':(iframeCount===1?'one':(iframeCount<=4?'few':'many'));
    // Normal top-document interactive controls (same bounded scan as production).
    var normalInteractive=0;
    try{
      var ctrls=document.querySelectorAll('button,a[href],input,select,textarea,[role="button"]');
      for(var j=0;j<ctrls.length&&j<200;j++){
        var c=ctrls[j],cr=null; try{ cr=c.getBoundingClientRect(); }catch(e){}
        if(cr&&cr.width>0&&cr.height>0){ normalInteractive++; if(normalInteractive>3) break; }
      }
    }catch(e){}
    var fullPageBlocker=false;
    try{
      if(document.body){
        var ch=document.body.children;
        for(var k=0;k<ch.length&&k<80&&!fullPageBlocker;k++){
          if(fixedCoverage(ch[k])>=0.5){ fullPageBlocker=true; break; }
          var gc=ch[k].children;
          for(var g=0;gc&&g<gc.length&&g<24;g++){ if(fixedCoverage(gc[g])>=0.5){ fullPageBlocker=true; break; } }
        }
      }
    }catch(e){}
    // Center click-intercept (text-independent OOPIF signal). Reuses fixedCoverage().
    var clickIntercept=false;
    try{
      var cx=Math.floor((window.innerWidth||0)/2), cy=Math.floor((window.innerHeight||0)/2);
      if(cx>0&&cy>0){
        var iel=document.elementFromPoint(cx,cy), idepth=0;
        while(iel&&idepth<8){ if(fixedCoverage(iel)>=0.5){ clickIntercept=true; break; } iel=iel.parentElement; idepth++; }
      }
    }catch(e){}
    var hasHold=pressHoldSeen;
    // would_classify mirrors buildPageHumanVerificationWallExpr's TEXT path EXACTLY:
    // strong HV text AND a visible inaccessible iframe AND (background replaced
    // (<=3 controls) OR a full-page blocker OR strong wall-context support text).
    var wouldClassify=false;
    if(hvTextSeen&&inaccessibleIframe){
      if(normalInteractive>3){ wouldClassify=(fullPageBlocker||supportTextSeen); }
      else { wouldClassify=true; }
    }
    // Page-portion of the OOPIF path (the OOPIF child-target term is ANDed
    // server-side in collectPageHvWallDebugViaCDP, the only place that can see it).
    var oopifPageCondition=!!(visibleIframe&&inaccessibleIframe&&(fullPageBlocker||clickIntercept));
    return {
      top_doc_title_flags:{ access_denied_title:!!accessDeniedTitle },
      top_doc_text_flags:{ hv_text_seen:!!hvTextSeen, press_hold_seen:!!pressHoldSeen, before_continue_seen:!!beforeContinueSeen, not_bot_seen:!!notBotSeen, reference_id_phrase_seen:!!refIdSeen },
      iframe_flags:{ iframe_count_bucket:bucket, visible_iframe_seen:!!visibleIframe, inaccessible_iframe_seen:!!inaccessibleIframe },
      blocker_flags:{ full_page_blocker_seen:!!fullPageBlocker, support_text_seen:!!supportTextSeen },
      overlay_intercept_flags:{ fixed_overlay_seen:!!fullPageBlocker, click_intercept_overlay_seen:!!clickIntercept },
      oopif_page_condition:oopifPageCondition,
      would_classify:!!wouldClassify,
      hv_challenge_type:hasHold?'press_and_hold':'unknown_human_verification'
    };
  })()`;
}

/**
 * Coerces the raw page value into a strict, value-free signal object.
 * `oopifTargetSeen` is supplied by the caller (it can only be learned via CDP
 * Target.getTargets, never from the page) and is ANDed with the page-portion
 * OOPIF condition to compute `would_classify_oopif`.
 */
function sanitizePageHvWallDebugSignals(
  value: unknown,
  oopifTargetSeen = false,
): PageHvWallDebugSignals | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const t = v.top_doc_title_flags as Record<string, unknown> | undefined;
  const x = v.top_doc_text_flags as Record<string, unknown> | undefined;
  const f = v.iframe_flags as Record<string, unknown> | undefined;
  const b = v.blocker_flags as Record<string, unknown> | undefined;
  const oi = v.overlay_intercept_flags as Record<string, unknown> | undefined;
  if (!t || !x || !f || !b || !oi) return null;
  const bucketRaw = f.iframe_count_bucket;
  const bucket: IframeCountBucket =
    bucketRaw === "zero" || bucketRaw === "one" || bucketRaw === "few" || bucketRaw === "many"
      ? bucketRaw
      : "zero";
  return {
    top_doc_title_flags: { access_denied_title: t.access_denied_title === true },
    top_doc_text_flags: {
      hv_text_seen: x.hv_text_seen === true,
      press_hold_seen: x.press_hold_seen === true,
      before_continue_seen: x.before_continue_seen === true,
      not_bot_seen: x.not_bot_seen === true,
      reference_id_phrase_seen: x.reference_id_phrase_seen === true,
    },
    iframe_flags: {
      iframe_count_bucket: bucket,
      visible_iframe_seen: f.visible_iframe_seen === true,
      inaccessible_iframe_seen: f.inaccessible_iframe_seen === true,
    },
    blocker_flags: {
      full_page_blocker_seen: b.full_page_blocker_seen === true,
      support_text_seen: b.support_text_seen === true,
    },
    overlay_intercept_flags: {
      fixed_overlay_seen: oi.fixed_overlay_seen === true,
      click_intercept_overlay_seen: oi.click_intercept_overlay_seen === true,
    },
    oopif_flags: { oopif_target_seen: oopifTargetSeen === true },
    would_classify: v.would_classify === true,
    would_classify_oopif: v.oopif_page_condition === true && oopifTargetSeen === true,
  };
}

/**
 * DEBUG-ONLY: connects to the live page over CDP and evaluates the debug probe,
 * surfacing the failure point (instead of swallowing it like the production
 * probe) via an enumerated error code. Booleans/enums/buckets only. Never reads
 * iframe internals. Best-effort: any unexpected condition resolves to a typed
 * error result rather than throwing into the snapshot path. Purely diagnostic —
 * the caller MUST NOT let this influence response classification.
 */
export async function collectPageHvWallDebugViaCDP(params: {
  resolvedTarget?: { browserWsUrl: string; pageTarget: { id: string; url: string } };
}): Promise<PageHvWallDebugResult> {
  const { resolvedTarget } = params;
  if (!resolvedTarget) return { result: "error", error_code: "cdp_connect_failed" };
  const expr = buildPageHvWallDebugExpr();

  let outcome: PageHvWallDebugResult;
  try {
    outcome = await new Promise<PageHvWallDebugResult>((resolve) => {
      const ws = new WebSocket(resolvedTarget.browserWsUrl);
      let msgId = 1;
      let getTargetsId: number;
      let attachId: number;
      let evalId: number;
      let settled = false;
      let sid: string | null = null;
      let oopifTargetSeen = false;
      const timer = setTimeout(() => finish({ result: "error", error_code: "unknown" }), 6_000);
      const send = (method: string, p: Record<string, unknown>, s?: string): number => {
        const id = msgId++;
        const m: Record<string, unknown> = { id, method, params: p };
        if (s) m.sessionId = s;
        ws.send(JSON.stringify(m));
        return id;
      };
      const finish = (r: PageHvWallDebugResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve(r);
      };
      ws.on("open", () => {
        // Browser-level — no sessionId. Learn the OOPIF child-target signal first.
        getTargetsId = send("Target.getTargets", {});
      });
      ws.on("error", () => finish({ result: "error", error_code: "cdp_connect_failed" }));
      ws.on("message", (data: Buffer | string) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const id = msg.id as number | undefined;
        if (id === undefined) return;
        const result = msg.result as Record<string, unknown> | undefined;
        if (id === getTargetsId) {
          oopifTargetSeen = hasOopifChildTarget(result?.targetInfos);
          attachId = send("Target.attachToTarget", { targetId: resolvedTarget.pageTarget.id, flatten: true });
          return;
        }
        if (id === attachId) {
          if (!result?.sessionId) {
            finish({ result: "error", error_code: "target_attach_failed" });
            return;
          }
          sid = result.sessionId as string;
          evalId = send("Runtime.evaluate", { expression: expr, returnByValue: true }, sid);
          return;
        }
        if (id === evalId) {
          if (msg.error || (result as Record<string, unknown> | undefined)?.exceptionDetails) {
            finish({ result: "error", error_code: "runtime_eval_failed" });
            return;
          }
          const evalResult = result?.result as Record<string, unknown> | undefined;
          const signals = sanitizePageHvWallDebugSignals(evalResult?.value, oopifTargetSeen);
          if (!signals) {
            finish({ result: "error", error_code: "invalid_result" });
            return;
          }
          finish({
            result: signals.would_classify || signals.would_classify_oopif ? "positive" : "null",
            signals,
          });
        }
      });
    });
  } catch {
    return { result: "error", error_code: "unknown" };
  }
  return outcome;
}

/** Orchestration-level reason the production page-wall probe ran (or didn't). */
export type PageWallProbeReason =
  | "hv_wall_hint"
  | "low_element_count"
  | "skipped_hv_member"
  | "skipped_clean";

/** Production page-wall probe outcome (NOT the debug probe's result). */
export type PageWallProbeResult = "positive" | "null" | "not_attempted";

/**
 * The safe, dev-only debug object attached to antigen_snapshot responses when
 * BOTH ANTIGEN_HUMAN_VERIFICATION and ANTIGEN_HV_DEBUG are on. Booleans, enums,
 * and buckets only. `page_wall_probe_result` reflects the PRODUCTION probe; the
 * granular `*_flags` and `page_wall_probe_error_code` come from the separate
 * debug probe and never affect classification.
 */
export interface HumanVerificationDebug {
  hv_enabled: boolean;
  elements_count: number;
  hv_member_found: boolean;
  hv_wall_hint: boolean;
  page_wall_probe_considered: boolean;
  page_wall_probe_attempted: boolean;
  page_wall_probe_reason: PageWallProbeReason;
  page_wall_probe_result: PageWallProbeResult;
  page_wall_probe_error_code?: PageHvWallDebugErrorCode;
  top_doc_title_flags?: PageHvWallDebugSignals["top_doc_title_flags"];
  top_doc_text_flags?: PageHvWallDebugSignals["top_doc_text_flags"];
  iframe_flags?: PageHvWallDebugSignals["iframe_flags"];
  blocker_flags?: PageHvWallDebugSignals["blocker_flags"];
  overlay_intercept_flags?: PageHvWallDebugSignals["overlay_intercept_flags"];
  oopif_flags?: PageHvWallDebugSignals["oopif_flags"];
  would_classify_oopif?: boolean;
}

// ─── Page metadata extraction (Snapshot v2) ──────────────────────────────────

const PAGE_META_HEADING_MAX = 160;
const PAGE_META_EXCERPT_MAX = 600;

/**
 * Builds the raw JS string IIFE that returns page-level metadata for the Snapshot
 * v2 page map. Separate from the candidate IIFE so candidate extraction (and all
 * its tests) stays unchanged. Reads viewport size, scroll offset, document
 * height, the page H1, and a clipped body innerText excerpt. innerText excludes
 * input/textarea/select VALUES, so no field values or secrets are captured.
 *
 * Returns an AntigenPageMeta-shaped object. Raw JS string (no DOM lib in the
 * Node tsconfig); options interpolated via JSON.stringify.
 */
export function buildAntigenPageMetaExpr(): string {
  const headingMax = JSON.stringify(PAGE_META_HEADING_MAX);
  const excerptMax = JSON.stringify(PAGE_META_EXCERPT_MAX);
  return `(function(){
    var HEADING_MAX=${headingMax};
    var EXCERPT_MAX=${excerptMax};
    function txt(s){ return (s==null?'':String(s)).replace(/\\s+/g,' ').trim(); }
    function clip(s,max){ s=txt(s); return s.length>max?s.slice(0,max):s; }
    var vw=0,vh=0; try{ vw=window.innerWidth||0; vh=window.innerHeight||0; }catch(e){}
    var sx=0,sy=0;
    try{ sx=(window.pageXOffset||(document.documentElement&&document.documentElement.scrollLeft)||0); }catch(e){}
    try{ sy=(window.pageYOffset||(document.documentElement&&document.documentElement.scrollTop)||0); }catch(e){}
    var docH=0; try{ docH=(document.documentElement?document.documentElement.scrollHeight:0)||0; }catch(e){}
    var heading=''; try{ var h1=document.querySelector('h1'); if(h1){ heading=clip(h1.innerText!=null?h1.innerText:h1.textContent,HEADING_MAX); } }catch(e){}
    var excerpt=''; try{ var b=document.body; if(b){ excerpt=clip(b.innerText!=null?b.innerText:b.textContent,EXCERPT_MAX); } }catch(e){}
    return { viewport_w:vw, viewport_h:vh, scroll_x:sx, scroll_y:sy, doc_h:docH, heading:heading, text_excerpt:excerpt };
  })()`;
}

/** Defense-in-depth re-clamp of page meta returned from the page. */
function sanitizePageMeta(raw: unknown): AntigenPageMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const str = (v: unknown, max: number): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.replace(/\s+/g, " ").trim();
    if (!t) return undefined;
    return t.length > max ? t.slice(0, max) : t;
  };
  const out: AntigenPageMeta = {};
  const vw = num(r.viewport_w);
  if (vw !== undefined) out.viewport_w = vw;
  const vh = num(r.viewport_h);
  if (vh !== undefined) out.viewport_h = vh;
  const sx = num(r.scroll_x);
  if (sx !== undefined) out.scroll_x = sx;
  const sy = num(r.scroll_y);
  if (sy !== undefined) out.scroll_y = sy;
  const docH = num(r.doc_h);
  if (docH !== undefined) out.doc_h = docH;
  const heading = str(r.heading, PAGE_META_HEADING_MAX);
  if (heading) out.heading = heading;
  const excerpt = str(r.text_excerpt, PAGE_META_EXCERPT_MAX);
  if (excerpt) out.text_excerpt = excerpt;
  return out;
}

/**
 * Best-effort page metadata over CDP for the Snapshot v2 page map. Mirrors the
 * candidate transport but evaluates the page-meta IIFE. NEVER throws — returns
 * `undefined` on any connection/attach/evaluate failure so page-meta problems
 * never fail a snapshot (candidate extraction is the authoritative path).
 */
export async function extractAntigenPageMetaViaCDP(
  params: { cdpUrl: string; resolvedTarget?: PreResolvedSnapshotTarget },
): Promise<AntigenPageMeta | undefined> {
  const { cdpUrl, resolvedTarget } = params;
  const timing = new BrowserTimingScope("antigen_snapshot_pagemeta");
  try {
    // Bind to the snapshot handler's single resolved target when provided so the
    // page-meta read describes the SAME page as the candidate extraction; else
    // fall back to a self-contained fetch + pick (legacy behavior).
    let browserWsUrl: string | undefined;
    let pageTarget: { id: string; url: string } | undefined;
    if (resolvedTarget) {
      browserWsUrl = resolvedTarget.browserWsUrl;
      pageTarget = resolvedTarget.pageTarget;
    } else {
      const [versionData, targets] = await Promise.all([
        fetch(`${cdpUrl}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>),
        fetch(`${cdpUrl}/json/list`).then(
          (r) => r.json() as Promise<Array<{ id: string; url: string; type: string }>>,
        ),
      ]);
      browserWsUrl = versionData.webSocketDebuggerUrl;
      pageTarget = pickAntigenPageTarget(targets);
    }
    if (!browserWsUrl || !pageTarget) return undefined;

    const expr = buildAntigenPageMetaExpr();

    const raw = await new Promise<unknown>((resolve) => {
      const ws = new WebSocket(browserWsUrl);
      let msgId = 1;
      let attachId: number;
      let evalId: number;
      let settled = false;

      const timer = setTimeout(() => finish(undefined), 8_000);
      const finish = (value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve(value);
      };

      const sendMsg = (method: string, p: Record<string, unknown> = {}, sid?: string): number => {
        const id = msgId++;
        const msg: Record<string, unknown> = { id, method, params: p };
        if (sid) msg.sessionId = sid;
        ws.send(JSON.stringify(msg));
        return id;
      };

      ws.on("open", () => {
        attachId = sendMsg("Target.attachToTarget", { targetId: pageTarget.id, flatten: true });
      });
      ws.on("error", () => finish(undefined));
      ws.on("message", (data: Buffer | string) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const id = msg.id as number | undefined;
        if (id === undefined) return;
        const result = msg.result as Record<string, unknown> | undefined;
        if (id === attachId) {
          const sid = result?.sessionId as string | undefined;
          if (!sid) return finish(undefined);
          evalId = sendMsg("Runtime.evaluate", { expression: expr, returnByValue: true }, sid);
          return;
        }
        if (id === evalId) {
          const evalResult = result?.result as Record<string, unknown> | undefined;
          finish(evalResult?.value);
        }
      });
    });

    const meta = sanitizePageMeta(raw);
    timing.end({ pre_resolved: !!resolvedTarget, ok: meta !== undefined });
    return meta;
  } catch {
    timing.end({ pre_resolved: !!resolvedTarget, ok: false });
    return undefined;
  }
}

// ─── Bundled candidate + page-meta extraction (single connection) ────────────

/** Result of the bundled snapshot extraction: candidates + best-effort page meta. */
export interface AntigenSnapshotBundle {
  candidates: AntigenSnapshotCandidate[];
  pageMeta?: AntigenPageMeta;
  // Cheap page-level human-verification *hint* (present only when
  // ANTIGEN_HUMAN_VERIFICATION is on). True when strong HV text AND a visible
  // inaccessible iframe are present in the top document — the precheck that
  // gates the full confirming wall probe on snapshots whose background DOM is
  // preserved (high element_count). Best-effort: `undefined` when the flag is
  // off or the hint eval failed/timed out.
  hvWallHint?: boolean;
}

/** Sub-timeout for the best-effort page-meta eval after candidates returned. */
const BUNDLE_PAGE_META_TIMEOUT_MS = 2_000;

/**
 * Single-connection snapshot extraction: candidate DOM extraction AND the
 * best-effort page-meta read on the SAME WebSocket + CDP session, removing the
 * second connect+attach round trip extractAntigenPageMetaViaCDP would pay.
 *
 * Contract (identical to the two separate calls — only transport is shared):
 * - Candidate-path failures throw with the SAME codes as
 *   extractAntigenSnapshotCandidatesViaCDP (CDP_FETCH_FAILED / NO_PAGE_TARGET /
 *   CDP_ATTACH_FAILED / CDP_EVALUATE_FAILED), so the endpoint's
 *   SNAPSHOT_EXTRACTION_FAILED behavior is unchanged.
 * - Page-meta is best-effort and NEVER fails the bundle: any meta eval error or
 *   its own 2s sub-timeout resolves with `pageMeta: undefined` (matching
 *   extractAntigenPageMetaViaCDP's never-throw contract). The candidate 8s
 *   deadline is NOT re-armed for the meta eval.
 * - Both evals run on one attach to the one resolved target, so candidates and
 *   page meta are guaranteed to describe the same page.
 *
 * The standalone extractAntigenSnapshotCandidatesViaCDP /
 * extractAntigenPageMetaViaCDP remain exported and unchanged for other callers
 * and tests.
 */
export async function extractAntigenSnapshotBundleViaCDP(
  params: ExtractAntigenSnapshotCandidatesParams,
): Promise<AntigenSnapshotBundle> {
  const { cdpUrl, resolvedTarget } = params;
  const maxCandidates = params.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const viewportOnly = params.viewportOnly ?? true;
  // Stage timing (dev-only, gated): stage labels + durations + scalar counts only.
  const timing = new BrowserTimingScope("antigen_snapshot_bundle");

  // Same target resolution as the candidate path: pre-resolved target preferred,
  // self-contained fetch + pickAntigenPageTarget as the legacy fallback.
  let browserWsUrl: string;
  let pageTarget: { id: string; url: string };
  if (resolvedTarget) {
    browserWsUrl = resolvedTarget.browserWsUrl;
    pageTarget = resolvedTarget.pageTarget;
  } else {
    let versionData: { webSocketDebuggerUrl?: string };
    let targets: Array<{ id: string; url: string; type: string }>;
    try {
      [versionData, targets] = await Promise.all([
        fetch(`${cdpUrl}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>),
        fetch(`${cdpUrl}/json/list`).then(
          (r) => r.json() as Promise<Array<{ id: string; url: string; type: string }>>,
        ),
      ]);
    } catch (err) {
      throw Object.assign(new Error(`CDP fetch failed: ${(err as Error).message}`), {
        code: "CDP_FETCH_FAILED",
      });
    }
    const ws = versionData.webSocketDebuggerUrl;
    if (!ws) {
      throw Object.assign(new Error("No browser WebSocket debugger URL from CDP."), {
        code: "CDP_FETCH_FAILED",
      });
    }
    const picked = pickAntigenPageTarget(targets);
    if (!picked) {
      throw Object.assign(new Error("No page targets found via CDP."), {
        code: "NO_PAGE_TARGET",
      });
    }
    browserWsUrl = ws;
    pageTarget = picked;
    timing.mark("target_fallback_fetch");
  }

  const candidateExpr = buildAntigenExtractionExpr({ maxCandidates, viewportOnly });
  const pageMetaExpr = buildAntigenPageMetaExpr();
  // Page-level HV hint: a cheap third eval on the SAME session, dispatched ONLY
  // when ANTIGEN_HUMAN_VERIFICATION is on. Flag off → the eval is never sent and
  // the meta-only flow below is byte-identical to before.
  const hvEnabled = isHumanVerificationEnabled();
  const hvHintExpr = hvEnabled ? buildPageHvWallHintExpr() : "";

  const { raw, rawMeta, rawHint } = await new Promise<{
    raw: RawAntigenCandidate[];
    rawMeta: unknown;
    rawHint: unknown;
  }>((resolve, reject) => {
      const ws = new WebSocket(browserWsUrl);
      let msgId = 1;
      let cdpSessionId: string | null = null;
      let attachId: number;
      let candidateEvalId: number;
      let metaEvalId: number | undefined;
      let hintEvalId: number | undefined;
      let candidateRecords: RawAntigenCandidate[] = [];
      let metaValue: unknown;
      let settled = false;
      let metaTimer: ReturnType<typeof setTimeout> | undefined;

      // Candidate-phase hard deadline — identical to the standalone candidate
      // extraction. Cleared once candidates arrive; never re-armed for page meta.
      const candidateTimer = setTimeout(() => {
        fail(Object.assign(new Error("Antigen snapshot extraction timed out after 8 seconds."), {
          code: "CDP_EVALUATE_FAILED",
        }));
      }, 8_000);

      const sendMsg = (method: string, p: Record<string, unknown> = {}, sid?: string): number => {
        const id = msgId++;
        const msg: Record<string, unknown> = { id, method, params: p };
        if (sid) msg.sessionId = sid;
        ws.send(JSON.stringify(msg));
        return id;
      };

      const succeed = (value: {
        raw: RawAntigenCandidate[];
        rawMeta: unknown;
        rawHint: unknown;
      }) => {
        if (settled) return;
        settled = true;
        clearTimeout(candidateTimer);
        if (metaTimer) clearTimeout(metaTimer);
        ws.close();
        resolve(value);
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(candidateTimer);
        if (metaTimer) clearTimeout(metaTimer);
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(err);
      };

      ws.on("open", () => {
        attachId = sendMsg("Target.attachToTarget", { targetId: pageTarget.id, flatten: true });
      });

      ws.on("error", (err: Error) => {
        // Candidates not yet delivered → candidate-path failure (same code as the
        // standalone path). After candidates, a socket error only costs the
        // best-effort meta/hint — succeed with whatever was already captured.
        if (metaEvalId !== undefined)
          succeed({ raw: candidateRecords, rawMeta: metaValue, rawHint: undefined });
        else fail(Object.assign(new Error(`CDP socket error: ${err.message}`), { code: "CDP_FETCH_FAILED" }));
      });

      ws.on("message", (data: Buffer | string) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const id = msg.id as number | undefined;
        if (id === undefined) return; // CDP event notification, no id
        const result = msg.result as Record<string, unknown> | undefined;

        if (id === attachId) {
          if (!result?.sessionId) {
            fail(Object.assign(new Error("CDP attach failed: no sessionId."), { code: "CDP_ATTACH_FAILED" }));
            return;
          }
          cdpSessionId = result.sessionId as string;
          timing.mark("connect_attach");
          candidateEvalId = sendMsg("Runtime.evaluate", { expression: candidateExpr, returnByValue: true }, cdpSessionId);
          return;
        }

        if (id === candidateEvalId) {
          timing.mark("eval_iife");
          const evalResult = result?.result as Record<string, unknown> | undefined;
          const value = evalResult?.value;
          candidateRecords = Array.isArray(value) ? (value as RawAntigenCandidate[]) : [];
          // Candidates are safe — stop the candidate deadline and start the
          // best-effort meta eval on the SAME session with its own sub-timeout.
          clearTimeout(candidateTimer);
          metaTimer = setTimeout(
            () => succeed({ raw: candidateRecords, rawMeta: undefined, rawHint: undefined }),
            BUNDLE_PAGE_META_TIMEOUT_MS,
          );
          try {
            metaEvalId = sendMsg("Runtime.evaluate", { expression: pageMetaExpr, returnByValue: true }, cdpSessionId!);
          } catch {
            succeed({ raw: candidateRecords, rawMeta: undefined, rawHint: undefined });
          }
          return;
        }

        if (metaEvalId !== undefined && id === metaEvalId) {
          timing.mark("eval_pagemeta");
          const evalResult = result?.result as Record<string, unknown> | undefined;
          metaValue = evalResult?.value;
          // Flag off → finish exactly as before (meta-only, byte-identical).
          if (!hvEnabled) {
            succeed({ raw: candidateRecords, rawMeta: metaValue, rawHint: undefined });
            return;
          }
          // Flag on → dispatch the cheap hint eval on the SAME session, re-arming
          // the best-effort sub-timeout so a missing hint can never hang.
          if (metaTimer) clearTimeout(metaTimer);
          metaTimer = setTimeout(
            () => succeed({ raw: candidateRecords, rawMeta: metaValue, rawHint: undefined }),
            BUNDLE_PAGE_META_TIMEOUT_MS,
          );
          try {
            hintEvalId = sendMsg("Runtime.evaluate", { expression: hvHintExpr, returnByValue: true }, cdpSessionId!);
          } catch {
            succeed({ raw: candidateRecords, rawMeta: metaValue, rawHint: undefined });
          }
          return;
        }

        if (hintEvalId !== undefined && id === hintEvalId) {
          timing.mark("eval_hvhint");
          const evalResult = result?.result as Record<string, unknown> | undefined;
          succeed({ raw: candidateRecords, rawMeta: metaValue, rawHint: evalResult?.value });
        }
      });
    });

  const candidates = raw.slice(0, maxCandidates).map((rec, i) => mapRawToCandidate(rec, i));
  const pageMeta = sanitizePageMeta(rawMeta);
  // Re-validate the raw hint server-side: a boolean from { hint: boolean } only,
  // never the raw page value blindly. `undefined` when flag off / eval skipped.
  const hvWallHint =
    rawHint && typeof rawHint === "object" && typeof (rawHint as { hint?: unknown }).hint === "boolean"
      ? (rawHint as { hint: boolean }).hint
      : undefined;
  timing.mark("sanitize_map");
  timing.end({
    candidate_count: candidates.length,
    page_meta_ok: pageMeta !== undefined,
    pre_resolved: !!resolvedTarget,
    viewport_only: viewportOnly,
  });
  return {
    candidates,
    ...(pageMeta !== undefined ? { pageMeta } : {}),
    ...(hvWallHint !== undefined ? { hvWallHint } : {}),
  };
}

/**
 * Minimal page-target picker. Inlined (rather than importing
 * cdpTargetSelection.pickBestPageTarget) to keep this increment self-contained
 * and free of cross-module coupling; we can dedupe against that helper in a
 * later phase when ref/store wiring lands.
 */
function pickAntigenPageTarget(
  targets: Array<{ id: string; url: string; type: string }>,
): { id: string; url: string } | undefined {
  const pages = targets.filter((t) => t.type === "page");
  if (pages.length === 0) return undefined;
  const unusablePrefixes = ["about:", "chrome://", "devtools://", "chrome-extension://"];
  const usable = pages.find((t) => !unusablePrefixes.some((p) => t.url.startsWith(p)));
  return usable ?? pages.at(-1);
}
