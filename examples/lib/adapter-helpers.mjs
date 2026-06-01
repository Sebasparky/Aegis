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
 * @param {"browser_type"|"browser_fill"|"browser_click"} toolName
 * @param {{ bucket?: string, hint?: string, focused?: boolean, submitted?: boolean, pointerPathPointCount?: number, pointerStartSource?: string, pointerStatePersisted?: boolean, version: string }} opts
 * @returns {string}
 */
export function buildSyntheticSuccessText(toolName, { bucket, hint, focused, submitted, pointerPathPointCount, pointerStartSource, pointerStatePersisted, version }) {
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
    if (pointerPathPointCount !== undefined) s += `; pointer_path_point_count=${pointerPathPointCount}`;
    if (pointerStartSource !== undefined) s += `; pointer_start_source=${pointerStartSource}`;
    if (pointerStatePersisted !== undefined) s += `; pointer_state_persisted=${pointerStatePersisted}`;
    s += `; source=antigen-browser-adapter@${version}`;
    return s;
  }
  // browser_fill and others — unchanged format
  return `Antigen realistic ${toolName} complete; path=realistic_success; char_count_bucket=${bucket}; source=antigen-browser-adapter@${version}`;
}
