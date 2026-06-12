/**
 * Antigen Snapshot Page Map (v2) — agent-readable page semantics.
 *
 * Turns the internal snapshot element records (which carry boxes + full
 * disambiguation context) into a compact, action-oriented page map for the
 * agent: a page summary, prioritized/categorized action refs, per-ref action
 * hints, qualitative viewport status, forms, best-effort product cards,
 * warning/modal detection, and evidence metadata.
 *
 * This module is the v2 "brain": pure, deterministic, no DOM, no CDP, no I/O
 * beyond a sha256 of clipped visible text. It is fully unit-testable without a
 * browser.
 *
 * SECURITY / LEAK BOUNDARY (asserted in tests):
 * - NO raw geometry ever leaves this module. Element boxes (x/y/width/height,
 *   doc_x/doc_y) and raw viewport/scroll numbers are consumed only to derive
 *   QUALITATIVE fields (viewport_status, scroll_required, current_scroll). No
 *   numeric dimension/coordinate field is ever emitted.
 * - `context.nearby_text` is internal-only. Product cards emit DERIVED, clipped
 *   title/price/rating strings — never the verbatim nearby_text, and never a
 *   `nearby_text` field.
 * - No cdp_url, user_data_dir, profile_key, pass_id, secret_ref, passwords,
 *   cookies, storage, or full href. Links surface href_path only (already
 *   path-stripped upstream).
 */

import { createHash } from "node:crypto";
import type { ActionIntent, HumanVerificationChallengeType } from "@aegis/types";
import { classifyActionIntent } from "../detection/actionIntent.js";
import { isHumanVerificationEnabled } from "./humanVerificationState.js";
import type { AntigenSnapshotElementRecord } from "./antigenSnapshotStore.js";
import type { AntigenPageMeta, AntigenOverlayType, AntigenCandidateKind } from "./antigenSnapshotRuntime.js";
import { normalizeName } from "./antigenSnapshotRuntime.js";
import {
  OVERLAY_TYPE_VALUES,
  type ClickVerification,
  type OverlayProbeAction,
  type FillProbeAction,
  type PageStateProbe,
} from "./antigenClickVerification.js";
import type { ProtectedIframeFieldKind } from "./protectedIframeRedaction.js";

// ─── Public types ────────────────────────────────────────────────────────────

export type PageKind =
  | "search_results"
  | "product_page"
  | "article"
  | "discussion_thread"
  | "cart"
  | "form"
  | "generic";

export type ViewportStatus =
  | "visible"
  | "above_viewport"
  | "below_viewport"
  | "offscreen"
  | "unknown";

export type ActionHint =
  | "browser_click"
  | "browser_type"
  | "browser_scroll_to_ref_then_click"
  | "browser_scroll_to_ref"
  | "browser_type_then_submit"
  | "none";

export type StabilityHint = "fresh" | "may_stale_after_navigation" | "unknown";

export type ActionPriority = "high" | "medium" | "low";

export interface RankedAction {
  ref: string;
  role: string | null;
  name: string;
  priority: ActionPriority;
  reason: string;
  action_hint: ActionHint;
  viewport_status: ViewportStatus;
  scroll_required: boolean;
}

export interface FormGroup {
  label?: string;
  input_refs: string[];
  submit_refs: string[];
  action_hint: "browser_type_then_submit" | "browser_type";
}

export interface ProductCard {
  title?: string;
  price_text?: string;
  rating_text?: string;
  primary_ref?: string;
  add_ref?: string;
  details_ref?: string;
  refs: string[];
}

export interface WarningOrModal {
  kind:
    | "cookie_banner"
    | "modal"
    | "cart_drawer"
    | "flyout"
    | "chat_widget"
    | "login_prompt"
    | "login_checkout"
    | "human_verification"
    | "toast"
    | "unknown_overlay";
  /** Structural overlay kind when this warning came from overlay detection. */
  overlay_type?: AntigenOverlayType;
  /** Accessible title of the overlay container (value-free). */
  modal_title?: string;
  /** True when the overlay blocks the page (aria-modal / native modal / backdrop). */
  blocking?: boolean;
  message?: string;
  /** Close/dismiss controls. `close_refs` is an alias kept alongside for clarity. */
  dismiss_refs?: string[];
  close_refs?: string[];
  /** Primary call-to-action refs inside the overlay (e.g. "Continue", "Sign in"). */
  primary_action_refs?: string[];
  action_hint?: "browser_click";
}

/**
 * Summary of the dominant active overlay on the page. Built only from real
 * overlay members (background-behind-modal markers excluded). Exposes ONLY safe
 * refs + the value-free accessible title — no geometry, no internal flags.
 */
export interface ActiveOverlay {
  present: boolean;
  overlay_type: AntigenOverlayType;
  blocking: boolean;
  modal_title?: string;
  dismiss_refs: string[];
  primary_action_refs: string[];
  action_refs: string[];
}

export interface PageSummary {
  title?: string;
  url_host?: string;
  url_path?: string;
  page_kind: PageKind;
  visible_heading?: string;
  visible_text_excerpt?: string;
}

export interface CurrentScroll {
  position: "top" | "middle" | "bottom" | "unknown";
  more_above: boolean;
  more_below: boolean;
}

export interface RefStatus {
  viewport_status: ViewportStatus;
  scroll_required: boolean;
  stability_hint: StabilityHint;
}

export interface ActionHintEntry {
  ref: string;
  action_hint: ActionHint;
  reason?: string;
}

export interface AntigenPageMap {
  page_summary: PageSummary;
  current_scroll: CurrentScroll;
  primary_actions: RankedAction[];
  secondary_actions: RankedAction[];
  navigation: RankedAction[];
  forms: FormGroup[];
  product_cards: ProductCard[];
  warnings_or_modals: WarningOrModal[];
  /** Dominant active overlay summary; omitted when no overlay is present. */
  active_overlay?: ActiveOverlay;
  action_hints: ActionHintEntry[];
  /** Per-ref qualitative status — merged into external elements by the endpoint. */
  ref_status: Record<string, RefStatus>;
  evidence_partial: {
    element_count: number;
    clickable_count: number;
    typeable_count: number;
    visible_text_hash?: string;
  };
}

export interface BuildPageMapParams {
  records: AntigenSnapshotElementRecord[];
  pageMeta?: AntigenPageMeta;
  /** Whether the snapshot was captured viewport-only (extraction default true). */
  viewportOnly: boolean;
  url: string | null;
}

// ─── Bounds ──────────────────────────────────────────────────────────────────

const EXCERPT_MAX = 200;
const HEADING_MAX = 160;
const TITLE_MAX = 80;
const MESSAGE_MAX = 120;

function clip(s: string | null | undefined, max: number): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/** Host + path only (no query, no fragment). Mirrors sanitizeTraceUrl parsing. */
export function splitUrl(url: string | null): { host?: string; path?: string } {
  if (typeof url !== "string" || !url.trim()) return {};
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname || "/" };
  } catch {
    return {};
  }
}

// ─── Label patterns (general, site-agnostic) ─────────────────────────────────

interface PrimaryPattern {
  re: RegExp;
  priority: ActionPriority;
  reason: string;
}

// Matched against normalized_name (lowercase, punctuation stripped). Site- and
// brand-agnostic. `\badd\b` avoids matching "address".
const PRIMARY_PATTERNS: PrimaryPattern[] = [
  { re: /\badd\b[\s\S]{0,12}\b(cart|bag|basket)\b/, priority: "high", reason: "primary_purchase_action" },
  { re: /\bbuy\b/, priority: "high", reason: "primary_purchase_action" },
  { re: /\b(checkout|check out|place order|placeorder)\b/, priority: "high", reason: "checkout_action" },
  { re: /\bsearch\b/, priority: "high", reason: "search_action" },
  { re: /\b(submit|confirm)\b/, priority: "medium", reason: "submit_action" },
  { re: /\b(continue|next)\b/, priority: "medium", reason: "continue_action" },
  { re: /\bsave\b/, priority: "medium", reason: "save_action" },
  { re: /\b(sign in|log in|login)\b/, priority: "medium", reason: "auth_action" },
  { re: /\b(accept|agree|allow)\b/, priority: "medium", reason: "confirm_action" },
  { re: /\bok\b/, priority: "medium", reason: "confirm_action" },
  { re: /\b(close|dismiss|decline|reject)\b/, priority: "low", reason: "dismiss_action" },
];

/** A primary/secondary call-to-action name (any non-dismiss PRIMARY_PATTERN). */
function isPrimaryActionName(normalizedName: string): boolean {
  if (!normalizedName) return false;
  for (const p of PRIMARY_PATTERNS) {
    if (p.priority !== "low" && p.re.test(normalizedName)) return true;
  }
  return false;
}

/** Bump a priority one level toward high (low→medium, medium/high→high). */
function bumpPriority(p: ActionPriority): ActionPriority {
  return p === "low" ? "medium" : "high";
}

/** A record that belongs to a real (non-background) overlay container. */
function isOverlayMember(r: AntigenSnapshotElementRecord): boolean {
  return !!r.overlay && r.overlay.background !== true;
}

/**
 * Cookie-consent control refs. Cookie banners are surfaced as their own
 * `cookie_banner` warning and must never count as the dominant `active_overlay`,
 * drive `blockingActive` demotion, or steal modal action prioritization — even
 * when a site renders consent as a `role=dialog`.
 */
function cookieRefSet(records: AntigenSnapshotElementRecord[]): Set<string> {
  return new Set(records.filter((r) => COOKIE_RE.test(ctxText(r))).map((r) => r.ref));
}

/** A background-behind-modal record (inert / aria-hidden behind a modal). */
function isBackgroundRecord(r: AntigenSnapshotElementRecord): boolean {
  return !!r.overlay && (r.overlay.background === true || r.overlay.bg_hidden === true);
}

/** Inert background — truly non-interactive; excluded from action buckets. */
function isInertRecord(r: AntigenSnapshotElementRecord): boolean {
  return r.overlay?.in_inert === true;
}

const SUBMIT_LIKE = /\b(submit|confirm|search|continue|next|sign in|log in|login|save|go|apply)\b/;
const NAV_SECTION = /\b(nav|navigation|menu|footer|header|breadcrumb|sidebar)\b/;
const ADD_TO_CART = /\badd\b[\s\S]{0,12}\b(cart|bag|basket)\b/;
const PRICE_RE = /[$£€]\s?\d[\d.,]*/;
const RATING_RE = /\b\d(?:\.\d)?\s*(?:stars?|out of 5|\/\s?5)\b/i;

const COOKIE_RE = /\b(cookie|consent|gdpr)\b/i;
const COOKIE_DISMISS = /\b(accept|agree|allow|reject|decline|dismiss|got it|ok|close)\b/;
const LOGIN_PROMPT_RE = /\b(sign in|log in|login|create account)\b/i;
const CART_DRAWER_RE = /\b(cart|bag|basket)\b/i;
const MODAL_SECTION_RE = /\b(modal|dialog|overlay|popup|popover)\b/i;
const DISMISS_NAME = /\b(close|dismiss|no thanks|not now|maybe later|×|x)\b/;
// Chat/help/support widget — a nonblocking popover, never a login prompt or modal.
const CHAT_WIDGET_RE = /\b(chat|messenger|live\s*help|virtual\s*assistant|support\s*(widget|chat)|help\s*(widget|chat))\b/i;
// Guest / checkout affordances that, alongside a login option, mark a checkout
// method dialog (rather than a pure login prompt).
const GUEST_CHECKOUT_RE = /\b(guest|continue as guest|check\s?out|checkout|place order)\b/i;

// ─── Per-record qualitative status ───────────────────────────────────────────

function classifyViewport(
  record: AntigenSnapshotElementRecord,
  pageMeta: AntigenPageMeta | undefined,
  viewportOnly: boolean,
): ViewportStatus {
  const box = record.box;
  const vh = pageMeta?.viewport_h;
  if (typeof vh === "number" && vh > 0 && box) {
    const top = box.y;
    const bottom = box.y + box.height;
    if (bottom <= 0) return "above_viewport";
    if (top >= vh) return "below_viewport";
    return "visible";
  }
  // Without a known viewport height we cannot place the element precisely. If the
  // snapshot was viewport-only, every returned element intersected the viewport
  // by construction, so "visible" is accurate; otherwise we cannot tell.
  return viewportOnly ? "visible" : "unknown";
}

function stabilityFor(record: AntigenSnapshotElementRecord): StabilityHint {
  // Links/navigation likely change the page; overlay dismiss buttons mutate the
  // DOM. Plain buttons/inputs are treated as fresh for this snapshot.
  if (record.kind === "link") return "may_stale_after_navigation";
  const sectionLow = (record.context?.section ?? "").toLowerCase();
  if (NAV_SECTION.test(sectionLow)) return "may_stale_after_navigation";
  return "fresh";
}

function hintFor(record: AntigenSnapshotElementRecord, status: ViewportStatus): ActionHint {
  if (record.typeable) return "browser_type";
  if (record.clickable) {
    if (status === "below_viewport" || status === "above_viewport" || status === "offscreen") {
      return "browser_scroll_to_ref_then_click";
    }
    return "browser_click";
  }
  return "none";
}

// ─── Action classification ───────────────────────────────────────────────────

type ActionCategory = "primary" | "secondary" | "navigation" | "form" | "none";

function classify(record: AntigenSnapshotElementRecord): {
  category: ActionCategory;
  priority: ActionPriority;
  reason: string;
} {
  if (record.typeable) return { category: "form", priority: "medium", reason: "form_field" };

  const n = record.normalized_name;
  for (const p of PRIMARY_PATTERNS) {
    if (n && p.re.test(n)) return { category: "primary", priority: p.priority, reason: p.reason };
  }

  if (record.kind === "link") {
    const sectionLow = (record.context?.section ?? "").toLowerCase();
    if (NAV_SECTION.test(sectionLow)) {
      return { category: "navigation", priority: "low", reason: "navigation_link" };
    }
    if (!n) return { category: "navigation", priority: "low", reason: "unlabeled_link" };
    return { category: "secondary", priority: "medium", reason: "content_link" };
  }

  if (record.clickable) {
    if (!n) return { category: "secondary", priority: "low", reason: "unlabeled_control" };
    return { category: "secondary", priority: "medium", reason: "secondary_action" };
  }

  return { category: "none", priority: "low", reason: "non_interactive" };
}

const PRIORITY_RANK: Record<ActionPriority, number> = { high: 0, medium: 1, low: 2 };

// ─── Forms ───────────────────────────────────────────────────────────────────

function buildForms(records: AntigenSnapshotElementRecord[]): FormGroup[] {
  const inputs = records.filter((r) => r.typeable);
  if (inputs.length === 0) return [];

  const submitButtons = records.filter(
    (r) => r.clickable && !r.typeable && r.normalized_name && SUBMIT_LIKE.test(r.normalized_name),
  );

  // Group inputs by their disambiguation section so distinct forms (e.g. a
  // search bar vs. a sign-in form) surface separately. Bucket "" = ungrouped.
  const groups = new Map<string, AntigenSnapshotElementRecord[]>();
  for (const input of inputs) {
    const key = (input.context?.section ?? "").trim();
    const arr = groups.get(key) ?? [];
    arr.push(input);
    groups.set(key, arr);
  }

  const forms: FormGroup[] = [];
  for (const [section, groupInputs] of groups) {
    // Submit buttons sharing this section; else fall back to any submit-like button.
    const sectioned = submitButtons.filter((b) => (b.context?.section ?? "").trim() === section);
    const submits = (sectioned.length > 0 ? sectioned : submitButtons).map((b) => b.ref);
    forms.push({
      label: clip(section, TITLE_MAX),
      input_refs: groupInputs.map((i) => i.ref),
      submit_refs: submits,
      action_hint: submits.length > 0 ? "browser_type_then_submit" : "browser_type",
    });
  }
  return forms;
}

// ─── Product cards (best-effort; never throws, never blocks) ─────────────────

function stripPrice(s: string): string {
  return s.replace(PRICE_RE, "").replace(/\s+/g, " ").trim();
}

function buildProductCards(records: AntigenSnapshotElementRecord[]): ProductCard[] {
  try {
    const addButtons = records.filter(
      (r) => r.clickable && r.normalized_name && ADD_TO_CART.test(r.normalized_name),
    );
    if (addButtons.length === 0) return [];

    const links = records.filter((r) => r.kind === "link");
    const cards: ProductCard[] = [];

    for (const btn of addButtons) {
      const label = btn.context?.label ?? "";
      const nearby = btn.context?.nearby_text ?? "";
      const priceMatch = (label.match(PRICE_RE) ?? nearby.match(PRICE_RE))?.[0];
      const ratingMatch = (label.match(RATING_RE) ?? nearby.match(RATING_RE))?.[0];
      const title = clip(stripPrice(label), TITLE_MAX);

      // Pair a sibling product link that shares this card's label, if any.
      const detail = label
        ? links.find((l) => (l.context?.label ?? "") === label && l.ref !== btn.ref)
        : undefined;

      const refs = [detail?.ref, btn.ref].filter((r): r is string => typeof r === "string");
      const card: ProductCard = { refs };
      if (title) card.title = title;
      if (priceMatch) card.price_text = clip(priceMatch, 24);
      if (ratingMatch) card.rating_text = clip(ratingMatch, 24);
      if (detail) {
        card.details_ref = detail.ref;
        card.primary_ref = detail.ref;
      }
      card.add_ref = btn.ref;
      cards.push(card);
    }
    return cards;
  } catch {
    // Product grouping is best-effort — never degrade the core snapshot.
    return [];
  }
}

// ─── Warnings / modals ───────────────────────────────────────────────────────

function ctxText(r: AntigenSnapshotElementRecord): string {
  return `${r.context?.section ?? ""} ${r.context?.label ?? ""} ${r.name}`;
}

/** Section/label/name + the overlay's accessible title — used for classification. */
function overlayGroupText(group: AntigenSnapshotElementRecord[]): string {
  const title = group.map((r) => r.overlay?.modal_title).find(Boolean) ?? "";
  return `${title} ${group.map(ctxText).join(" ")}`;
}

/**
 * Map a structural overlay group to the agent-facing warning kind. Precedence is
 * STRUCTURAL-TYPE-FIRST so a single "Log in" affordance can no longer collapse a
 * toast, cart flyout, or checkout dialog into `login_prompt`:
 *   toast → chat_widget → drawer(flyout/cart) → login_checkout (login+guest) →
 *   modal/dialog (login_prompt only when login-DOMINANT) → cart/login fallbacks.
 */
function warningKindFor(
  overlayType: AntigenOverlayType,
  group: AntigenSnapshotElementRecord[],
): WarningOrModal["kind"] {
  const text = overlayGroupText(group);
  const hasLogin = LOGIN_PROMPT_RE.test(text);
  const hasCart = CART_DRAWER_RE.test(text);
  const hasGuestCheckout = GUEST_CHECKOUT_RE.test(text);

  // Human-verification challenge — FIRST, before any login/cart/toast logic:
  // a "Press & Hold to confirm you are a human" modal must never collapse into
  // a generic modal/login prompt. Page-side classification (strong phrases on
  // structurally-blocking containers only) is the authority here.
  if (isHumanVerificationEnabled() && group.some((r) => r.overlay?.human_verification === true)) {
    return "human_verification";
  }

  // Transient confirmation/announcement — never a login prompt.
  if (overlayType === "toast") return "toast";
  // Chat/help/support widget — nonblocking popover, never a modal/login prompt.
  if (overlayType === "popover" && CHAT_WIDGET_RE.test(text)) return "chat_widget";
  // Slide-in panels: cart/bag drawers vs. generic flyouts.
  if (overlayType === "drawer") return hasCart ? "cart_drawer" : "flyout";
  // A dialog offering BOTH a login option and a guest/checkout path is a checkout
  // method chooser, not a pure login prompt.
  if (hasLogin && hasGuestCheckout) return "login_checkout";
  if (overlayType === "dialog" || overlayType === "alertdialog") {
    // `login_prompt` only when login is the dominant purpose (no cart/checkout/guest).
    if (hasLogin && !hasCart && !hasGuestCheckout) return "login_prompt";
    return "modal";
  }
  // Generic/popover overlays.
  if (CHAT_WIDGET_RE.test(text)) return "chat_widget";
  if (hasCart) return "cart_drawer";
  if (hasLogin && !hasCart && !hasGuestCheckout) return "login_prompt";
  return "unknown_overlay";
}

/** Group structural overlay members by overlay_type + accessible title. */
function groupOverlayMembers(
  members: AntigenSnapshotElementRecord[],
): AntigenSnapshotElementRecord[][] {
  const groups = new Map<string, AntigenSnapshotElementRecord[]>();
  for (const r of members) {
    const key = `${r.overlay?.overlay_type ?? ""}|${r.overlay?.modal_title ?? ""}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  return [...groups.values()];
}

function overlayDismissRefs(group: AntigenSnapshotElementRecord[]): string[] {
  return group
    .filter(
      (r) =>
        r.clickable &&
        (r.overlay?.is_dismiss === true ||
          (r.normalized_name && DISMISS_NAME.test(r.normalized_name))),
    )
    .map((r) => r.ref);
}

function overlayPrimaryRefs(group: AntigenSnapshotElementRecord[]): string[] {
  return group
    .filter(
      (r) => r.clickable && r.overlay?.is_dismiss !== true && isPrimaryActionName(r.normalized_name),
    )
    .map((r) => r.ref);
}

function buildWarnings(records: AntigenSnapshotElementRecord[]): WarningOrModal[] {
  const warnings: WarningOrModal[] = [];

  // Cookie banner: any control whose context/name mentions cookies/consent.
  const cookieControls = records.filter((r) => COOKIE_RE.test(ctxText(r)));
  const cookieRefs = new Set(cookieControls.map((r) => r.ref));
  if (cookieControls.length > 0) {
    const dismiss = cookieControls
      .filter((r) => r.clickable && r.normalized_name && COOKIE_DISMISS.test(r.normalized_name))
      .map((r) => r.ref);
    const message = clip(cookieControls.map((r) => r.context?.section).find(Boolean) ?? "Cookie consent prompt", MESSAGE_MAX);
    warnings.push({
      kind: "cookie_banner",
      ...(message ? { message } : {}),
      ...(dismiss.length > 0 ? { dismiss_refs: dismiss, close_refs: dismiss, action_hint: "browser_click" as const } : {}),
    });
  }

  // Structural overlays — driven by detected overlay membership (role=dialog,
  // aria-modal, native <dialog open>, popover, toast/live, drawer, top-layer).
  // Background-behind-modal markers and cookie controls are excluded.
  const members = records.filter((r) => isOverlayMember(r) && !cookieRefs.has(r.ref));
  for (const group of groupOverlayMembers(members)) {
    const overlayType = group[0].overlay!.overlay_type;
    const blocking = group.some((r) => r.overlay?.blocking === true);
    const modalTitle = group.map((r) => r.overlay?.modal_title).find(Boolean);
    const dismiss = overlayDismissRefs(group);
    const primary = overlayPrimaryRefs(group);
    const warning: WarningOrModal = {
      kind: warningKindFor(overlayType, group),
      overlay_type: overlayType,
      blocking,
    };
    const message = clip(modalTitle ?? "", MESSAGE_MAX);
    if (modalTitle) warning.modal_title = clip(modalTitle, MESSAGE_MAX);
    if (message) warning.message = message;
    if (dismiss.length > 0) {
      warning.dismiss_refs = dismiss;
      warning.close_refs = dismiss;
      warning.action_hint = "browser_click";
    }
    if (primary.length > 0) warning.primary_action_refs = primary;
    warnings.push(warning);
  }

  // Low-confidence fallback: a section keyword suggests a modal but structural
  // detection found nothing (e.g. a CSS-only overlay). Keeps prior behavior from
  // regressing without double-emitting when structural detection already fired.
  if (members.length === 0) {
    const modalControls = records.filter(
      (r) => MODAL_SECTION_RE.test(`${r.context?.section ?? ""}`) && !COOKIE_RE.test(ctxText(r)),
    );
    if (modalControls.length > 0) {
      const dismiss = modalControls
        .filter((r) => r.clickable && r.normalized_name && DISMISS_NAME.test(r.normalized_name))
        .map((r) => r.ref);
      const isLogin = modalControls.some((r) => LOGIN_PROMPT_RE.test(ctxText(r)));
      const isCart = modalControls.some((r) => CART_DRAWER_RE.test(`${r.context?.section ?? ""}`));
      const kind: WarningOrModal["kind"] = isLogin ? "login_prompt" : isCart ? "cart_drawer" : "modal";
      const message = clip(modalControls.map((r) => r.context?.section).find(Boolean) ?? "", MESSAGE_MAX);
      warnings.push({
        kind,
        ...(message ? { message } : {}),
        ...(dismiss.length > 0 ? { dismiss_refs: dismiss, close_refs: dismiss, action_hint: "browser_click" as const } : {}),
      });
    }
  }

  return warnings;
}

/**
 * Dominant active overlay summary. Among all structural overlay groups, prefers
 * blocking over nonblocking, then dialog/alertdialog, then the group with the
 * most members. Returns only safe refs + the value-free accessible title.
 */
function buildActiveOverlay(
  records: AntigenSnapshotElementRecord[],
  cookieRefs: Set<string>,
): ActiveOverlay | undefined {
  const members = records.filter((r) => isOverlayMember(r) && !cookieRefs.has(r.ref));
  if (members.length === 0) return undefined;

  let best: { group: AntigenSnapshotElementRecord[]; score: number } | undefined;
  for (const group of groupOverlayMembers(members)) {
    const blocking = group.some((r) => r.overlay?.blocking === true);
    const type = group[0].overlay!.overlay_type;
    const score =
      (blocking ? 1000 : 0) +
      (type === "dialog" || type === "alertdialog" ? 100 : 0) +
      group.length;
    if (!best || score > best.score) best = { group, score };
  }
  if (!best) return undefined;

  const group = best.group;
  const overlayType = group[0].overlay!.overlay_type;
  const blocking = group.some((r) => r.overlay?.blocking === true);
  const modalTitle = group.map((r) => r.overlay?.modal_title).find(Boolean);
  const out: ActiveOverlay = {
    present: true,
    overlay_type: overlayType,
    blocking,
    dismiss_refs: overlayDismissRefs(group),
    primary_action_refs: overlayPrimaryRefs(group),
    action_refs: group.filter((r) => r.clickable).map((r) => r.ref),
  };
  const title = clip(modalTitle ?? "", MESSAGE_MAX);
  if (title) out.modal_title = title;
  return out;
}

function isOverlayDismiss(record: AntigenSnapshotElementRecord, warnings: WarningOrModal[]): boolean {
  return warnings.some((w) => w.dismiss_refs?.includes(record.ref));
}

// ─── page_kind ───────────────────────────────────────────────────────────────

function inferPageKind(params: {
  records: AntigenSnapshotElementRecord[];
  pageMeta?: AntigenPageMeta;
  path?: string;
}): PageKind {
  const { records, pageMeta, path } = params;
  const text = `${pageMeta?.heading ?? ""} ${pageMeta?.text_excerpt ?? ""}`.toLowerCase();
  const pathLow = (path ?? "").toLowerCase();

  const names = records.map((r) => r.normalized_name).filter(Boolean);
  const hasAddToCart = names.some((n) => ADD_TO_CART.test(n));
  const hasCheckout = names.some((n) => /\b(checkout|check out|place order)\b/.test(n));
  const typeableCount = records.filter((r) => r.typeable).length;
  const linkCount = records.filter((r) => r.kind === "link").length;

  const cartLang = /\b(subtotal|your (cart|bag|basket)|cart total|order summary)\b/.test(text);
  if (cartLang && (hasCheckout || /\bcheckout\b/.test(text))) return "cart";
  if (hasAddToCart) return "product_page";
  if (/\/search/.test(pathLow) || /\b(results? for|showing \d+|search results)\b/.test(text)) {
    return "search_results";
  }
  if (typeableCount >= 3 && typeableCount >= linkCount) return "form";
  if (/\b(comments?|replies|reply|upvote|posted by|r\/)\b/.test(text)) return "discussion_thread";
  if (pageMeta?.heading && text.length > 400) return "article";
  return "generic";
}

// ─── current_scroll ──────────────────────────────────────────────────────────

function computeScroll(pageMeta: AntigenPageMeta | undefined): CurrentScroll {
  const sy = pageMeta?.scroll_y;
  const vh = pageMeta?.viewport_h;
  const docH = pageMeta?.doc_h;
  if (
    typeof sy !== "number" ||
    typeof vh !== "number" ||
    typeof docH !== "number" ||
    docH <= 0 ||
    vh <= 0
  ) {
    return { position: "unknown", more_above: false, more_below: false };
  }
  const maxScroll = Math.max(0, docH - vh);
  const moreAbove = sy > 4;
  const moreBelow = sy < maxScroll - 4;
  let position: CurrentScroll["position"] = "middle";
  if (!moreAbove) position = "top";
  else if (!moreBelow) position = "bottom";
  return { position, more_above: moreAbove, more_below: moreBelow };
}

// ─── visible_text_hash ───────────────────────────────────────────────────────

function hashVisibleText(excerpt: string | undefined): string | undefined {
  const norm = clip(excerpt, 600);
  if (!norm) return undefined;
  return createHash("sha256").update(norm.toLowerCase()).digest("hex").slice(0, 16);
}

// ─── Main builder ────────────────────────────────────────────────────────────

// ─── Active Surfaces v1 (ANTIGEN_ACTIVE_SURFACES, default-off) ────────────────
//
// Slice 1 of the surface model: promote structural overlay groups (dialogs,
// drawers, popovers, toasts) to first-class "active surfaces" with stable
// SEMANTIC identity (type + accessible title) and classified actions, so an
// agent facing an IKEA-style add-to-bag panel is steered toward the panel's
// stable primary action ("Go to shopping bag") instead of fighting a churning
// background/header ref. Read-only snapshot enrichment — click behavior is
// unchanged in this slice.
//
// SAFETY: built ONLY from data the snapshot already carries (overlay membership,
// accessible names, refs). No geometry, no selectors, no values, no internal
// flags ever leave this layer. `action_intent` comes from classifyActionIntent
// on STRUCTURAL metadata only; final/irreversible actions are listed with
// `requires_handoff: true` and are never recommended.

/** Active Surfaces flag — strictly opt-in; default off is byte-identical. */
export function isActiveSurfacesEnabled(): boolean {
  return process.env.ANTIGEN_ACTIVE_SURFACES === "true";
}

export type SurfaceActionClassification = "primary" | "dismiss" | "secondary";

export interface ActiveSurfaceAction {
  ref: string;
  name: string;
  kind: AntigenCandidateKind;
  classification: SurfaceActionClassification;
  /** Structural intent classification (navigation / cart_mutation / …). */
  action_intent: ActionIntent;
  /**
   * True when the intent is final / irreversible / uncertain — the action is
   * listed for visibility but must go through the existing handoff tools and is
   * never included in `recommended_actions`.
   */
  requires_handoff?: true;
}

export interface ActiveSurface {
  /** Per-snapshot id ("surf_1", …) in dominance order. Informational only. */
  surface_id: string;
  surface_type: AntigenOverlayType;
  /** Accessible title of the surface container (value-free, clipped). */
  title?: string;
  blocking: boolean;
  /** The surface exposes at least one dismiss-classified action. */
  dismissible: boolean;
  actions: ActiveSurfaceAction[];
  /**
   * Set when this surface is a human-verification challenge. Its controls are
   * never recommended and every action carries `requires_handoff` — clearing
   * the challenge goes through the Human Presence Relay, never browser_click.
   */
  surface_kind?: "human_verification";
  /** Challenge sub-type when surface_kind is "human_verification". */
  challenge_type?: HumanVerificationChallengeType;
  /** Literal true — only live user presence (Aegis UI relay) can clear this. */
  user_presence_required?: true;
}

export interface RecommendedSurfaceAction {
  ref: string;
  name: string;
  surface_id: string;
  classification: SurfaceActionClassification;
  reason: "active_surface_primary_action" | "active_surface_dismiss_action";
}

export interface ActiveSurfacesResult {
  surfaces: ActiveSurface[];
  /**
   * Actions from the DOMINANT recommendable surface only (never toasts or chat
   * widgets): primaries first, then dismisses. Advisory — Antigen never
   * auto-clicks; the agent still chooses.
   */
  recommended_actions: RecommendedSurfaceAction[];
  /** A blocking, non-cookie overlay is active (drives background annotation). */
  blocking_active: boolean;
  /**
   * INTERNAL (endpoint use only — not part of the agent payload): refs of
   * records that are NOT members of any real overlay while a blocking surface
   * is active. The endpoint annotates these `likely_blocked_by_overlay`.
   */
  likely_blocked_refs: string[];
  /**
   * Set when the dominant surface is a blocking human-verification challenge:
   * the agent's next step is the Human Presence Relay (a HumanVerificationRequest
   * the user completes in the Aegis UI), not any browser_click/browser_type.
   */
  recommended_next_step?: "human_presence_relay_required";
}

// Dismiss classification for surface actions. Includes "continue shopping"-style
// panel closers on top of the structural is_dismiss marker and DISMISS_NAME —
// classification is advisory labeling only (Antigen never auto-clicks dismiss).
const SURFACE_DISMISS_EXTRA = /\b(cancel|continue shopping|keep shopping|keep browsing|go back)\b/;

function isSurfaceDismissAction(r: AntigenSnapshotElementRecord): boolean {
  if (r.overlay?.is_dismiss === true) return true;
  const n = r.normalized_name;
  if (!n) return false;
  return DISMISS_NAME.test(n) || SURFACE_DISMISS_EXTRA.test(n);
}

/** Intents that are reversible and safe to recommend / (in slice 2) live-resolve. */
const SURFACE_LOW_RISK_INTENTS: ReadonlySet<string> = new Set([
  "navigation",
  "cart_mutation",
  "checkout_transition",
]);

/**
 * Deterministic, conservative primary-action pick among the non-dismiss actions
 * of one surface:
 *   1. exactly one non-dismiss action → primary;
 *   2. else the unique one with an href_path (real navigation target) → primary;
 *   3. else the unique one with a call-to-action name → primary;
 *   4. else none — everything stays secondary (never guess between peers).
 */
function pickPrimaryRef(nonDismiss: AntigenSnapshotElementRecord[]): string | undefined {
  if (nonDismiss.length === 1) return nonDismiss[0].ref;
  const withHref = nonDismiss.filter((r) => !!r.href_path);
  if (withHref.length === 1) return withHref[0].ref;
  const cta = nonDismiss.filter((r) => isPrimaryActionName(r.normalized_name));
  if (cta.length === 1) return cta[0].ref;
  return undefined;
}

/**
 * Builds the active-surfaces view from the snapshot's element records. Pure and
 * deterministic — no DOM, no CDP. Cookie-consent groups are excluded (they keep
 * their own `cookie_banner` warning and must not dominate surface guidance),
 * mirroring `buildActiveOverlay`.
 */
export function buildActiveSurfaces(
  records: AntigenSnapshotElementRecord[],
  url?: string | null,
): ActiveSurfacesResult {
  const cookieRefs = cookieRefSet(records);
  const members = records.filter((r) => isOverlayMember(r) && !cookieRefs.has(r.ref));

  const blocking_active = members.some((r) => r.overlay?.blocking === true);
  const likely_blocked_refs = blocking_active
    ? records
        .filter((r) => !(isOverlayMember(r) && !cookieRefs.has(r.ref)))
        .map((r) => r.ref)
    : [];

  if (members.length === 0) {
    return { surfaces: [], recommended_actions: [], blocking_active, likely_blocked_refs };
  }

  // Dominance ordering: blocking first, then dialog/alertdialog, then size —
  // the SAME scoring buildActiveOverlay uses, applied to every group.
  const scored = groupOverlayMembers(members).map((group) => {
    const blocking = group.some((r) => r.overlay?.blocking === true);
    const type = group[0].overlay!.overlay_type;
    const score =
      (blocking ? 1000 : 0) + (type === "dialog" || type === "alertdialog" ? 100 : 0) + group.length;
    return { group, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const surfaces: ActiveSurface[] = [];
  const recommended_actions: RecommendedSurfaceAction[] = [];
  let recommendedFromSurface = false;
  let recommendedNextStep: ActiveSurfacesResult["recommended_next_step"];

  for (let i = 0; i < scored.length; i++) {
    const group = scored[i].group;
    const surfaceId = `surf_${i + 1}`;
    const overlayType = group[0].overlay!.overlay_type;
    const blocking = group.some((r) => r.overlay?.blocking === true);
    const title = clip(group.map((r) => r.overlay?.modal_title).find(Boolean) ?? "", MESSAGE_MAX);
    // Human-verification surface (flag-gated): its controls must never look
    // like normal low-risk actions — every action requires a handoff and the
    // surface never produces recommendations.
    const hvMember = isHumanVerificationEnabled()
      ? group.find((r) => r.overlay?.human_verification === true)
      : undefined;

    const clickables = group.filter((r) => r.clickable && r.enabled);
    const dismissRefs = new Set(clickables.filter(isSurfaceDismissAction).map((r) => r.ref));
    const primaryRef = pickPrimaryRef(clickables.filter((r) => !dismissRefs.has(r.ref)));

    const actions: ActiveSurfaceAction[] = clickables.map((r) => {
      const cls = classifyActionIntent({
        action: "click",
        text: r.name,
        normalized_text: r.normalized_name,
        role: r.role,
        kind: r.kind,
        tag: r.tag,
        href_path: r.href_path,
        context: r.context ? { label: r.context.label, section: r.context.section } : undefined,
        url: url ?? undefined,
      });
      const requiresHandoff =
        !!hvMember ||
        cls.reversibility !== "reversible" ||
        !SURFACE_LOW_RISK_INTENTS.has(cls.action_intent);
      const action: ActiveSurfaceAction = {
        ref: r.ref,
        name: r.name,
        kind: r.kind,
        classification: dismissRefs.has(r.ref)
          ? "dismiss"
          : r.ref === primaryRef
            ? "primary"
            : "secondary",
        action_intent: cls.action_intent,
      };
      if (requiresHandoff) action.requires_handoff = true;
      return action;
    });

    const surface: ActiveSurface = {
      surface_id: surfaceId,
      surface_type: overlayType,
      blocking,
      dismissible: actions.some((a) => a.classification === "dismiss"),
      actions,
    };
    if (title) surface.title = title;
    if (hvMember) {
      surface.surface_kind = "human_verification";
      surface.challenge_type =
        hvMember.overlay?.hv_challenge_type ?? "unknown_human_verification";
      surface.user_presence_required = true;
      // The dominant (first-scored) surface being a blocking human-verification
      // challenge drives the page-level next step: relay required.
      if (i === 0 && blocking) recommendedNextStep = "human_presence_relay_required";
    }
    surfaces.push(surface);

    // Recommendations come from the single dominant recommendable surface:
    // never a toast (transient, may auto-dismiss), a chat/help widget, or a
    // human-verification challenge (its controls are relay-only), and never an
    // action that requires a handoff.
    const warningKind = warningKindFor(overlayType, group);
    const recommendable =
      !hvMember && overlayType !== "toast" && warningKind !== "chat_widget" && warningKind !== "toast";
    if (!recommendedFromSurface && recommendable) {
      const rec = (a: ActiveSurfaceAction, reason: RecommendedSurfaceAction["reason"]) =>
        recommended_actions.push({
          ref: a.ref,
          name: a.name,
          surface_id: surfaceId,
          classification: a.classification,
          reason,
        });
      for (const a of actions) {
        if (a.requires_handoff) continue;
        if (a.classification === "primary") rec(a, "active_surface_primary_action");
      }
      for (const a of actions) {
        if (a.requires_handoff) continue;
        if (a.classification === "dismiss") rec(a, "active_surface_dismiss_action");
      }
      if (recommended_actions.length > 0) recommendedFromSurface = true;
    }
  }

  const result: ActiveSurfacesResult = {
    surfaces,
    // While a blocking human-verification challenge dominates the page, no
    // click recommendation is meaningful (background refs are guarded too) —
    // the only next step is the Human Presence Relay.
    recommended_actions: recommendedNextStep ? [] : recommended_actions,
    blocking_active,
    likely_blocked_refs,
  };
  if (recommendedNextStep) result.recommended_next_step = recommendedNextStep;
  return result;
}

// ─── Post-Click State v1 (ANTIGEN_CLICK_VERIFY, default-off) ─────────────────
//
// Generalized post-click REALIZATION summary: after a verified-path click, the
// endpoint maps the runtime's internal before/after probe state into one
// compact, sanitized object so the agent knows — in the click response itself —
// whether nothing happened, a modal opened/closed, the URL changed, an SPA
// route loaded, or the page is still loading. Names-only by design: refs come
// ONLY from antigen_snapshot (the constant `next` marker says so).
//
// SAFETY: URLs are reduced to query-/fragment-free host+path via splitUrl
// (tokens/PII live in query strings — never exposed); titles are clipped
// value-free display strings consistent with ActiveSurface.title /
// page_summary.visible_heading; surface actions carry accessible NAMES only
// (no refs, no geometry, no hrefs); requires_handoff actions are listed for
// visibility but never implied as recommended.

export interface PostClickStateAction {
  name: string; // value-free accessible name, ≤80
  classification: SurfaceActionClassification;
  /** Final / irreversible / uncertain intent — must go through handoff tools. */
  requires_handoff?: true;
}

export interface PostClickSurface {
  overlay_blocking: boolean;
  overlay_type: AntigenOverlayType;
  /** Value-free accessible title of the surface container, ≤120. */
  title?: string;
  /** Names-only actions inside the surface (ANTIGEN_ACTIVE_SURFACES only; ≤8). */
  surface_actions?: PostClickStateAction[];
}

export type PostClickChange =
  | "none" // nothing observable changed
  | "modal_opened"
  | "modal_closed"
  | "surface_changed" // overlay type/identity changed (drawer swap, step change)
  | "navigation" // URL/route changed (full nav or SPA history route)
  | "content_updated" // same URL: title and/or main content changed
  | "still_loading" // navigation detected but document not complete
  | "unknown"; // after-probe unreadable

export const POST_CLICK_CHANGES: ReadonlySet<PostClickChange> = new Set<PostClickChange>([
  "none",
  "modal_opened",
  "modal_closed",
  "surface_changed",
  "navigation",
  "content_updated",
  "still_loading",
  "unknown",
]);

export type PostClickRecommendedNextStep =
  | "none"
  | "refresh_snapshot"
  | "wait_for_load_then_snapshot"
  | "try_alternate_ref";

export interface PostClickState {
  /** The one-glance realization signal. */
  change: PostClickChange;
  navigation_or_route_detected: boolean;
  url_changed: boolean;
  /** Sanitized: pathname ONLY (≤160) — no query, no fragment, no credentials. */
  old_url_path?: string;
  new_url_path?: string;
  /** Host only — included when the host changed across the click. */
  new_url_host?: string;
  title_changed: boolean;
  old_title?: string; // clipped ≤120
  new_title?: string;
  document_ready_state?: "loading" | "interactive" | "complete";
  main_content_changed: boolean;
  /** Present when an overlay is active after the click (any `change`). */
  surface?: PostClickSurface;
  recommended_next_step: PostClickRecommendedNextStep;
  /** Constant marker: clickable refs come only from antigen_snapshot. */
  next: "refs_require_fresh_snapshot";
}

const POST_CLICK_MAX_ACTIONS = 8;

/** Names-only surface-action classification, mirroring buildActiveSurfaces:
 * page-side dismiss flag (or dismiss-name pattern) → dismiss; the UNIQUE
 * CTA-named non-dismiss action → primary (never guess between peers); else
 * secondary. requires_handoff exactly as the active-surfaces rule — and,
 * STRICTER than buildActiveSurfaces, a handoff-flagged action can never be
 * "primary" here: in a click response "primary" reads as the suggested next
 * action, and a final/irreversible action must never be suggested. */
function buildPostClickSurfaceActions(
  probeActions: OverlayProbeAction[],
  url: string | null | undefined,
): PostClickStateAction[] {
  const seen = new Set<string>();
  const cleaned = probeActions
    .map((a) => ({ ...a, name: clip(a.name, 80) ?? "" }))
    .filter((a) => {
      if (!a.name) return false;
      const key = normalizeName(a.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, POST_CLICK_MAX_ACTIONS);

  const isDismiss = (a: OverlayProbeAction): boolean => {
    if (a.dismiss) return true;
    const n = normalizeName(a.name);
    return !!n && (DISMISS_NAME.test(n) || SURFACE_DISMISS_EXTRA.test(n));
  };
  const classified = cleaned.map((a) => {
    const cls = classifyActionIntent({
      action: "click",
      text: a.name,
      normalized_text: normalizeName(a.name),
      kind: a.kind,
      url: url ?? undefined,
    });
    const requiresHandoff =
      cls.reversibility !== "reversible" || !SURFACE_LOW_RISK_INTENTS.has(cls.action_intent);
    return { ...a, dismissAction: isDismiss(a), requiresHandoff };
  });

  // Primary candidacy: non-dismiss, non-handoff only.
  const candidates = classified.filter((a) => !a.dismissAction && !a.requiresHandoff);
  const cta = candidates.filter((a) => isPrimaryActionName(normalizeName(a.name)));
  const primaryName =
    candidates.length === 1
      ? candidates[0].name
      : cta.length === 1
        ? cta[0].name
        : undefined;

  return classified.map((a) => {
    const action: PostClickStateAction = {
      name: a.name,
      classification: a.dismissAction ? "dismiss" : a.name === primaryName ? "primary" : "secondary",
    };
    if (a.requiresHandoff) action.requires_handoff = true;
    return action;
  });
}

/**
 * Maps a click verification's INTERNAL display state into the sanitized,
 * agent-facing post_click_state. Pure and deterministic — no DOM, no CDP, no
 * env reads (the caller gates `includeActions` on isActiveSurfacesEnabled()).
 * Returns undefined when verification is absent (flag off — response stays
 * byte-identical).
 */
export function buildPostClickState(
  verification: ClickVerification | undefined,
  opts: { includeActions: boolean },
): PostClickState | undefined {
  if (!verification) return undefined;
  const internal = verification.post_click_internal;

  // After-probe unreadable: the click may or may not have worked — say so
  // explicitly instead of leaving the agent to infer from silence.
  if (!internal) {
    return {
      change: "unknown",
      navigation_or_route_detected: false,
      url_changed: verification.url_changed,
      title_changed: false,
      main_content_changed: false,
      recommended_next_step: "refresh_snapshot",
      next: "refs_require_fresh_snapshot",
    };
  }

  const urlChanged = verification.url_changed;
  const before = splitUrl(internal.before_url);
  const after = splitUrl(internal.after_url);
  const titleChanged =
    internal.before_title !== null &&
    internal.after_title !== null &&
    internal.before_title !== internal.after_title;

  const overlay = internal.after_overlay;
  const overlayTypeKnown =
    !!overlay?.present &&
    !!overlay.overlay_type &&
    OVERLAY_TYPE_VALUES.has(overlay.overlay_type);

  let change: PostClickChange;
  if (urlChanged && internal.ready_state !== "complete") change = "still_loading";
  else if (urlChanged) change = "navigation";
  else if (!verification.overlay_before_blocking && verification.overlay_after_blocking) change = "modal_opened";
  else if (verification.overlay_before_present && !verification.overlay_after_present) change = "modal_closed";
  else if (
    // A fresh nonblocking overlay appeared (add-to-bag flyout, toast panel) or
    // an existing overlay's identity changed (drawer swap, step change).
    (!verification.overlay_before_present && verification.overlay_after_present) ||
    (verification.overlay_before_present &&
      verification.overlay_after_present &&
      (verification.overlay_before_type !== verification.overlay_after_type ||
        verification.verification_signal === "overlay_changed" ||
        verification.verification_signal === "modal_opened"))
  ) {
    change = "surface_changed";
  } else if (titleChanged || internal.main_content_changed) change = "content_updated";
  else change = "none";

  const recommended: PostClickRecommendedNextStep =
    change === "still_loading"
      ? "wait_for_load_then_snapshot"
      : change === "none"
        ? verification.recommended_next_step === "try_alternate_ref"
          ? "try_alternate_ref"
          : "refresh_snapshot"
        : "refresh_snapshot";

  const state: PostClickState = {
    change,
    navigation_or_route_detected: urlChanged || (titleChanged && internal.main_content_changed),
    url_changed: urlChanged,
    title_changed: titleChanged,
    main_content_changed: internal.main_content_changed,
    recommended_next_step: recommended,
    next: "refs_require_fresh_snapshot",
  };
  if (urlChanged) {
    const oldPath = clip(before.path, 160);
    const newPath = clip(after.path, 160);
    if (oldPath) state.old_url_path = oldPath;
    if (newPath) state.new_url_path = newPath;
    if (after.host && before.host !== after.host) {
      const newHost = clip(after.host, 120);
      if (newHost) state.new_url_host = newHost;
    }
  }
  if (titleChanged) {
    const oldTitle = clip(internal.before_title, MESSAGE_MAX);
    const newTitle = clip(internal.after_title, MESSAGE_MAX);
    if (oldTitle) state.old_title = oldTitle;
    if (newTitle) state.new_title = newTitle;
  }
  if (internal.ready_state) state.document_ready_state = internal.ready_state;
  if (overlay && overlayTypeKnown) {
    const surface: PostClickSurface = {
      overlay_blocking: overlay.blocking === true,
      overlay_type: overlay.overlay_type as AntigenOverlayType,
    };
    const title = clip(overlay.title ?? undefined, MESSAGE_MAX);
    if (title) surface.title = title;
    if (opts.includeActions && Array.isArray(overlay.actions) && overlay.actions.length > 0) {
      const actions = buildPostClickSurfaceActions(overlay.actions, internal.after_url);
      if (actions.length > 0) surface.surface_actions = actions;
    }
    state.surface = surface;
  }
  return state;
}

// ─── Post-Fill State v1 (ANTIGEN_FILL_STATE, default-off) ────────────────────
//
// Post-fill REALIZATION summary, the protected-fill analogue of
// post_click_state: after a profile/payment fill executes, the endpoint maps a
// single after-probe (plus server-side fill truth and the iframe redaction
// registry) into one compact object so the agent knows — in the fill response
// itself — whether the fill landed, validation errors appeared, the next
// "Continue" is enabled, masking/redaction is in order, and exactly why one
// fresh antigen_snapshot is still needed. This removes the post-fill
// re-snapshot / scroll-hunt / redaction-re-verification loop.
//
// SAFETY: names-only and allowlist-only, mirroring PostClickState. No refs
// (refs come ONLY from antigen_snapshot — the constant `next` marker says so),
// no selectors, no geometry, no field values (the probe's fill-state section
// never reads `.value`; filled-state is data-antigen-filled marker COUNTS).
// `raw_values_revealed_to_agent: false` is a TypeScript literal. Probe failure
// degrades to outcome "unknown" and NEVER affects fill success reporting.

export type PostFillOutcome =
  | "ready_for_next_action" // ≥1 enabled, non-handoff next action; no validation errors
  | "handoff_required_next" // only enabled candidates are final/irreversible (handoff tools)
  | "validation_errors_present"
  | "fill_incomplete" // failed_count > 0 (server-side truth, probe-independent)
  | "no_next_action_visible" // fills ok but no enabled candidate found (scroll IN the snapshot)
  | "unknown"; // probe unreadable — never affects fill success reporting

export const POST_FILL_OUTCOMES: ReadonlySet<PostFillOutcome> = new Set<PostFillOutcome>([
  "ready_for_next_action",
  "handoff_required_next",
  "validation_errors_present",
  "fill_incomplete",
  "no_next_action_visible",
  "unknown",
]);

export type PostFillRecommendedNextStep =
  | "snapshot_then_click_named_action"
  | "review_validation_errors"
  | "refresh_snapshot"
  | "handoff_required";

export interface PostFillAction {
  name: string; // value-free accessible name, ≤80
  classification: SurfaceActionClassification;
  /** Present (true) when the control is disabled — a disabled action is never "primary". */
  disabled?: true;
  /** Final / irreversible / uncertain intent — must go through handoff tools; never "primary". */
  requires_handoff?: true;
}

export interface PostFillMaskingSummary {
  /** [data-antigen-filled] marker count (top document). Present when the probe was readable. */
  dom_filled_marker_count?: number;
  /** [data-antigen-masked] marker count (top document). Present when the probe was readable. */
  visual_mask_marker_count?: number;
  /** Registry-derived (server-side, no CDP): cross-origin iframe field kinds registered for screenshot redaction. */
  iframe_redaction_fields?: ProtectedIframeFieldKind[];
  /** Fail-closed report: the just-filled iframe field kind is MISSING from the registry. Never silent. */
  iframe_redaction_mismatch?: true;
  /**
   * Fewer live `data-antigen-masked` markers than top-level protected fields filled
   * in this session — a page re-render likely replaced a masked node (the screenshot
   * path re-masks or fails closed; this surfaces the condition early). Never silent.
   */
  top_level_mask_missing?: true;
}

export interface PostFillState {
  /** The one-glance realization signal. */
  outcome: PostFillOutcome;
  /** Server-side fill truth (from the fill entries) — probe-independent. */
  filled_count: number;
  failed_count: number;
  /** Visible aria-invalid + non-empty alert regions, capped ≤99. Omitted when outcome is "unknown". */
  validation_error_count?: number;
  /** Names-only candidate next actions near the filled form (≤8, deduped). */
  next_action_names?: PostFillAction[];
  /** Present when an overlay is active after the fill. */
  surface?: PostClickSurface;
  masking: PostFillMaskingSummary;
  /** Server-measured probe duration, bounded. */
  probe_ms?: number;
  /** Literal false — protected values are never returned to the agent. */
  raw_values_revealed_to_agent: false;
  recommended_next_step: PostFillRecommendedNextStep;
  /** Constant marker: clickable refs come only from antigen_snapshot. */
  next: "refs_require_fresh_snapshot";
}

const POST_FILL_MAX_ACTIONS = 8;
const POST_FILL_VALIDATION_COUNT_CAP = 99;
const POST_FILL_PROBE_MS_CAP = 600_000;

/** Names-only next-action classification for post_fill_state. Mirrors
 * buildPostClickSurfaceActions (dedupe by normalizeName, ≤8 cap, dismiss via
 * page-side flag or dismiss-name pattern, requires_handoff via
 * classifyActionIntent + SURFACE_LOW_RISK_INTENTS, handoff never "primary")
 * with one fill-specific addition: actions carry a `disabled` flag, and a
 * disabled action is never "primary" — in a fill response "primary" reads as
 * the suggested next click, and a still-disabled "Continue" must be reported,
 * not suggested. */
function buildPostFillActions(
  probeActions: FillProbeAction[],
  url: string | null | undefined,
): PostFillAction[] {
  const seen = new Set<string>();
  const cleaned = probeActions
    .map((a) => ({ ...a, name: clip(a.name, 80) ?? "" }))
    .filter((a) => {
      if (!a.name) return false;
      const key = normalizeName(a.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, POST_FILL_MAX_ACTIONS);

  const isDismiss = (a: FillProbeAction): boolean => {
    if (a.dismiss) return true;
    const n = normalizeName(a.name);
    return !!n && (DISMISS_NAME.test(n) || SURFACE_DISMISS_EXTRA.test(n));
  };
  const classified = cleaned.map((a) => {
    const cls = classifyActionIntent({
      action: "click",
      text: a.name,
      normalized_text: normalizeName(a.name),
      kind: a.kind,
      url: url ?? undefined,
    });
    const requiresHandoff =
      cls.reversibility !== "reversible" || !SURFACE_LOW_RISK_INTENTS.has(cls.action_intent);
    return { ...a, dismissAction: isDismiss(a), requiresHandoff };
  });

  // Primary candidacy: enabled, non-dismiss, non-handoff only.
  const candidates = classified.filter(
    (a) => !a.dismissAction && !a.requiresHandoff && a.disabled !== true,
  );
  const cta = candidates.filter((a) => isPrimaryActionName(normalizeName(a.name)));
  const primaryName =
    candidates.length === 1
      ? candidates[0].name
      : cta.length === 1
        ? cta[0].name
        : undefined;

  return classified.map((a) => {
    const action: PostFillAction = {
      name: a.name,
      classification: a.dismissAction
        ? "dismiss"
        : a.name === primaryName
          ? "primary"
          : "secondary",
    };
    if (a.disabled === true) action.disabled = true;
    if (a.requiresHandoff) action.requires_handoff = true;
    return action;
  });
}

export interface BuildPostFillStateInput {
  /** The after-fill probe (collectFillState). Absent/error → outcome "unknown". */
  probe?: PageStateProbe;
  probe_ms?: number;
  /** Server-side fill truth from the fill entries / fill result. */
  filled_count: number;
  failed_count: number;
  /** Registry-derived iframe redaction kinds for the browser session (payment path). */
  iframe_redaction_fields?: ProtectedIframeFieldKind[];
  /** The iframe field kind the fill just registered — mismatch check against the registry list. */
  expected_iframe_field?: ProtectedIframeFieldKind;
  /**
   * Registry-derived count of top-level protected fields filled with visualMask in
   * this session. Compared against the probe's live masked-marker count: fewer live
   * markers than expected means a re-render wiped a mask (extra markers — e.g.
   * iframe containers tagged by a prior screenshot — only inflate, so only the
   * under-count is meaningful).
   */
  expected_top_level_masked?: number;
  /** Live page URL (internal input for intent classification only — never emitted). */
  pageUrl?: string | null;
}

/**
 * Maps the after-fill probe + server-side fill truth into the sanitized,
 * agent-facing post_fill_state. Pure and deterministic — no DOM, no CDP, no env
 * reads. `next_action_names` (the fill-state collection) is always included —
 * it is the point of the feature; opts.includeActions gates only the
 * overlay-collected `surface.surface_actions` (the caller sets it from
 * isActiveSurfacesEnabled(), matching buildPostClickState). Explicit-field
 * allowlist: the probe object is never spread.
 */
export function buildPostFillState(
  input: BuildPostFillStateInput,
  opts: { includeActions: boolean },
): PostFillState {
  const filledCount = Math.max(0, Math.floor(input.filled_count));
  const failedCount = Math.max(0, Math.floor(input.failed_count));

  const masking: PostFillMaskingSummary = {};
  if (Array.isArray(input.iframe_redaction_fields) && input.iframe_redaction_fields.length > 0) {
    masking.iframe_redaction_fields = [...input.iframe_redaction_fields];
  }
  if (
    input.expected_iframe_field &&
    !(input.iframe_redaction_fields ?? []).includes(input.expected_iframe_field)
  ) {
    masking.iframe_redaction_mismatch = true;
  }

  const probeOk = input.probe?.status === "ok" && !!input.probe.fill_state;
  const fillProbe = probeOk ? input.probe!.fill_state! : undefined;

  const base = {
    filled_count: filledCount,
    failed_count: failedCount,
    masking,
    raw_values_revealed_to_agent: false as const,
    next: "refs_require_fresh_snapshot" as const,
    ...(typeof input.probe_ms === "number" && input.probe_ms >= 0
      ? { probe_ms: Math.min(Math.round(input.probe_ms), POST_FILL_PROBE_MS_CAP) }
      : {}),
  };

  // Probe absent/unreadable: fill truth and registry state still reported; the
  // page-level outcome is honestly "unknown" (never falsified, never blocking).
  if (!fillProbe) {
    return {
      outcome: "unknown",
      ...base,
      recommended_next_step: "refresh_snapshot",
    };
  }

  masking.dom_filled_marker_count = Math.max(0, Math.floor(fillProbe.filled_marker_count));
  masking.visual_mask_marker_count = Math.max(0, Math.floor(fillProbe.masked_marker_count));
  if (
    typeof input.expected_top_level_masked === "number" &&
    input.expected_top_level_masked > 0 &&
    masking.visual_mask_marker_count < input.expected_top_level_masked
  ) {
    masking.top_level_mask_missing = true;
  }

  const validationCount = Math.min(
    Math.max(0, Math.floor(fillProbe.invalid_count)) + Math.max(0, Math.floor(fillProbe.alert_count)),
    POST_FILL_VALIDATION_COUNT_CAP,
  );

  const actions = buildPostFillActions(
    Array.isArray(fillProbe.form_actions) ? fillProbe.form_actions : [],
    input.pageUrl,
  );

  const enabledNonDismiss = actions.filter(
    (a) => a.classification !== "dismiss" && a.disabled !== true,
  );
  const enabledClickable = enabledNonDismiss.filter((a) => a.requires_handoff !== true);
  const enabledHandoffOnly =
    enabledNonDismiss.length > 0 && enabledClickable.length === 0;

  let outcome: PostFillOutcome;
  if (failedCount > 0) outcome = "fill_incomplete";
  else if (validationCount > 0) outcome = "validation_errors_present";
  else if (enabledClickable.length > 0) outcome = "ready_for_next_action";
  else if (enabledHandoffOnly) outcome = "handoff_required_next";
  else outcome = "no_next_action_visible";

  const recommended: PostFillRecommendedNextStep =
    outcome === "ready_for_next_action"
      ? "snapshot_then_click_named_action"
      : outcome === "validation_errors_present"
        ? "review_validation_errors"
        : outcome === "handoff_required_next"
          ? "handoff_required"
          : "refresh_snapshot";

  const state: PostFillState = {
    outcome,
    ...base,
    validation_error_count: validationCount,
    recommended_next_step: recommended,
  };
  if (actions.length > 0) state.next_action_names = actions;

  const overlay = input.probe!.overlay;
  const overlayTypeKnown =
    !!overlay?.present && !!overlay.overlay_type && OVERLAY_TYPE_VALUES.has(overlay.overlay_type);
  if (overlay && overlayTypeKnown) {
    const surface: PostClickSurface = {
      overlay_blocking: overlay.blocking === true,
      overlay_type: overlay.overlay_type as AntigenOverlayType,
    };
    const title = clip(overlay.title ?? undefined, MESSAGE_MAX);
    if (title) surface.title = title;
    if (opts.includeActions && Array.isArray(overlay.actions) && overlay.actions.length > 0) {
      const surfaceActions = buildPostClickSurfaceActions(overlay.actions, input.pageUrl ?? null);
      if (surfaceActions.length > 0) surface.surface_actions = surfaceActions;
    }
    state.surface = surface;
  }
  return state;
}

export function buildAntigenPageMap(params: BuildPageMapParams): AntigenPageMap {
  const { records, pageMeta, viewportOnly, url } = params;
  const { host, path } = splitUrl(url);

  // Per-record qualitative status (drives action items, hints, and element merge).
  const ref_status: Record<string, RefStatus> = {};
  const statusByRef = new Map<string, ViewportStatus>();
  for (const r of records) {
    const vp = classifyViewport(r, pageMeta, viewportOnly);
    statusByRef.set(r.ref, vp);
    ref_status[r.ref] = {
      viewport_status: vp,
      scroll_required: vp === "below_viewport" || vp === "above_viewport" || vp === "offscreen",
      stability_hint: stabilityFor(r),
    };
  }

  const cookieRefs = cookieRefSet(records);
  const warnings = buildWarnings(records);
  const active_overlay = buildActiveOverlay(records, cookieRefs);

  // When a blocking overlay is active, background actions are demoted so the
  // agent acts on the modal first. Nonblocking overlays (toasts/popovers/chat
  // widgets) never demote the rest of the page; cookie banners never count.
  const blockingActive = records.some(
    (r) => isOverlayMember(r) && r.overlay?.blocking === true && !cookieRefs.has(r.ref),
  );

  // Categorize interactive elements into ranked action buckets.
  const primary: RankedAction[] = [];
  const secondary: RankedAction[] = [];
  const navigation: RankedAction[] = [];
  const action_hints: ActionHintEntry[] = [];

  for (const r of records) {
    const vp = statusByRef.get(r.ref) ?? "unknown";
    // Cookie-consent controls classify normally — they are never treated as
    // modal members and never demoted as background.
    const member = isOverlayMember(r) && !cookieRefs.has(r.ref);
    const dismiss = (member && r.overlay?.is_dismiss === true) || isOverlayDismiss(r, warnings);
    const hint = hintFor(r, vp);
    action_hints.push({
      ref: r.ref,
      action_hint: hint,
      ...(dismiss ? { reason: "dismiss_overlay" } : {}),
    });

    const { category, priority, reason } = classify(r);
    if (category === "form" || category === "none") continue;

    // Inert background controls cannot be acted on — keep them in `elements`
    // (the endpoint emits those) but never rank them as actions.
    if (isInertRecord(r)) continue;

    // Overlay-aware re-classification.
    let cat = category;
    let prio = priority;
    let rsn = reason;
    if (member) {
      if (r.overlay?.is_dismiss === true) {
        cat = "secondary";
        prio = "medium";
        rsn = "modal_dismiss";
      } else if (category === "primary") {
        prio = "high";
        rsn = "modal_primary_action";
      } else {
        cat = "primary";
        prio = bumpPriority(priority);
        rsn = "modal_action";
      }
    } else if (blockingActive) {
      // Behind an active blocking modal — demote out of the spotlight.
      cat = category === "primary" ? "secondary" : category;
      prio = "low";
      rsn = "behind_active_modal";
    } else if (isBackgroundRecord(r)) {
      prio = "low";
      rsn = "behind_active_modal";
    }

    const item: RankedAction = {
      ref: r.ref,
      role: r.role,
      name: r.name,
      priority: prio,
      reason: dismiss && rsn !== "modal_dismiss" ? "dismiss_overlay" : rsn,
      action_hint: hint,
      viewport_status: vp,
      scroll_required: ref_status[r.ref].scroll_required,
    };
    if (cat === "primary") primary.push(item);
    else if (cat === "navigation") navigation.push(item);
    else secondary.push(item);
  }

  // Within equal priority, overlay actions lead so a modal's controls surface
  // first regardless of DOM order.
  const modalRank = (a: RankedAction) => (/^modal_/.test(a.reason) ? 0 : 1);
  const byPriority = (a: RankedAction, b: RankedAction) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || modalRank(a) - modalRank(b);
  primary.sort(byPriority);
  secondary.sort(byPriority);

  const clickableCount = records.filter((r) => r.clickable).length;
  const typeableCount = records.filter((r) => r.typeable).length;

  const page_summary: PageSummary = {
    page_kind: inferPageKind({ records, pageMeta, path }),
  };
  if (host) page_summary.url_host = host;
  if (path) page_summary.url_path = path;
  const heading = clip(pageMeta?.heading, HEADING_MAX);
  if (heading) page_summary.visible_heading = heading;
  const excerpt = clip(pageMeta?.text_excerpt, EXCERPT_MAX);
  if (excerpt) page_summary.visible_text_excerpt = excerpt;

  return {
    page_summary,
    current_scroll: computeScroll(pageMeta),
    primary_actions: primary,
    secondary_actions: secondary,
    navigation,
    forms: buildForms(records),
    product_cards: buildProductCards(records),
    warnings_or_modals: warnings,
    ...(active_overlay ? { active_overlay } : {}),
    action_hints,
    ref_status,
    evidence_partial: {
      element_count: records.length,
      clickable_count: clickableCount,
      typeable_count: typeableCount,
      ...(hashVisibleText(pageMeta?.text_excerpt) ? { visible_text_hash: hashVisibleText(pageMeta?.text_excerpt) } : {}),
    },
  };
}
