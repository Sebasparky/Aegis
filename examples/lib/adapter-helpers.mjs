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
