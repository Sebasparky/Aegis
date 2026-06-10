import WebSocket from "ws";
import type { ProfileFieldFillRequest, ProfileFieldFillEntry, ProfileFieldKind } from "@aegis/types";
import {
  makePointerRuntimeState,
  clickBoxWithPointer,
  type PointerRuntimeState,
  type ElementBox,
} from "./nativePointerRuntime.js";
import { pickBestPageTarget } from "./cdpTargetSelection.js";
import {
  getTaskBrowserSessionPointerState,
  setTaskBrowserSessionPointerState,
} from "./taskBrowserSessions.js";
import { getLoadedPointerTraces } from "./pointerProfileLoader.js";
import { getInputRealismMode, typeCharsViaCDP } from "./inputRealismTyper.js";
import { BrowserTimingScope } from "./browserTiming.js";

// US state abbreviation → full name (uppercase keys)
const US_STATE_MAP: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};
// Full name → abbreviation (lowercase keys for case-insensitive lookup)
const US_STATE_REV_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATE_MAP).map(([abbr, name]) => [name.toLowerCase(), abbr]),
);

// ISO 2-letter code → full name (uppercase keys)
const COUNTRY_MAP: Record<string, string> = {
  US: "United States", CA: "Canada", GB: "United Kingdom",
  AU: "Australia", DE: "Germany", FR: "France", NL: "Netherlands",
  SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland",
  JP: "Japan", CN: "China", IN: "India", BR: "Brazil", MX: "Mexico",
};
// Full name → code (lowercase keys)
const COUNTRY_REV_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(COUNTRY_MAP).map(([code, name]) => [name.toLowerCase(), code]),
);

/**
 * Find the best matching <select> option value for a raw profile value.
 * Tries exact case-insensitive match first, then state/country abbreviation mapping.
 * Returns the option's `.value` attribute on match, or null if no match found.
 * Exported for unit testing — the same logic is also embedded in the CDP fill expression.
 */
export function findBestSelectOption(
  options: Array<{ value: string; text: string }>,
  rawValue: string,
): string | null {
  const lower = rawValue.toLowerCase().trim();

  const exact = options.find(
    (o) => o.value.toLowerCase() === lower || o.text.toLowerCase().trim() === lower,
  );
  if (exact) return exact.value;

  const upper = rawValue.toUpperCase();
  // Strip an ISO 3166-2 country prefix (e.g. "US-MI" → "MI") so US-MI / MI / Michigan
  // all resolve to the same option.
  const dashIdx = rawValue.indexOf("-");
  const strippedUpper = dashIdx > 0 ? rawValue.slice(dashIdx + 1).toUpperCase() : upper;
  const alt =
    US_STATE_MAP[upper] ??
    US_STATE_MAP[strippedUpper] ??
    US_STATE_REV_MAP[lower] ??
    COUNTRY_MAP[upper] ??
    COUNTRY_REV_MAP[lower];

  if (alt) {
    const altLower = alt.toLowerCase().trim();
    const altMatch = options.find(
      (o) => o.value.toLowerCase() === altLower || o.text.toLowerCase().trim() === altLower,
    );
    if (altMatch) return altMatch.value;
  }

  return null;
}

/**
 * Structural metadata about the resolved target field, used to format a canonical profile
 * value into a representation the field will accept. Metadata only — never carries a value.
 */
export interface TargetFieldMeta {
  type?: string; // input type, lowercased ("tel", "text", ...)
  autocomplete?: string; // "tel" | "tel-national" | "tel-local" | ...
  placeholder?: string; // may carry a mask, e.g. "(555) 123-4567" or "+1 ___ ___ ____"
  maxlength?: number | null;
  pattern?: string | null;
}

// A US national number is 10 digits, optionally prefixed by a "1" country code (11 digits).
function toUsNationalDigits(digits: string): string | null {
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

// International format is only chosen on an explicit signal — a literal "+" in the mask/pattern,
// or a number that is not a recognizable US national number. The common US-checkout case prefers
// bare national digits, which masks (e.g. IKEA's "+1-___-___-____") format correctly themselves.
function wantsInternationalPhone(meta: TargetFieldMeta): boolean {
  const hay = `${meta.placeholder ?? ""} ${meta.pattern ?? ""}`;
  return hay.includes("+");
}

/**
 * Format a canonical profile value for a specific target field. Generic by kind; only `phone`
 * has formatting logic in v1 (all other kinds pass through unchanged).
 *
 * Phone: the canonical seed is country-code-inclusive (e.g. "15551234567"). Injecting that raw
 * into a national `tel` mask shifts the digits (the "+1-155-512-3456" corruption). This strips the
 * US country code and emits either bare national digits (default, most checkout-compatible) or a
 * mask-shaped string when the field advertises a formatted mask. International form is used only on
 * an explicit "+" signal. The formatted value is consumed by CDP and never returned to the agent.
 */
export function formatProfileValueForTarget(
  kind: ProfileFieldKind,
  canonicalValue: string,
  meta: TargetFieldMeta,
): string {
  if (kind !== "phone") return canonicalValue;
  const raw = canonicalValue ?? "";
  const digits = raw.replace(/\D+/g, "");
  if (!digits) return canonicalValue;

  const national = toUsNationalDigits(digits);
  const intl = wantsInternationalPhone(meta);

  if (intl) {
    return national ? `+1${national}` : `+${digits}`;
  }
  if (!national) {
    // Not a recognizable US national number and no international signal — return the digits as-is.
    return digits;
  }

  // US national. Shape it from the field's mask when one is advertised; otherwise bare digits.
  const a = national.slice(0, 3);
  const b = national.slice(3, 6);
  const c = national.slice(6, 10);
  const mask = `${meta.placeholder ?? ""} ${meta.pattern ?? ""}`;
  if (/\(/.test(mask) && /\)/.test(mask)) return `(${a}) ${b}-${c}`;
  if (/-/.test(mask)) return `${a}-${b}-${c}`;
  if (/\./.test(mask)) return `${a}.${b}.${c}`;
  // Default: bare national digits. Masks that auto-prepend "+1" format these correctly themselves.
  return national;
}

// Reuse same dangerous-selector rules as paymentCardFill.ts — profile fill targets input fields only.
const DANGEROUS_SELECTOR_PATTERNS: RegExp[] = [
  /\bbutton\b/i,
  /\bsubmit\b/i,
  /\[type\s*=\s*["']?submit/i,
  /input\[type\s*=\s*["']?button/i,
  /\bform\b/i,
  /\ba\[href\b/i,
  /\[role\s*=\s*["']?button/i,
];

export function validateProfileFillSelector(selector: string): { valid: boolean; reason?: string } {
  for (const pattern of DANGEROUS_SELECTOR_PATTERNS) {
    if (pattern.test(selector)) {
      return {
        valid: false,
        reason:
          `Selector "${selector}" appears to target a button, submit control, form, or anchor — ` +
          `which are prohibited for profile field fill. Provide a selector that targets only the input field.`,
      };
    }
  }
  return { valid: true };
}

// Generate a masked summary for display purposes only — raw value is consumed by CDP and never returned.
// DOM value is left intact (not masked) so checkout pages can read and submit it normally.
export function maskProfileValue(kind: ProfileFieldKind, rawValue: string): string {
  if (!rawValue) return "***";
  switch (kind) {
    case "first_name":
    case "last_name":
      return rawValue[0] + "***";
    case "email": {
      const atIdx = rawValue.indexOf("@");
      if (atIdx > 0) {
        const user = rawValue.slice(0, atIdx);
        const domain = rawValue.slice(atIdx + 1);
        const dotIdx = domain.lastIndexOf(".");
        const tld = dotIdx >= 0 ? domain.slice(dotIdx) : "";
        return `${user[0]}***@***.${tld.slice(1) || "***"}`;
      }
      return `${rawValue[0]}***`;
    }
    case "phone":
      return `***-***-${rawValue.slice(-4)}`;
    case "shipping_address_line1":
      return "Street address filled";
    case "shipping_address_line2":
      return rawValue.length > 0 ? "Address line 2 filled" : "";
    case "postal_code":
      return `${rawValue[0]}***`;
    case "city":
    case "region":
    case "country":
      return rawValue.length > 0 ? `${rawValue[0]}***` : "***";
    default:
      return rawValue.length > 0 ? `${rawValue[0]}***` : "***";
  }
}

// ─── Semantic field resolution ────────────────────────────────────────────────
//
// Modern hydrated checkout pages re-render inputs and regenerate element ids on every
// delivery/billing panel change, so a single brittle `querySelector(selector_hint)` (or a
// snapshot ref captured a moment earlier) frequently misses. To survive this we resolve each
// requested field semantically: the page is enumerated once for candidate fields (structural
// metadata ONLY — never values), and a pure scoring function picks the best match using stable
// signals (autocomplete attribute, accessible label, placeholder, name/id, field-kind). A
// post-match kind-consistency check then fails closed if the chosen control's own signals point
// at a different field kind. This recovery lives ONLY in the profile-field-fill executor; it does
// not touch generic browser_type / browser_click / ag_* ref validation.

/** Structural descriptor of a candidate field — emitted by the in-page enumeration. No values. */
export interface ProfileFieldCandidate {
  fill_id: string; // temporary stable handle assigned during enumeration (data-antigen-fill-id)
  tag: string; // "input" | "select" | "textarea"
  type: string; // input type, lowercased ("text" default)
  name: string; // lowercased
  id: string; // lowercased
  autocomplete: string; // lowercased, whitespace-collapsed (may carry section tokens e.g. "shipping street-address")
  placeholder: string; // lowercased
  label_text: string; // lowercased accessible label text
  aria_label: string; // lowercased
  section_text: string; // lowercased nearest legend/section text
  maxlength: number | null; // maxlength attribute (used for value formatting; never a value)
  pattern: string; // pattern attribute, clipped (used for value formatting; never a value)
}

export interface ProfileFieldHints {
  selector_hint?: string;
  label?: string;
  placeholder?: string;
}

export interface ProfileFieldResolution {
  fill_id: string | null;
  strategy: string; // which strategy matched, or "none"
  reason?: string; // failure reason when fill_id is null: NO_CONFIDENT_MATCH | KIND_MISMATCH
}

interface KindSpec {
  autocomplete: string[]; // meaningful autocomplete tokens for this kind
  keywords: string[]; // substrings for label / placeholder / name / id matching
}

// Per-kind semantic signals. Keywords are matched against label/placeholder (raw, may contain spaces)
// and against name/id (alphanumeric-normalized).
const KIND_SPECS: Record<ProfileFieldKind, KindSpec> = {
  first_name: { autocomplete: ["given-name"], keywords: ["first name", "firstname", "given name", "fname", "givenname"] },
  last_name: { autocomplete: ["family-name"], keywords: ["last name", "lastname", "surname", "family name", "lname", "familyname"] },
  email: { autocomplete: ["email"], keywords: ["email", "e-mail"] },
  account_creation_email: { autocomplete: ["email"], keywords: ["email", "e-mail"] },
  phone: { autocomplete: ["tel", "tel-national", "tel-local"], keywords: ["phone", "mobile", "telephone", "tel"] },
  shipping_address_line1: {
    autocomplete: ["address-line1", "street-address"],
    keywords: ["address line 1", "street address", "address1", "addressline1", "street", "address"],
  },
  shipping_address_line2: {
    autocomplete: ["address-line2"],
    keywords: ["address line 2", "apartment", "apt", "unit", "suite", "address2", "addressline2", "line 2"],
  },
  city: { autocomplete: ["address-level2"], keywords: ["city", "town", "suburb"] },
  region: { autocomplete: ["address-level1"], keywords: ["state", "province", "region", "county"] },
  postal_code: { autocomplete: ["postal-code"], keywords: ["zip", "postal", "postcode", "post code", "zip code"] },
  country: { autocomplete: ["country", "country-name"], keywords: ["country"] },
};

// Autocomplete token → kind family. Used by verifyKindConsistency to reject cross-kind fills.
const AC_FAMILY: Record<string, string> = {
  "given-name": "first_name",
  "family-name": "last_name",
  email: "email",
  tel: "phone",
  "tel-national": "phone",
  "tel-local": "phone",
  "address-line1": "addr1",
  "street-address": "addr1",
  "address-line2": "addr2",
  "address-level2": "city",
  "address-level1": "region",
  "postal-code": "postal",
  country: "country",
  "country-name": "country",
};

const KIND_FAMILY: Record<ProfileFieldKind, string> = {
  first_name: "first_name",
  last_name: "last_name",
  email: "email",
  account_creation_email: "email",
  phone: "phone",
  shipping_address_line1: "addr1",
  shipping_address_line2: "addr2",
  city: "city",
  region: "region",
  postal_code: "postal",
  country: "country",
};

function normAlnum(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Secondary-line ("address line 2" / apt / unit / suite / optional) indicators. Used to
// disambiguate the shared "Street address" label that the primary line-1 and the optional
// line-2 field carry on hydrated checkout pages (e.g. IKEA), where neither field has a
// distinguishing autocomplete attribute and ids are regenerated on every re-render.
const LINE2_INDICATORS = [
  "street address 2", "address line 2", "address 2", "line 2",
  "apartment", "apt", "unit", "suite", "optional",
];

// Does this candidate's stable text/name signals look like a secondary address line?
// Structural metadata ONLY — never inspects the field value. Combined label/aria/placeholder/
// section text is lowercased defensively so mixed-case input matches the lowercase indicators
// (in-page enumeration already lowercases, but unit tests may pass raw descriptors).
function hasLine2Indicator(c: ProfileFieldCandidate): boolean {
  const text = [c.label_text, c.aria_label, c.placeholder, c.section_text]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const nameId = normAlnum(c.name + c.id); // normAlnum already lowercases
  return (
    LINE2_INDICATORS.some((k) => text.includes(k)) ||
    ["addressline2", "address2", "apt", "apartment", "unit", "suite", "line2"].some((k) =>
      nameId.includes(k),
    )
  );
}

// The last meaningful token of an autocomplete attribute (strips "shipping"/"billing"/"section-*" prefixes).
function lastAutocompleteToken(autocomplete: string): string {
  const toks = (autocomplete || "").split(/\s+/).filter(Boolean);
  return toks.length ? toks[toks.length - 1] : "";
}

/**
 * Verify a resolved candidate's own signals are consistent with the requested field kind.
 * Fails closed: a candidate whose autocomplete or input type declares a DIFFERENT kind family is
 * rejected, so e.g. an email request can never be filled into a `tel` field.
 * Exported for unit testing.
 */
export function verifyKindConsistency(
  kind: ProfileFieldKind,
  c: ProfileFieldCandidate,
): { ok: boolean; reason?: string } {
  const wantFamily = KIND_FAMILY[kind];
  const acTok = lastAutocompleteToken(c.autocomplete);
  const acFamily = acTok ? AC_FAMILY[acTok] : undefined;
  if (acFamily && acFamily !== wantFamily) {
    return { ok: false, reason: `autocomplete=${acTok}` };
  }
  if (c.type === "email" && wantFamily !== "email") {
    return { ok: false, reason: "type=email" };
  }
  if (c.type === "tel" && wantFamily !== "phone") {
    return { ok: false, reason: "type=tel" };
  }
  return { ok: true };
}

// Score a single candidate for a kind. Higher score = more confident strategy. 0 = no match.
function scoreCandidate(
  kind: ProfileFieldKind,
  c: ProfileFieldCandidate,
  hints: ProfileFieldHints,
): { score: number; strategy: string } {
  const spec = KIND_SPECS[kind];
  const labelish = c.label_text || c.aria_label;

  // A secondary address line ("Street address 2 (optional)", apt/unit/suite) must NEVER be
  // scored as address line 1. The agent-hint tiers below match by substring, and the line-1
  // label ("Street address") is a prefix of the line-2 label ("Street address 2 (optional)"),
  // so without this guard a "Street address" label hint matches BOTH fields at the hint tier and
  // the resolver fails closed on the tie. Computed once and applied across every non-autocomplete
  // tier; a field carrying an authoritative line-1 autocomplete is still handled by that tier.
  const line2 = hasLine2Indicator(c);
  const isLine1Secondary = kind === "shipping_address_line1" && line2;

  // Agent-provided label / placeholder hints take precedence over generic kind keywords.
  if (hints.label && !isLine1Secondary) {
    const hl = hints.label.toLowerCase();
    if ((c.label_text && c.label_text.includes(hl)) || (c.aria_label && c.aria_label.includes(hl))) {
      return { score: 80, strategy: "hint_label" };
    }
  }
  if (hints.placeholder && !isLine1Secondary) {
    const hp = hints.placeholder.toLowerCase();
    if (c.placeholder && c.placeholder.includes(hp)) {
      return { score: 75, strategy: "hint_placeholder" };
    }
  }

  const acTok = lastAutocompleteToken(c.autocomplete);
  if (acTok && spec.autocomplete.includes(acTok)) {
    return { score: 90, strategy: "autocomplete" };
  }

  // Address line 1 vs line 2 disambiguation — label/placeholder/name-id tiers only.
  // Placed after the autocomplete tier so a correct autocomplete attribute stays authoritative
  // (and verifyKindConsistency still rejects line1↔address-line2 cross-fills).
  if (isLine1Secondary) {
    // Secondary-line field — never treat it as line 1. Breaks the shared "Street address" tie.
    return { score: 0, strategy: "none" };
  }
  if (kind === "shipping_address_line2" && line2) {
    // Distinctive secondary-line text — strong, unique label-tier signal.
    return { score: 72, strategy: "address_line2" };
  }

  if (labelish && spec.keywords.some((k) => labelish.includes(k))) {
    return { score: 70, strategy: "label" };
  }
  if (c.placeholder && spec.keywords.some((k) => c.placeholder.includes(k))) {
    return { score: 60, strategy: "placeholder" };
  }
  const nameId = normAlnum(c.name + c.id);
  if (nameId && spec.keywords.some((k) => nameId.includes(normAlnum(k)))) {
    return { score: 50, strategy: "name_id" };
  }
  if ((kind === "email" && c.type === "email") || (kind === "phone" && c.type === "tel")) {
    return { score: 30, strategy: "input_type" };
  }
  return { score: 0, strategy: "none" };
}

// Does an agent-provided selector_hint clearly point at this candidate's id or name?
function selectorHintMatches(hint: string, c: ProfileFieldCandidate): boolean {
  const h = hint.toLowerCase();
  if (c.id) {
    if (h === `#${c.id}` || h.includes(`#${c.id}`) || h.includes(`"${c.id}"`) || h.includes(`'${c.id}'`) || h.includes(`id=${c.id}`)) {
      return true;
    }
  }
  if (c.name) {
    if (h.includes(`"${c.name}"`) || h.includes(`'${c.name}'`) || h.includes(`name=${c.name}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Pick the best candidate field for a requested kind. Strategy order (highest confidence first):
 *   1. selector_hint that uniquely matches a candidate's id/name
 *   2. agent-provided label / placeholder hint
 *   3. autocomplete token
 *   4. accessible label / aria-label keyword
 *   5. placeholder keyword
 *   6. name/id keyword
 *   7. field-kind input-type heuristic (email/tel)
 * The winner must then pass verifyKindConsistency or resolution fails closed (KIND_MISMATCH).
 * Ambiguous ties at the top tier fail closed (NO_CONFIDENT_MATCH). Exported for unit testing.
 */
export function pickProfileFieldCandidate(
  kind: ProfileFieldKind,
  candidates: ProfileFieldCandidate[],
  hints: ProfileFieldHints,
): ProfileFieldResolution {
  if (!candidates.length) {
    return { fill_id: null, strategy: "none", reason: "NO_CONFIDENT_MATCH" };
  }

  // Tier 1 — selector_hint exact id/name match. A stale hint (0 or >1 matches) falls through to
  // semantic recovery rather than failing immediately.
  if (hints.selector_hint) {
    const hintMatches = candidates.filter((c) => selectorHintMatches(hints.selector_hint!, c));
    if (hintMatches.length === 1) {
      const c = hintMatches[0];
      const v = verifyKindConsistency(kind, c);
      if (!v.ok) return { fill_id: null, strategy: "selector_hint", reason: "KIND_MISMATCH" };
      return { fill_id: c.fill_id, strategy: "selector_hint" };
    }
  }

  // Tiers 2–7 — semantic scoring; unique top score wins.
  const scored = candidates.map((c) => ({ c, ...scoreCandidate(kind, c, hints) }));
  const maxScore = Math.max(...scored.map((s) => s.score));
  if (maxScore === 0) {
    return { fill_id: null, strategy: "none", reason: "NO_CONFIDENT_MATCH" };
  }
  let top = scored.filter((s) => s.score === maxScore);
  if (top.length > 1) {
    // Tie-break by kind-consistency: drop tied candidates whose own signals declare a different
    // field kind. A generic keyword like "address" (in the line-1 keyword set) also matches an
    // "Email address" label, tying the real street field with the email input; the email field is
    // type=email / autocomplete=email and is dropped here, leaving the address field as the unique
    // winner. If this does not narrow to exactly one candidate, we still fail closed below.
    const consistent = top.filter((s) => verifyKindConsistency(kind, s.c).ok);
    if (consistent.length === 1) {
      top = consistent;
    }
  }
  if (top.length !== 1) {
    return { fill_id: null, strategy: top[0].strategy, reason: "NO_CONFIDENT_MATCH" };
  }
  const chosen = top[0].c;
  const v = verifyKindConsistency(kind, chosen);
  if (!v.ok) return { fill_id: null, strategy: top[0].strategy, reason: "KIND_MISMATCH" };
  return { fill_id: chosen.fill_id, strategy: top[0].strategy };
}

// In-page enumeration of candidate fields. Returns structural metadata ONLY (never field values),
// and tags each candidate with a temporary data-antigen-fill-id so the resolved field can be
// re-located by a stable selector for the rest of the fill, immune to id regeneration.
const ENUMERATE_CANDIDATES_JS = `(function() {
  function clip(s, n) { return (s || '').replace(/\\s+/g, ' ').trim().slice(0, n).toLowerCase(); }
  var nodes = Array.from(document.querySelectorAll('input, select, textarea'));
  var skipTypes = ['hidden','submit','button','reset','image','checkbox','radio','file','range','color'];
  var out = [];
  var i = 0;
  for (var n = 0; n < nodes.length; n++) {
    var el = nodes[n];
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || (tag === 'input' ? 'text' : '')).toLowerCase();
    if (tag === 'input' && skipTypes.indexOf(type) !== -1) continue;
    if (el.disabled || el.readOnly) continue;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    if (!(rect.width > 0 && rect.height > 0) || style.visibility === 'hidden' || style.display === 'none') continue;
    var inIframe = false, node = el;
    while (node && node.parentNode) { if (node.tagName === 'IFRAME') { inIframe = true; break; } node = node.parentNode; }
    if (inIframe) continue;
    var labelText = '';
    if (el.labels && el.labels.length) { labelText = el.labels[0].textContent || ''; }
    if (!labelText) { var anc = el.closest('label'); if (anc) labelText = anc.textContent || ''; }
    if (!labelText) {
      var by = el.getAttribute('aria-labelledby');
      if (by) { var ref = document.getElementById(by); if (ref) labelText = ref.textContent || ''; }
    }
    var sectionText = '';
    var fs = el.closest('fieldset');
    if (fs) { var lg = fs.querySelector('legend'); if (lg) sectionText = lg.textContent || ''; }
    var fid = 'agfill_' + i; i++;
    el.setAttribute('data-antigen-fill-id', fid);
    out.push({
      fill_id: fid,
      tag: tag,
      type: type,
      name: (el.getAttribute('name') || '').toLowerCase(),
      id: (el.getAttribute('id') || '').toLowerCase(),
      autocomplete: clip(el.getAttribute('autocomplete'), 60),
      placeholder: clip(el.getAttribute('placeholder'), 120),
      label_text: clip(labelText, 120),
      aria_label: clip(el.getAttribute('aria-label'), 120),
      section_text: clip(sectionText, 80),
      maxlength: (function() { var m = el.getAttribute('maxlength'); var v = m ? parseInt(m, 10) : NaN; return isNaN(v) ? null : v; })(),
      pattern: (el.getAttribute('pattern') || '').slice(0, 120)
    });
  }
  return out;
})()`;

// Build a stable selector expression for a resolved fill_id (re-locatable across re-renders).
function fillIdSelectorExpr(fillId: string): string {
  return `document.querySelector(${JSON.stringify(`[data-antigen-fill-id="${fillId}"]`)})`;
}

// In-memory pointer state per fill session — tracks current pointer position across fields.
// Keyed by browser_session_id when available, then fill_request_id, then "default".
const pointerStateByFill = new Map<string, PointerRuntimeState>();

function getOrCreateFillPointerState(key: string): PointerRuntimeState {
  let state = pointerStateByFill.get(key);
  if (!state) {
    state = makePointerRuntimeState();
    pointerStateByFill.set(key, state);
  }
  return state;
}

/**
 * Fill multiple profile fields in the agent's active browser via a single CDP WebSocket session.
 *
 * Security constraints:
 * - resolvedValues flows: KMS → caller → this function → CDP → browser field. Never logged, returned, or persisted.
 * - DOM value is NOT masked after fill — checkout pages need to read actual values for validation and submission.
 *   Masking is applied only to the masked_summary returned to the agent.
 * - If the target element is inside an iframe, the field records status "failed" with IFRAME_NOT_SUPPORTED.
 * - All Class 2 fields return masked_summary via maskProfileValue(), never the raw value.
 */
export async function executeProfileFieldFillViaCDP(
  fillRequest: ProfileFieldFillRequest,
  resolvedValues: Map<ProfileFieldKind, string>,
  cdpUrlOverride?: string,
  preferredTargetUrl?: string,
): Promise<ProfileFieldFillEntry[]> {
  const cdpBase = cdpUrlOverride ?? process.env.AEGIS_PLAYWRIGHT_CDP_URL;
  if (!cdpBase) {
    return fillRequest.requested_fields.map((f) => ({
      key: f.key,
      field_filled: false,
      status: "failed" as const,
      raw_profile_value_revealed_to_agent: false as const,
      error:
        "AEGIS_PLAYWRIGHT_CDP_URL is not configured. " +
        "Set this to the Chrome remote debugging base URL (e.g. http://localhost:9222).",
    }));
  }

  try {
    const [versionData, targets] = await Promise.all([
      fetch(`${cdpBase}/json/version`).then((r) => r.json()),
      fetch(`${cdpBase}/json/list`).then((r) => r.json()),
    ]);

    const browserWsUrl: string = (versionData as Record<string, string>).webSocketDebuggerUrl;
    if (!browserWsUrl) {
      return fillRequest.requested_fields.map((f) => ({
        key: f.key,
        field_filled: false,
        status: "failed" as const,
        raw_profile_value_revealed_to_agent: false as const,
        error: "No browser WebSocket debugger URL returned by CDP.",
      }));
    }

    // Select the active page target. Priority: exact URL > same origin > domain > non-blank > last.
    const { target: pageTarget, candidates } = pickBestPageTarget(
      targets as Array<{ id: string; url: string; type: string }>,
      { domain: fillRequest.domain, preferredUrl: preferredTargetUrl },
    );

    if (!pageTarget) {
      const urls = candidates.map((c) => c.url).join(", ") || "(none)";
      return fillRequest.requested_fields.map((f) => ({
        key: f.key,
        field_filled: false,
        status: "failed" as const,
        raw_profile_value_revealed_to_agent: false as const,
        error: `No page targets found via CDP. Active page target binding failed. Candidates: [${urls}]`,
      }));
    }

    // Dev-only latency markers (gated). Sanitized: stage labels + durations +
    // field-kind tokens only — never values, selectors, labels, or coordinates.
    const timing = new BrowserTimingScope("antigen_profile_fill");

    return await new Promise<ProfileFieldFillEntry[]>((resolve) => {
      const entries: ProfileFieldFillEntry[] = [];
      const fields = fillRequest.requested_fields;
      let fieldIdx = 0;
      let msgId = 1;
      let sessionId: string | null = null;
      let phase: "attach" | "resolve" | "iframe_check" | "input_box_lookup" | "input_pointer" | "select_fill" | "input_focus" | "input_typing" | "input_typing_verify" | "input_insert" | "input_blur" | "input_setter_fallback" = "attach";
      // Stable selector for the current field, set once after the resolve phase and reused by every
      // downstream eval so id regeneration between evals cannot break the fill.
      let currentSelectorExpr = "null";
      // Field-aware formatted value for the current field, computed once in the resolve phase from
      // the matched candidate's metadata (e.g. phone country-code stripping / mask shaping). This is
      // what gets injected; the raw canonical is still used only for the masked agent summary.
      let currentFillValue = "";

      // Track CDP command IDs for unambiguous response routing.
      let attachMsgId: number | null = null;
      let insertMsgId: number | null = null;
      let typingVerifyMsgId: number | null = null;

      const timer = setTimeout(() => {
        ws.terminate();
        // Return entries collected so far, mark remaining as failed
        for (let i = fieldIdx; i < fields.length; i++) {
          entries.push({
            key: fields[i].key,
            field_filled: false,
            status: "failed",
            raw_profile_value_revealed_to_agent: false,
            error: "CDP fill timed out after 30 seconds.",
          });
        }
        resolve(entries);
      }, 30_000);

      const ws = new WebSocket(browserWsUrl);

      const send = (method: string, params: Record<string, unknown> = {}, sid?: string) => {
        const id = msgId++;
        const msg: Record<string, unknown> = { id, method, params };
        if (sid) msg.sessionId = sid;
        ws.send(JSON.stringify(msg));
        return id;
      };

      // Dev-only: ANTIGEN_BROWSER_SLOW_MO_MS adds extra delay per pointer event for visual verification.
      const slowMoMs = parseInt(process.env.ANTIGEN_BROWSER_SLOW_MO_MS ?? "0", 10) || 0;
      const debugOverlay = process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true";
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms) + slowMoMs));

      const recordFilled = (rawValue: string) => {
        const field = fields[fieldIdx];
        entries.push({
          key: field.key,
          field_filled: true,
          status: "filled",
          masked_summary: maskProfileValue(field.key, rawValue),
          raw_profile_value_revealed_to_agent: false,
        });
        timing.mark(`field_${field.key}`);
        fieldIdx++;
        advanceField();
      };

      const recordFailed = (error: string) => {
        const field = fields[fieldIdx];
        entries.push({
          key: field.key,
          field_filled: false,
          status: "failed",
          raw_profile_value_revealed_to_agent: false,
          error,
        });
        timing.mark(`field_${field.key}`);
        fieldIdx++;
        advanceField();
      };

      // Semantic resolution produced no confident, kind-consistent match for this field.
      const recordNotFound = (reason: string) => {
        const field = fields[fieldIdx];
        entries.push({
          key: field.key,
          field_filled: false,
          status: "not_found",
          raw_profile_value_revealed_to_agent: false,
          error: `Field resolution failed for kind '${field.key}': ${reason}.`,
        });
        timing.mark(`field_${field.key}`);
        fieldIdx++;
        advanceField();
      };

      const advanceField = () => {
        if (fieldIdx >= fields.length) {
          clearTimeout(timer);
          ws.close();
          timing.end({
            field_count: fields.length,
            filled_count: entries.filter((e) => e.field_filled).length,
          });
          resolve(entries);
          return;
        }
        // Resolve-once: enumerate candidate fields (metadata only). Scoring + kind verification
        // happen in TS when the result returns. No selector is trusted blindly here.
        currentSelectorExpr = "null";
        phase = "resolve";
        send("Runtime.evaluate", { expression: ENUMERATE_CANDIDATES_JS, returnByValue: true }, sessionId!);
      };

      ws.on("open", () => {
        attachMsgId = send("Target.attachToTarget", { targetId: pageTarget.id, flatten: true });
      });

      ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        const id = msg.id as number | undefined;
        const result = msg.result as Record<string, unknown> | undefined;

        // Attach response — identified by tracked message ID.
        if (id === attachMsgId && result?.sessionId && !sessionId) {
          sessionId = result.sessionId as string;
          timing.mark("connect_attach");
          advanceField();
          return;
        }

        // Input.insertText response — result is empty {}, not a Runtime.evaluate shape.
        if (id === insertMsgId) {
          insertMsgId = null;
          const field = fields[fieldIdx];
          const selectorExpr = currentSelectorExpr;
          if (msg.error) {
            // Input.insertText not supported — fall back to native-setter fill (value embedded in JS).
            // Drive the full controlled-component sequence (focus→input→change→blur) so React/Vue
            // validators refresh. Use the field-aware formatted value, not the raw canonical.
            const resolvedValue = currentFillValue;
            const setterFallbackExpr = `(function() {
              var el = ${selectorExpr};
              if (!el) return { ok: false, reason: 'element not found' };
              try { el.focus(); } catch (e) {}
              el.dispatchEvent(new Event('focus', { bubbles: true }));
              var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
              setter.call(el, ${JSON.stringify(resolvedValue)});
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
              el.setAttribute('data-antigen-filled', 'true');
              return { ok: true };
            })()`;
            phase = "input_setter_fallback";
            send("Runtime.evaluate", { expression: setterFallbackExpr, returnByValue: true }, sessionId!);
          } else {
            // Insert succeeded — dispatch change/blur and mark filled.
            const blurExpr = `(function() {
              var el = ${selectorExpr};
              if (!el) return { ok: false, reason: 'element not found' };
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
              el.setAttribute('data-antigen-filled', 'true');
              return { ok: true };
            })()`;
            phase = "input_blur";
            send("Runtime.evaluate", { expression: blurExpr, returnByValue: true }, sessionId!);
          }
          return;
        }

        const evalResult = result?.result as Record<string, unknown> | undefined;
        if (evalResult?.type === "object" && evalResult?.value !== undefined && sessionId) {
          const field = fields[fieldIdx];

          // Resolve phase — the eval returned an array of candidate descriptors (metadata only).
          if (phase === "resolve") {
            const descriptors = (evalResult.value as ProfileFieldCandidate[]) ?? [];
            const resolution = pickProfileFieldCandidate(field.key, descriptors, {
              selector_hint: field.selector_hint,
              label: field.label,
              placeholder: field.placeholder,
            });
            if (!resolution.fill_id) {
              recordNotFound(resolution.reason ?? "NO_CONFIDENT_MATCH");
              return;
            }
            // Format the canonical value for THIS field using the matched candidate's metadata
            // (e.g. phone country-code stripping / mask shaping). Raw canonical stays for masking.
            const matched = descriptors.find((d) => d.fill_id === resolution.fill_id);
            currentFillValue = formatProfileValueForTarget(field.key, resolvedValues.get(field.key) ?? "", {
              type: matched?.type,
              autocomplete: matched?.autocomplete,
              placeholder: matched?.placeholder,
              maxlength: matched?.maxlength ?? null,
              pattern: matched?.pattern ?? null,
            });
            currentSelectorExpr = fillIdSelectorExpr(resolution.fill_id);
            // Include tagName so the next handler can branch on SELECT vs INPUT.
            const iframeCheck = `(function() {
              var el = ${currentSelectorExpr};
              if (!el) return { ok: false, reason: 'element not found' };
              var node = el;
              while (node.parentNode) {
                if (node.tagName === 'IFRAME') return { ok: false, reason: 'IFRAME_NOT_SUPPORTED' };
                node = node.parentNode;
              }
              return { ok: true, tagName: el.tagName };
            })()`;
            phase = "iframe_check";
            send("Runtime.evaluate", { expression: iframeCheck, returnByValue: true }, sessionId);
            return;
          }

          const val = evalResult.value as { ok?: boolean; reason?: string; tagName?: string };

          if (phase === "iframe_check") {
            if (!val?.ok) {
              recordFailed(`CDP iframe check: ${val?.reason ?? "unknown"}`);
              return;
            }
            const selectorExpr = currentSelectorExpr;
            const resolvedValue = currentFillValue;

            if (val.tagName === "SELECT") {
              // SELECT element — select the actual option (value + selectedIndex), then drive the
              // full controlled-component event sequence (focus→input→change→blur) so React/Vue
              // validators that key off "touched"/blur clear. Read back to verify the option truly
              // committed; never fake success. No DOM value masking — checkout pages must read it.
              const selectFillExpr = `(function() {
                var el = ${selectorExpr};
                if (!el) return { ok: false, reason: 'element not found' };
                var rawVal = ${JSON.stringify(resolvedValue)};
                var stateMap = ${JSON.stringify(US_STATE_MAP)};
                var stateRevMap = ${JSON.stringify(US_STATE_REV_MAP)};
                var countryMap = ${JSON.stringify(COUNTRY_MAP)};
                var countryRevMap = ${JSON.stringify(COUNTRY_REV_MAP)};
                var lower = rawVal.toLowerCase().trim();
                var upper = rawVal.toUpperCase();
                var dashIdx = rawVal.indexOf('-');
                var strippedUpper = dashIdx > 0 ? rawVal.slice(dashIdx + 1).toUpperCase() : upper;
                var opts = Array.from(el.options);
                function findIdx(needle) {
                  for (var k = 0; k < opts.length; k++) {
                    var o = opts[k];
                    if (String(o.value).toLowerCase() === needle || String(o.text).toLowerCase().trim() === needle) return k;
                  }
                  return -1;
                }
                var idx = findIdx(lower);
                if (idx === -1) {
                  var alt = stateMap[upper] || stateMap[strippedUpper] || stateRevMap[lower] || countryMap[upper] || countryRevMap[lower];
                  if (alt) idx = findIdx(alt.toLowerCase().trim());
                }
                if (idx === -1) return { ok: false, reason: 'select_option_not_found' };
                var match = opts[idx];
                try { el.focus(); } catch (e) {}
                el.dispatchEvent(new Event('focus', { bubbles: true }));
                el.selectedIndex = idx;
                var sel = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
                if (sel && sel.set) { sel.set.call(el, match.value); } else { el.value = match.value; }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
                el.setAttribute('data-antigen-filled', 'true');
                // Read back: the option must actually be committed (non-placeholder).
                var committed = (el.value === match.value) && (el.selectedIndex === idx) && el.selectedIndex >= 0 && String(match.value).length > 0;
                var ariaInvalid = el.getAttribute('aria-invalid') === 'true';
                if (!committed) return { ok: false, reason: 'select_commit_unverified' };
                return { ok: true, verified: true, aria_invalid: ariaInvalid };
              })()`;
              phase = "select_fill";
              send("Runtime.evaluate", { expression: selectFillExpr, returnByValue: true }, sessionId);
            } else {
              // INPUT element — get element box for native pointer focus before typing.
              // No secret in this expression.
              const boxLookupExpr = `(function() {
                try {
                  var el = ${selectorExpr};
                  if (!el) return { ok: false, reason: 'element_not_found' };
                  el.scrollIntoView({ block: 'center', inline: 'center' });
                  var r = el.getBoundingClientRect();
                  if (r.width === 0 && r.height === 0) return { ok: false, reason: 'zero_box' };
                  return {
                    ok: true,
                    box: { x: r.left, y: r.top, width: r.width, height: r.height },
                    viewport: { width: window.innerWidth, height: window.innerHeight }
                  };
                } catch (e) { return { ok: false, reason: String(e) }; }
              })()`;
              phase = "input_box_lookup";
              send("Runtime.evaluate", { expression: boxLookupExpr, returnByValue: true }, sessionId);
            }
            return;
          }

          if (phase === "input_box_lookup") {
            const boxVal = val as {
              ok?: boolean;
              box?: ElementBox;
              viewport?: { width: number; height: number };
            } | undefined;

            const selectorExpr = currentSelectorExpr;
            const focusExpr = `(function() {
              var el = ${selectorExpr};
              if (!el) return { ok: false, reason: 'element not found' };
              el.scrollIntoView({ block: 'nearest' });
              el.focus();
              var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              setter.call(el, '');
              el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
              return { ok: true };
            })()`;

            const stateKey = fillRequest.browser_session_id ?? fillRequest.fill_request_id ?? "default";
            const doPointerThenFocus = async () => {
              if (boxVal?.ok && boxVal?.box) {
                try {
                  const pointerSend = (method: string, params: Record<string, unknown>) => {
                    send(method, params, sessionId!);
                  };
                  const state = getOrCreateFillPointerState(stateKey);

                  // Sync from session — load latest saved position for this task browser session.
                  if (fillRequest.browser_session_id) {
                    const saved = getTaskBrowserSessionPointerState(fillRequest.browser_session_id, fillRequest.user_id);
                    if (saved?.initialized) {
                      state.current_x = saved.x;
                      state.current_y = saved.y;
                      console.log("[PointerState] loaded", {
                        browser_session_id: fillRequest.browser_session_id,
                        x: saved.x,
                        y: saved.y,
                        initialized: true,
                      });
                    }
                  }

                  // Initialize from viewport center if pointer is still at origin.
                  if (state.current_x === 0 && state.current_y === 0) {
                    if (boxVal.viewport) {
                      state.current_x = Math.round(boxVal.viewport.width * 0.5);
                      state.current_y = Math.round(boxVal.viewport.height * 0.5);
                      console.log("[PointerState] initialized", {
                        browser_session_id: fillRequest.browser_session_id ?? null,
                        x: state.current_x,
                        y: state.current_y,
                        source: "viewport_center",
                      });
                    } else {
                      state.current_x = 80;
                      state.current_y = 80;
                      console.log("[PointerState] initialized", {
                        browser_session_id: fillRequest.browser_session_id ?? null,
                        x: state.current_x,
                        y: state.current_y,
                        source: "fallback",
                      });
                    }
                  }

                  if (boxVal.viewport) {
                    state.viewport_width = boxVal.viewport.width;
                    state.viewport_height = boxVal.viewport.height;
                  }
                  phase = "input_pointer"; // guard against stray CDP errors during pointer dispatch
                  await clickBoxWithPointer(state, boxVal.box, pointerSend, sleep, {
                    debugOverlay,
                    templateTraces: getLoadedPointerTraces(),
                    purpose: "input_focus",
                  });

                  // Persist final pointer position back to the task browser session.
                  if (fillRequest.browser_session_id) {
                    setTaskBrowserSessionPointerState(fillRequest.browser_session_id, fillRequest.user_id, {
                      x: state.current_x,
                      y: state.current_y,
                      initialized: true,
                      updated_at: new Date().toISOString(),
                    });
                    console.log("[PointerState] saved", {
                      browser_session_id: fillRequest.browser_session_id,
                      x: state.current_x,
                      y: state.current_y,
                    });
                  }
                } catch {
                  // Native pointer focus failed — proceed to fill without it.
                }
              }
              phase = "input_focus";
              send("Runtime.evaluate", { expression: focusExpr, returnByValue: true }, sessionId!);
            };

            doPointerThenFocus().catch(() => {
              phase = "input_focus";
              send("Runtime.evaluate", { expression: focusExpr, returnByValue: true }, sessionId!);
            });
            return;
          }

          if (phase === "input_focus") {
            if (!val?.ok) {
              recordFailed(`CDP evaluate (focus): ${val?.reason ?? "element not found"}`);
              return;
            }
            // Focus succeeded. The field-aware formatted value (e.g. national phone digits) is what
            // gets typed so masked checkout inputs format correctly instead of shifting the country
            // code. The raw canonical is still used only for the masked agent summary.
            const resolvedValue = currentFillValue;
            const selectorExpr = currentSelectorExpr;

            // ANTIGEN_INPUT_REALISM=fast/disabled/false → preserve the legacy bulk Input.insertText.
            if (getInputRealismMode() === "direct") {
              phase = "input_insert";
              insertMsgId = send("Input.insertText", { text: resolvedValue }, sessionId!);
              return;
            }

            // Realistic path — type the value the way a human would, character-by-character via CDP
            // key events (the same shared engine the protected-card primitive uses). The value flows
            // only through CDP key params, never a JS expression. Acceptance is verified separately
            // by a post-typing Runtime.evaluate (el.value.length > 0) — the value is never read back.
            // phase "input_typing" guards stray key-event acks/errors from failing the field, mirroring
            // the input_pointer guard. Fallback ladder: key events → Input.insertText → native setter.
            phase = "input_typing";
            const sendForTyping = (method: string, params: Record<string, unknown>) => {
              send(method, params, sessionId!);
            };
            const typingVerifyExpr = `(function() {
              var el = ${selectorExpr};
              if (!el) return { ok: false, reason: 'element_not_found' };
              return { ok: el.value.length > 0, reason: el.value.length > 0 ? 'value_present' : 'empty_after_typing' };
            })()`;
            typeCharsViaCDP(sendForTyping, sleep, {
              value: resolvedValue,
              fieldKind: "username", // profile fields are non-secret → faster jitter profile
              injectionRequestId: fillRequest.fill_request_id,
              domain: fillRequest.domain,
            })
              .then((typingResult) => {
                if (typingResult.success) {
                  phase = "input_typing_verify";
                  typingVerifyMsgId = send(
                    "Runtime.evaluate",
                    { expression: typingVerifyExpr, returnByValue: true },
                    sessionId!,
                  );
                } else {
                  // Synchronous send failure mid-typing — fall back to bulk insert.
                  phase = "input_insert";
                  insertMsgId = send("Input.insertText", { text: resolvedValue }, sessionId!);
                }
              })
              .catch(() => {
                phase = "input_insert";
                insertMsgId = send("Input.insertText", { text: resolvedValue }, sessionId!);
              });
            return;
          }

          if (phase === "input_typing_verify") {
            const resolvedValue = currentFillValue;
            const selectorExpr = currentSelectorExpr;
            if (val?.ok) {
              // Typing accepted — dispatch change/blur and mark filled.
              const blurExpr = `(function() {
                var el = ${selectorExpr};
                if (!el) return { ok: false, reason: 'element not found' };
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
                el.setAttribute('data-antigen-filled', 'true');
                return { ok: true };
              })()`;
              phase = "input_blur";
              send("Runtime.evaluate", { expression: blurExpr, returnByValue: true }, sessionId);
            } else {
              // Field empty after key events — fall back to bulk Input.insertText.
              phase = "input_insert";
              insertMsgId = send("Input.insertText", { text: resolvedValue }, sessionId!);
            }
            return;
          }

          if (phase === "input_blur" || phase === "input_setter_fallback") {
            const rawValue = resolvedValues.get(field.key) ?? "";
            if (val?.ok) {
              recordFilled(rawValue);
            } else {
              recordFailed(`CDP evaluate: ${val?.reason ?? "unknown"}`);
            }
            return;
          }

          if (phase === "select_fill") {
            const rawValue = resolvedValues.get(field.key) ?? "";
            if (val?.ok) {
              recordFilled(rawValue);
            } else {
              recordFailed(`CDP evaluate: ${val?.reason ?? "unknown"}`);
            }
            return;
          }
        }

        if (msg.error) {
          // Ignore CDP errors during async pointer/key dispatch — these are from fire-and-forget
          // Input.dispatchMouseEvent / Input.dispatchKeyEvent calls and must not fail the field fill.
          if (phase === "input_pointer" || phase === "input_typing") return;
          const field = fields[fieldIdx];
          if (field) {
            recordFailed(`CDP error: ${JSON.stringify(msg.error)}`);
          }
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        for (let i = fieldIdx; i < fields.length; i++) {
          entries.push({
            key: fields[i].key,
            field_filled: false,
            status: "failed",
            raw_profile_value_revealed_to_agent: false,
            error: `WebSocket error: ${(err as Error).message}`,
          });
        }
        resolve(entries);
      });
    });
  } catch (err: unknown) {
    return fillRequest.requested_fields.map((f) => ({
      key: f.key,
      field_filled: false,
      status: "failed" as const,
      raw_profile_value_revealed_to_agent: false as const,
      error: err instanceof Error ? err.message : "CDP profile fill failed",
    }));
  }
}
