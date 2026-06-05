/**
 * adapter-helpers.mjs
 *
 * Pure helper functions shared by antigen-browser-adapter.mjs and its tests.
 * No side effects, no env reads, no process references.
 */

/**
 * Returns true if the string looks like a CSS/ARIA selector rather than a
 * snapshot element reference (e.g. "e5", "a12"). Snapshot refs are short
 * alphanumeric strings; real selectors contain CSS syntax characters.
 */
export function looksLikeSelector(s) {
  return typeof s === "string" && s.length > 0 && /[\[.#>:=('"*~+]/.test(s);
}

/**
 * Clips a browser_runtime_id for safe diagnostic logging. Returns a short prefix
 * (never the full id), or "none" for a missing/non-string id. Used only for
 * stderr continuity diagnostics — never for protocol output.
 */
export function clipRuntimeId(id) {
  if (typeof id !== "string" || id.length === 0) return "none";
  return id.length > 14 ? id.slice(0, 14) + "…" : id;
}

/**
 * Maps text length to a coarse bucket for safe diagnostic logging.
 * Never call with the raw text — pass text.length only.
 */
export function charCountBucket(len) {
  if (len <= 4) return "1-4";
  if (len <= 8) return "5-8";
  if (len <= 16) return "9-16";
  return "17+";
}

/**
 * Builds the safe diagnostic text for a synthetic MCP success response.
 * Never includes raw typed text, passwords, or any field value.
 *
 * @param {"browser_type"|"browser_fill"|"browser_click"|"browser_scroll_to_ref"} toolName
 * @param {{ bucket?: string, hint?: string, focused?: boolean, submitted?: boolean, submitMethod?: string, pointerPathPointCount?: number, pointerStartSource?: string, pointerStatePersisted?: boolean, ref?: string, version: string }} opts
 * @returns {string}
 */
export function buildSyntheticSuccessText(toolName, { bucket, hint, focused, submitted, submitMethod, pointerPathPointCount, pointerStartSource, pointerStatePersisted, ref, version }) {
  if (toolName === "browser_scroll_to_ref") {
    // Scroll-only recovery: the agent MUST take a new antigen_snapshot and click a
    // fresh in-viewport ref. No coordinates, box, or pointer metadata — none exist
    // for a scroll. The old ref is a scroll target, not a click target.
    return (
      `Antigen browser_scroll_to_ref complete; path=scroll_to_ref_success; ref=${ref}; ` +
      `hint=take_new_snapshot; next=take a new antigen_snapshot and use a fresh in-viewport ref before clicking; ` +
      `source=antigen-browser-adapter@${version}`
    );
  }
  if (toolName === "browser_click") {
    let s = `Antigen realistic browser_click complete; path=realistic_success; hint=${hint ?? "description"}`;
    if (pointerPathPointCount !== undefined) s += `; pointer_path_point_count=${pointerPathPointCount}`;
    if (pointerStartSource !== undefined) s += `; pointer_start_source=${pointerStartSource}`;
    if (pointerStatePersisted !== undefined) s += `; pointer_state_persisted=${pointerStatePersisted}`;
    s += `; source=antigen-browser-adapter@${version}`;
    return s;
  }
  if (toolName === "browser_type") {
    let s = `Antigen realistic browser_type complete; path=realistic_success; char_count_bucket=${bucket}`;
    if (focused !== undefined) s += `; focused=${focused}`;
    if (submitted !== undefined) s += `; submitted=${submitted}`;
    if (submitMethod !== undefined) s += `; submit_method=${submitMethod}`;
    if (pointerPathPointCount !== undefined) s += `; pointer_path_point_count=${pointerPathPointCount}`;
    if (pointerStartSource !== undefined) s += `; pointer_start_source=${pointerStartSource}`;
    if (pointerStatePersisted !== undefined) s += `; pointer_state_persisted=${pointerStatePersisted}`;
    s += `; source=antigen-browser-adapter@${version}`;
    return s;
  }
  // browser_fill and others — unchanged format
  return `Antigen realistic ${toolName} complete; path=realistic_success; char_count_bucket=${bucket}; source=antigen-browser-adapter@${version}`;
}

/** Safe single-line cleaner for agent-facing snapshot text (collapses + clips). */
function snapClean(value, max = 120) {
  if (typeof value !== "string") return "";
  const s = value.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Builds the readable, agent-facing text for a successful antigen_snapshot
 * (Antigen Snapshot v2 page map).
 *
 * Allowlist-only: reads exclusively the safe external snapshot fields (page
 * summary, prioritized actions, action hints, forms, product cards, warnings,
 * and a compact element list). Never stringifies the raw backend payload, so any
 * unexpected internal field (box, x, y, width, height, cdp_url, secret_ref, raw
 * viewport dims, etc.) the backend might include can never leak. Coordinates and
 * geometry are server-side only and intentionally absent from this surface.
 *
 * @param {object} data Snapshot v2 response data.
 * @param {string} version
 * @returns {string}
 */
export function buildAntigenSnapshotText(data, version) {
  const d = data ?? {};
  const elements = Array.isArray(d.elements) ? d.elements : [];
  const elementCount = typeof d.element_count === "number" ? d.element_count : elements.length;
  const summary = d.page_summary && typeof d.page_summary === "object" ? d.page_summary : {};

  const lines = [];
  lines.push(
    `Antigen snapshot complete; path=antigen_snapshot_success;` +
    ` snapshot_id=${d.snapshot_id ?? "unknown"}; element_count=${elementCount};` +
    ` source=antigen-browser-adapter@${version}`,
  );

  // ── Page ──
  const pageKind = snapClean(summary.page_kind, 32) || "generic";
  const heading = snapClean(summary.visible_heading, 120);
  lines.push("");
  lines.push(`Page: ${pageKind}${heading ? ` — ${heading}` : ""}`);
  const host = snapClean(summary.url_host, 120);
  const path = snapClean(summary.url_path, 160);
  if (host || path) lines.push(`URL: ${host}${path}`);
  if (d.expires_at) lines.push(`Expires: ${snapClean(d.expires_at, 40)}`);
  // Qualitative scroll position (no raw numbers).
  const scroll = d.current_scroll && typeof d.current_scroll === "object" ? d.current_scroll : null;
  if (scroll && typeof scroll.position === "string") {
    const more = [];
    if (scroll.more_above === true) more.push("more above");
    if (scroll.more_below === true) more.push("more below");
    lines.push(`Scroll: ${snapClean(scroll.position, 16)}${more.length ? ` (${more.join(", ")})` : ""}`);
  }

  // ── Warnings / modals ──
  const warnings = Array.isArray(d.warnings_or_modals) ? d.warnings_or_modals : [];
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of warnings) {
      const kind = snapClean(w?.kind, 32) || "overlay";
      const msg = snapClean(w?.message, 120);
      const dismiss = Array.isArray(w?.dismiss_refs) ? w.dismiss_refs.filter((r) => typeof r === "string") : [];
      let line = `- ${kind}`;
      if (msg) line += `: ${msg}`;
      if (dismiss.length > 0) line += ` — dismiss ref ${dismiss.join(", ")} (use browser_click)`;
      lines.push(line);
    }
  }

  // ── Primary actions ──
  const primary = Array.isArray(d.primary_actions) ? d.primary_actions : [];
  if (primary.length > 0) {
    lines.push("");
    lines.push("Primary actions:");
    for (const a of primary) {
      lines.push(formatActionLine(a));
    }
  }

  // ── Forms ──
  const forms = Array.isArray(d.forms) ? d.forms : [];
  if (forms.length > 0) {
    lines.push("");
    lines.push("Forms:");
    for (const f of forms) {
      const label = snapClean(f?.label, 80);
      const inputs = Array.isArray(f?.input_refs) ? f.input_refs.filter((r) => typeof r === "string") : [];
      const submits = Array.isArray(f?.submit_refs) ? f.submit_refs.filter((r) => typeof r === "string") : [];
      const hint = snapClean(f?.action_hint, 40) || "browser_type";
      let line = `- ${label ? `${label}: ` : ""}inputs ${inputs.join(", ") || "(none)"}`;
      if (submits.length > 0) line += `; submit ${submits.join(", ")}`;
      line += ` — use ${hint}`;
      lines.push(line);
    }
  }

  // ── Product cards ──
  const cards = Array.isArray(d.product_cards) ? d.product_cards : [];
  if (cards.length > 0) {
    lines.push("");
    lines.push("Product cards:");
    for (const c of cards) {
      const title = snapClean(c?.title, 80) || "(untitled)";
      const price = snapClean(c?.price_text, 24);
      const addRef = typeof c?.add_ref === "string" ? c.add_ref : null;
      const detailRef = typeof c?.details_ref === "string" ? c.details_ref : null;
      let line = `- ${title}`;
      if (price) line += ` ${price}`;
      if (addRef) line += ` — add ref ${addRef} (browser_click)`;
      if (detailRef) line += `; open ref ${detailRef}`;
      lines.push(line);
    }
  }

  // ── Compact element list (fallback / full ref index) ──
  lines.push("");
  lines.push("Elements:");
  if (elements.length === 0) {
    lines.push("(no visible interactive elements found)");
  } else {
    for (const el of elements) {
      const kind = el?.kind ?? "element";
      const name = snapClean(el?.name, 120);
      const ref = el?.ref ?? "unknown";
      const clickable = el?.state?.clickable === true;
      const typeable = el?.state?.typeable === true;
      let line = `- ${kind} "${name}" [ref=${ref}] [clickable=${clickable}] [typeable=${typeable}]`;
      const status = typeof el?.viewport_status === "string" ? el.viewport_status : "";
      if (status) line += ` [viewport=${status}]`;
      const hrefPath = el?.hints?.href_path;
      if (hrefPath) line += ` [href_path=${snapClean(hrefPath, 160)}]`;
      // Allowlist-only: read just context.section + context.label (no other
      // backend fields), join them, and emit a single bounded [context="..."].
      const ctx = el?.context;
      if (ctx && typeof ctx === "object") {
        const combined = snapClean(`${ctx.section ?? ""} ${ctx.label ?? ""}`, 120);
        if (combined) line += ` [context="${combined}"]`;
      }
      lines.push(line);
    }
  }

  lines.push("");
  lines.push(
    "Use these refs with browser_click / browser_type / browser_scroll_to_ref" +
    " (see each action's action_hint).",
  );

  return lines.join("\n");
}

/** Formats one ranked-action line: `- ag_x [role] name — use <hint>`. */
function formatActionLine(a) {
  const ref = typeof a?.ref === "string" ? a.ref : "unknown";
  const role = snapClean(a?.role, 24);
  const name = snapClean(a?.name, 100);
  const hint = snapClean(a?.action_hint, 40) || "browser_click";
  return `- ${ref} [${role || "control"}] ${name || "(unlabeled)"} — use ${hint}`;
}

// ─── Navigation Discipline (Antigen Browser Realism v1) ───────────────────────
//
// Pure, side-effect-free heuristics that decide whether a browser_navigate call
// is an acceptable direct navigation or a shortcut that should have gone through
// page-grounded refs (browser_click / browser_type). These functions read ONLY
// the already-safe snapshot page-map fields (host, semantic affordances, and
// path-only href_path values) — never coordinates, query strings, cookies, or
// secrets. Blocking decisions are surfaced only in QA hard mode; default mode
// always returns decision:"allow" with a warn disposition for diagnostics.

/** Safe host extraction from a URL string. Returns "" when unparseable. */
function urlHost(input) {
  if (typeof input !== "string" || input.length === 0) return "";
  try {
    return new URL(input).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Safe path extraction (no query/fragment). Returns "" when unparseable. */
function urlPath(input) {
  if (typeof input !== "string" || input.length === 0) return "";
  try {
    return new URL(input).pathname || "";
  } catch {
    // Not absolute — strip any query/fragment and take what precedes it.
    const noQuery = input.split(/[?#]/)[0];
    const slash = noQuery.indexOf("/", noQuery.indexOf("://") + 3);
    return slash >= 0 ? noQuery.slice(slash) : "";
  }
}

/** Whether a URL string carries a non-empty query string. */
function urlHasQuery(input) {
  if (typeof input !== "string") return false;
  try {
    return new URL(input).search.length > 1;
  } catch {
    const q = input.split("#")[0].split("?")[1];
    return typeof q === "string" && q.length > 0;
  }
}

/**
 * Derive a compact, safe set of navigation hints from an antigen_snapshot page
 * map (the same `data` object handed to buildAntigenSnapshotText). Reads only
 * allowlisted page-map fields; never reads boxes/coords/secrets. Returns the
 * snapshot host plus booleans for the semantic affordances that justify a
 * ref-based path, and the path-only href list for exact-link matching.
 *
 * @param {object} data Snapshot v2 response data.
 * @returns {{ host: string, hasSearchInput: boolean, hasProductCards: boolean, hasCartRef: boolean, hasCheckoutRef: boolean, hrefPaths: string[] }}
 */
export function deriveNavHintsFromSnapshot(data) {
  const d = data ?? {};
  const summary = d.page_summary && typeof d.page_summary === "object" ? d.page_summary : {};
  const host = typeof summary.url_host === "string" ? summary.url_host.toLowerCase() : "";

  const elements = Array.isArray(d.elements) ? d.elements : [];
  const forms = Array.isArray(d.forms) ? d.forms : [];
  const cards = Array.isArray(d.product_cards) ? d.product_cards : [];
  const warnings = Array.isArray(d.warnings_or_modals) ? d.warnings_or_modals : [];
  const primary = Array.isArray(d.primary_actions) ? d.primary_actions : [];
  const secondary = Array.isArray(d.secondary_actions) ? d.secondary_actions : [];
  const navigation = Array.isArray(d.navigation) ? d.navigation : [];

  // A label/name/context string blob for one element or action (safe fields only).
  const blob = (el) => {
    const ctx = el && typeof el.context === "object" && el.context ? el.context : {};
    return `${el?.name ?? ""} ${ctx.section ?? ""} ${ctx.label ?? ""}`.toLowerCase();
  };
  const typeable = (el) => el?.state?.typeable === true || el?.kind === "input" || el?.kind === "textarea";

  const SEARCH_RE = /search|find|query|keyword|look\s?up/i;
  const CART_RE = /\b(cart|bag|basket)\b/i;
  const CHECKOUT_RE = /check\s?out|proceed to (checkout|payment|pay)|place order/i;

  const hasProductCards = cards.length > 0;

  const hasSearchInput =
    elements.some((el) => typeable(el) && SEARCH_RE.test(blob(el))) ||
    forms.some((f) => SEARCH_RE.test(`${f?.label ?? ""} ${f?.action_hint ?? ""}`.toLowerCase()));

  const cartDrawerOverlay = warnings.some((w) => w?.kind === "cart_drawer");
  const hasCartRef =
    cartDrawerOverlay ||
    elements.some((el) => CART_RE.test(blob(el))) ||
    [...primary, ...secondary, ...navigation].some((a) => CART_RE.test(`${a?.name ?? ""}`.toLowerCase()));

  const hasCheckoutRef =
    elements.some((el) => CHECKOUT_RE.test(blob(el))) ||
    [...primary, ...secondary].some((a) => CHECKOUT_RE.test(`${a?.name ?? ""}`.toLowerCase()));

  const hrefPaths = [];
  for (const el of elements) {
    const hp = el?.hints?.href_path;
    if (typeof hp === "string" && hp.length > 0) hrefPaths.push(hp);
  }

  return { host, hasSearchInput, hasProductCards, hasCartRef, hasCheckoutRef, hrefPaths };
}

// Path shapes that look like a product detail page on most retail sites.
const PRODUCT_PATH_RE = /\/(p|dp|gp\/product|product|products|item|items|pip|pd)\b/i;
const PRODUCT_TRAILING_ID_RE = /-\d{4,}\/?$/;
const CART_PATH_RE = /(cart|bag|basket|checkout|shoppingcart|shopping-cart)/i;
const SEARCH_PATH_RE = /(\/search|\/s\b|\/s\/|results|catalogsearch|\/find\b)/i;

function normalizePath(p) {
  if (typeof p !== "string" || p.length === 0) return "/";
  // Trim a single trailing slash for stable comparison (but keep root "/").
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Classify a browser_navigate target against the most recent snapshot's
 * affordances and decide whether it is an acceptable direct navigation or a
 * shortcut that bypasses available ref-based paths.
 *
 * Always-allow (clean) cases short-circuit first: first navigation, cross-site
 * navigation, top-level/home paths, and missing/stale snapshot hints. After
 * that, same-site product/search/cart deeplinks are flagged when a plausible
 * semantic affordance exists. Blocking happens ONLY when hardMode is true;
 * otherwise the same situation returns decision:"allow" with a warn disposition.
 *
 * @param {{ targetUrl: string, currentUrl: string|null, isFirstNavigation: boolean, navHints: (object|null), hardMode: boolean }} args
 * @returns {{ decision: "allow"|"block", disposition: string, reason: string, category: ("product"|"search"|"cart"|null) }}
 */
export function classifyNavigationDiscipline({ targetUrl, currentUrl, isFirstNavigation, navHints, hardMode }) {
  const allow = (reason, category = null) => ({
    decision: "allow",
    disposition: "direct_navigation_allowed",
    reason,
    category,
  });
  const warnOrBlock = (reason, category) =>
    hardMode === true
      ? { decision: "block", disposition: "direct_navigation_blocked", reason, category }
      : { decision: "allow", disposition: "direct_navigation_warned", reason, category };

  // 1. First navigation / no known current page → initial entry is always allowed.
  if (isFirstNavigation === true || !currentUrl) return allow("initial_navigation");

  const targetHost = urlHost(targetUrl);
  // Unparseable target → cannot reason about it; never block.
  if (!targetHost) return allow("no_matching_ref");

  // 2. Cross-site navigation (research → site, site → site) is always allowed.
  const currentHost = urlHost(currentUrl);
  if (currentHost && targetHost !== currentHost) return allow("cross_site_navigation");

  const path = normalizePath(urlPath(targetUrl));

  // 3. Top-level / home entry is always allowed.
  if (path === "" || path === "/") return allow("top_level_site_entry");

  // 4. Missing or stale snapshot → never block on stale refs.
  if (!navHints || typeof navHints !== "object") return allow("no_recent_snapshot");

  const hrefPaths = Array.isArray(navHints.hrefPaths) ? navHints.hrefPaths.map(normalizePath) : [];
  const hrefExactMatch = hrefPaths.includes(path);

  // 5. Cart / checkout deeplink.
  if (CART_PATH_RE.test(path)) {
    if (navHints.hasCartRef === true || navHints.hasCheckoutRef === true) {
      return warnOrBlock("cart_deeplink", "cart");
    }
    // Cart-shaped URL but no discoverable cart affordance — warn, never block.
    return { decision: "allow", disposition: "direct_navigation_warned", reason: "no_cart_ref", category: "cart" };
  }

  // 6. Product deeplink.
  const looksProduct = PRODUCT_PATH_RE.test(path) || PRODUCT_TRAILING_ID_RE.test(path);
  if (looksProduct) {
    const hasProductAffordance =
      navHints.hasProductCards === true || navHints.hasSearchInput === true || hrefExactMatch || hrefPaths.length > 0;
    if (hasProductAffordance) return warnOrBlock("same_site_product_deeplink", "product");
    return allow("no_matching_ref", "product");
  }

  // 7. Search-query deeplink.
  if (urlHasQuery(targetUrl) && SEARCH_PATH_RE.test(path)) {
    if (navHints.hasSearchInput === true) return warnOrBlock("same_site_search_deeplink", "search");
    return allow("no_matching_ref", "search");
  }

  // 8. Exact match to a visible link's path → click that link/result instead.
  if (hrefExactMatch) return warnOrBlock("href_exact_match", "product");

  // 9. Nothing matched a discoverable ref-based path → allow.
  return allow("no_matching_ref");
}

/**
 * Category-specific recovery guidance for a blocked direct navigation. Tells the
 * agent the concrete Antigen-owned next action to take instead of deep-linking.
 *
 * @param {("product"|"search"|"cart"|null)} category
 * @returns {string}
 */
export function navigationBlockMessage(category) {
  const prefix = "Direct navigation blocked in Antigen realistic-navigation QA mode.";
  if (category === "search") {
    return `${prefix} Use browser_type on the search input ref, then submit/click search.`;
  }
  if (category === "cart") {
    return `${prefix} Use browser_click on the cart/bag/checkout ref.`;
  }
  // product / generic link-result default
  return `${prefix} Use antigen_snapshot, then browser_click the product/result ref.`;
}
