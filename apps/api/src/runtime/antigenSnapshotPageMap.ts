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
import type { AntigenSnapshotElementRecord } from "./antigenSnapshotStore.js";
import type { AntigenPageMeta } from "./antigenSnapshotRuntime.js";

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
  kind: "cookie_banner" | "modal" | "cart_drawer" | "login_prompt" | "unknown_overlay";
  message?: string;
  dismiss_refs?: string[];
  action_hint?: "browser_click";
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

function buildWarnings(records: AntigenSnapshotElementRecord[]): WarningOrModal[] {
  const warnings: WarningOrModal[] = [];

  const ctxText = (r: AntigenSnapshotElementRecord) =>
    `${r.context?.section ?? ""} ${r.context?.label ?? ""} ${r.name}`;

  // Cookie banner: any control whose context/name mentions cookies/consent.
  const cookieControls = records.filter((r) => COOKIE_RE.test(ctxText(r)));
  if (cookieControls.length > 0) {
    const dismiss = cookieControls
      .filter((r) => r.clickable && r.normalized_name && COOKIE_DISMISS.test(r.normalized_name))
      .map((r) => r.ref);
    const message = clip(cookieControls.map((r) => r.context?.section).find(Boolean) ?? "Cookie consent prompt", MESSAGE_MAX);
    warnings.push({
      kind: "cookie_banner",
      ...(message ? { message } : {}),
      ...(dismiss.length > 0 ? { dismiss_refs: dismiss, action_hint: "browser_click" as const } : {}),
    });
  }

  // Generic modal/dialog overlay (excluding cookie, already handled).
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
      ...(dismiss.length > 0 ? { dismiss_refs: dismiss, action_hint: "browser_click" as const } : {}),
    });
  }

  return warnings;
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

  const warnings = buildWarnings(records);

  // Categorize interactive elements into ranked action buckets.
  const primary: RankedAction[] = [];
  const secondary: RankedAction[] = [];
  const navigation: RankedAction[] = [];
  const action_hints: ActionHintEntry[] = [];

  for (const r of records) {
    const vp = statusByRef.get(r.ref) ?? "unknown";
    const overlay = isOverlayDismiss(r, warnings);
    const hint = hintFor(r, vp);
    action_hints.push({
      ref: r.ref,
      action_hint: hint,
      ...(overlay ? { reason: "dismiss_overlay" } : {}),
    });

    const { category, priority, reason } = classify(r);
    if (category === "form" || category === "none") continue;

    const item: RankedAction = {
      ref: r.ref,
      role: r.role,
      name: r.name,
      priority,
      reason: overlay ? "dismiss_overlay" : reason,
      action_hint: hint,
      viewport_status: vp,
      scroll_required: ref_status[r.ref].scroll_required,
    };
    if (category === "primary") primary.push(item);
    else if (category === "navigation") navigation.push(item);
    else secondary.push(item);
  }

  const byPriority = (a: RankedAction, b: RankedAction) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
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
