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

/**
 * Builds the readable, agent-facing text for a successful antigen_snapshot.
 *
 * Allowlist-only: reads exclusively the safe external snapshot fields. Never
 * stringifies the raw backend payload, so any unexpected internal field
 * (box, x, y, width, height, cdp_url, secret_ref, etc.) the backend might
 * include can never leak into agent-visible output. Coordinates and boxes are
 * server-side only and are intentionally absent from this surface.
 *
 * @param {{ snapshot_id?: string, url?: string|null, title?: string|null,
 *           expires_at?: string|null, element_count?: number,
 *           elements?: Array<{ ref?: string, kind?: string, role?: string|null,
 *             name?: string, state?: { visible?: boolean, enabled?: boolean,
 *             clickable?: boolean, typeable?: boolean },
 *             hints?: { href_path?: string } }> }} data
 * @param {string} version
 * @returns {string}
 */
export function buildAntigenSnapshotText(data, version) {
  const d = data ?? {};
  const elements = Array.isArray(d.elements) ? d.elements : [];
  const elementCount = typeof d.element_count === "number" ? d.element_count : elements.length;

  const lines = [];
  lines.push(
    `Antigen snapshot complete; path=antigen_snapshot_success;` +
    ` snapshot_id=${d.snapshot_id ?? "unknown"}; element_count=${elementCount};` +
    ` source=antigen-browser-adapter@${version}`,
  );

  const meta = [];
  if (d.url) meta.push(`url: ${d.url}`);
  if (d.title) meta.push(`title: ${d.title}`);
  if (d.expires_at) meta.push(`expires_at: ${d.expires_at}`);
  if (meta.length > 0) {
    lines.push("");
    lines.push(...meta);
  }

  lines.push("");
  lines.push("Elements:");
  if (elements.length === 0) {
    lines.push("(no visible interactive elements found)");
  } else {
    for (const el of elements) {
      const kind = el?.kind ?? "element";
      const name = el?.name ?? "";
      const ref = el?.ref ?? "unknown";
      const clickable = el?.state?.clickable === true;
      const typeable = el?.state?.typeable === true;
      let line = `- ${kind} "${name}" [ref=${ref}] [clickable=${clickable}] [typeable=${typeable}]`;
      const hrefPath = el?.hints?.href_path;
      if (hrefPath) line += ` [href_path=${hrefPath}]`;
      // Allowlist-only: read just context.section + context.label (no other
      // backend fields), join them, and emit a single bounded [context="..."].
      const ctx = el?.context;
      if (ctx && typeof ctx === "object") {
        const section = typeof ctx.section === "string" ? ctx.section : "";
        const label = typeof ctx.label === "string" ? ctx.label : "";
        const combined = `${section} ${label}`.replace(/\s+/g, " ").trim();
        if (combined) line += ` [context="${combined.replace(/"/g, "'")}"]`;
      }
      lines.push(line);
    }
  }

  return lines.join("\n");
}
