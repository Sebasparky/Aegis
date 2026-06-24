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
 * @param {{ bucket?: string, hint?: string, focused?: boolean, submitted?: boolean, submitMethod?: string, pointerPathPointCount?: number, pointerStartSource?: string, pointerStatePersisted?: boolean, ref?: string, intentVerified?: boolean, verificationSignal?: string, outcome?: string, recommendedNextStep?: string, retriedOnce?: boolean, recoveryState?: string, surfaceResolutionState?: string, verifyMs?: number, settlePolls?: number, version: string }} opts
 * @returns {string}
 */
export function buildSyntheticSuccessText(toolName, { bucket, hint, focused, submitted, submitMethod, pointerPathPointCount, pointerStartSource, pointerStatePersisted, ref, changed, verified, actualValue, elementKind, intentVerified, verificationSignal, outcome, recommendedNextStep, retriedOnce, recoveryState, surfaceResolutionState, verifyMs, settlePolls, version }) {
  if (toolName === "browser_fill" || toolName === "browser_set_value" || toolName === "browser_clear") {
    // Exact-replacement result. Surfaces changed/verified and the read-back
    // actual value (non-sensitive — the backend refuses sensitive fields). The
    // agent should confirm verified=true and that actual matches its intent.
    let s = `Antigen ${toolName} complete; path=set_value_success`;
    if (changed !== undefined) s += `; changed=${changed}`;
    if (verified !== undefined) s += `; verified=${verified}`;
    if (elementKind !== undefined) s += `; element_kind=${elementKind}`;
    if (typeof actualValue === "string") s += `; actual="${snapClean(actualValue, 200)}"`;
    s += `; source=antigen-browser-adapter@${version}`;
    return s;
  }
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
    // Post-click intent verification (present only when the backend ran it).
    // Scalars only — enums/booleans/bounded ints; never page text or geometry.
    if (intentVerified !== undefined) s += `; intent_verified=${intentVerified === true}`;
    if (verificationSignal !== undefined) s += `; verification_signal=${snapClean(String(verificationSignal), 40)}`;
    if (outcome !== undefined) s += `; outcome=${snapClean(String(outcome), 40)}`;
    if (recommendedNextStep !== undefined) s += `; recommended_next_step=${snapClean(String(recommendedNextStep), 40)}`;
    if (retriedOnce === true) s += `; retried_once=true`;
    if (recoveryState !== undefined) s += `; recovery_state=${snapClean(String(recoveryState), 40)}`;
    if (surfaceResolutionState !== undefined) s += `; surface_resolution_state=${snapClean(String(surfaceResolutionState), 40)}`;
    if (typeof verifyMs === "number" && Number.isFinite(verifyMs)) s += `; verify_ms=${Math.max(0, Math.floor(verifyMs))}`;
    if (typeof settlePolls === "number" && Number.isFinite(settlePolls)) s += `; settle_polls=${Math.max(0, Math.floor(settlePolls))}`;
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
 * Builds the agent-facing post-click realization block from the backend's
 * sanitized `post_click_state` (browser_click response; ANTIGEN_CLICK_VERIFY).
 *
 * Allowlist-only, same discipline as buildAntigenSnapshotText: reads ONLY the
 * documented safe fields (change enum, query-free url paths, clipped titles,
 * ready_state, names-only surface actions). Never stringifies the raw payload,
 * so refs/boxes/hrefs/query strings the backend might ever include can never
 * leak. Returns "" when the state is absent/unusable.
 *
 * The block tells the agent what ALREADY happened so it does not wait, blind-
 * retry, or take exploratory snapshots: a page/route change, a modal, a closed
 * modal, still-loading, or genuinely nothing. Surface actions are NAMES ONLY —
 * refs always come from one fresh antigen_snapshot.
 *
 * @param {object|undefined} state post_click_state from the click response.
 * @param {{ intentVerified?: boolean }} [opts]
 * @returns {string} multi-line block ("" when not applicable)
 */
export function buildPostClickStateText(state, opts = {}) {
  if (!state || typeof state !== "object") return "";
  const change = snapClean(String(state.change ?? ""), 24);
  if (!change) return "";

  const lines = [];
  const headline = {
    navigation: "the page changed; you are on the new page now.",
    still_loading: "navigation detected but the document is still loading.",
    modal_opened: "a blocking dialog is now active.",
    modal_closed: "the overlay/dialog closed.",
    surface_changed: "a new overlay/panel is showing.",
    content_updated: "same URL, but the page content/title updated.",
    none: "nothing observable changed (click dispatched).",
    unknown: "the post-click page state could not be read.",
  }[change] ?? "post-click state recorded.";
  lines.push(`Post-click state: ${change} — ${headline}`);

  // URL path transition (backend-sanitized: pathname only, never query/fragment).
  const oldPath = snapClean(state.old_url_path, 160);
  const newPath = snapClean(state.new_url_path, 160);
  const ready = snapClean(state.document_ready_state, 16);
  if (state.url_changed === true && (oldPath || newPath)) {
    const host = snapClean(state.new_url_host, 120);
    lines.push(
      `URL path: ${oldPath || "(unknown)"} → ${host ? host : ""}${newPath || "(unknown)"}` +
      (ready ? ` (ready_state=${ready})` : ""),
    );
  } else if (change === "still_loading" && ready) {
    lines.push(`ready_state=${ready}`);
  }
  const oldTitle = snapClean(state.old_title, 120);
  const newTitle = snapClean(state.new_title, 120);
  if (state.title_changed === true && (oldTitle || newTitle)) {
    lines.push(`Title: "${oldTitle}" → "${newTitle}"`);
  }

  // Active surface after the click (modal/drawer/panel) — names only.
  const surface = state.surface && typeof state.surface === "object" ? state.surface : null;
  if (surface) {
    const type = snapClean(surface.overlay_type, 24) || "overlay";
    const title = snapClean(surface.title, 120);
    lines.push(
      `Post-click surface: ${type}${surface.overlay_blocking === true ? " (blocking)" : ""}${title ? ` — "${title}"` : ""}`,
    );
    const actions = Array.isArray(surface.surface_actions) ? surface.surface_actions : [];
    if (actions.length > 0) {
      lines.push("Surface actions (names only — refs require one antigen_snapshot):");
      for (const a of actions) {
        const name = snapClean(a?.name, 80);
        if (!name) continue;
        let line = `- ${snapClean(a?.classification, 16) || "secondary"} "${name}"`;
        if (a?.requires_handoff === true) line += " [requires_handoff]";
        lines.push(line);
      }
    }
  }

  // One decisive next step. An absorbed click (unverified + blocking surface
  // still up) gets the explicit warning instead of a generic refresh hint.
  const nextStep = snapClean(state.recommended_next_step, 40);
  if (opts.intentVerified === false && surface && surface.overlay_blocking === true && change !== "modal_opened") {
    lines.push(
      "Next: a blocking surface is still active — your click was likely absorbed by it; act on this surface (or its dismiss action) via a fresh antigen_snapshot.",
    );
  } else if (change === "still_loading") {
    lines.push("Next: wait briefly for the page to finish loading, then take one antigen_snapshot.");
  } else if (change === "none") {
    lines.push(
      `Next: recommended_next_step=${nextStep || "refresh_snapshot"} — re-snapshot before retrying; do not blind-retry this ref.`,
    );
  } else if (change === "unknown") {
    lines.push("Next: take one antigen_snapshot to confirm the current page state.");
  } else {
    lines.push(
      "Next: the click already produced this state — do NOT re-click or wait; take one antigen_snapshot and act on the fresh refs.",
    );
  }
  return lines.join("\n");
}

/**
 * Builds the agent-facing post-fill realization block from the backend's
 * sanitized `post_fill_state` (profile/payment fill execute responses;
 * ANTIGEN_FILL_STATE). The protected-fill analogue of buildPostClickStateText.
 *
 * Allowlist-only, same discipline: reads ONLY the documented safe fields
 * (outcome enum, counts, names-only actions with disabled/handoff flags,
 * masking summary). Never stringifies the raw payload. Returns "" when the
 * state is absent/unusable.
 *
 * The block tells the agent the fill ALREADY landed (or didn't), that masking/
 * redaction is already in order, and exactly what to do next — so it does not
 * re-snapshot repeatedly, scroll-hunt for "Continue", or take an extra
 * redaction-verification screenshot. Actions are NAMES ONLY — refs always come
 * from one fresh antigen_snapshot.
 *
 * @param {object|undefined} state post_fill_state from the fill execute response.
 * @returns {string} multi-line block ("" when not applicable)
 */
export function buildPostFillStateText(state) {
  if (!state || typeof state !== "object") return "";
  const outcome = snapClean(String(state.outcome ?? ""), 32);
  if (!outcome) return "";

  const lines = [];
  const headline = {
    ready_for_next_action: "the fill landed and an enabled next action is available.",
    handoff_required_next: "the fill landed; the only enabled next actions are final/irreversible and must go through the Aegis handoff tools.",
    validation_errors_present: "the page is showing validation errors after the fill.",
    fill_incomplete: "one or more fields failed to fill — check filled_fields.",
    no_next_action_visible: "the fill landed but no enabled next action is visible (it may be outside the viewport).",
    unknown: "the post-fill page state could not be read; the fill result fields are still authoritative.",
  }[outcome] ?? "post-fill state recorded.";
  lines.push(`Post-fill state: ${outcome} — ${headline}`);

  const filled = typeof state.filled_count === "number" ? state.filled_count : null;
  const failed = typeof state.failed_count === "number" ? state.failed_count : null;
  const validation = typeof state.validation_error_count === "number" ? state.validation_error_count : null;
  if (filled !== null || failed !== null) {
    let line = `Fill result: ${filled ?? "?"} filled, ${failed ?? "?"} failed`;
    if (validation !== null) line += `; validation_errors=${validation}`;
    lines.push(line);
  }

  // Masking / redaction — already verified server-side; no screenshot needed.
  const masking = state.masking && typeof state.masking === "object" ? state.masking : null;
  if (masking) {
    const parts = [];
    if (typeof masking.dom_filled_marker_count === "number") {
      parts.push(`${masking.dom_filled_marker_count} DOM fill markers`);
    }
    if (typeof masking.visual_mask_marker_count === "number") {
      parts.push(`${masking.visual_mask_marker_count} visually masked`);
    }
    if (Array.isArray(masking.iframe_redaction_fields) && masking.iframe_redaction_fields.length > 0) {
      const kinds = masking.iframe_redaction_fields
        .map((k) => snapClean(String(k), 24))
        .filter(Boolean)
        .join(", ");
      if (kinds) parts.push(`iframe redaction registered: ${kinds}`);
    }
    if (parts.length > 0) lines.push(`Masking: ${parts.join("; ")}`);
    if (masking.iframe_redaction_mismatch === true) {
      lines.push(
        "WARNING: a just-filled iframe field is MISSING from the screenshot-redaction registry — do not take screenshots of this page; surface this state to the user.",
      );
    }
  }

  // Candidate next actions — names only, with disabled/handoff flags.
  const actions = Array.isArray(state.next_action_names) ? state.next_action_names : [];
  let primaryName = "";
  if (actions.length > 0) {
    lines.push("Next actions (names only — refs require one antigen_snapshot):");
    for (const a of actions) {
      const name = snapClean(a?.name, 80);
      if (!name) continue;
      const cls = snapClean(a?.classification, 16) || "secondary";
      if (cls === "primary" && !primaryName) primaryName = name;
      let line = `- ${cls} "${name}"`;
      if (a?.disabled === true) line += " [disabled]";
      if (a?.requires_handoff === true) line += " [requires_handoff]";
      lines.push(line);
    }
  }

  // Active surface after the fill (modal/drawer) — names only.
  const surface = state.surface && typeof state.surface === "object" ? state.surface : null;
  if (surface) {
    const type = snapClean(surface.overlay_type, 24) || "overlay";
    const title = snapClean(surface.title, 120);
    lines.push(
      `Post-fill surface: ${type}${surface.overlay_blocking === true ? " (blocking)" : ""}${title ? ` — "${title}"` : ""}`,
    );
  }

  // One decisive next step per outcome.
  if (outcome === "ready_for_next_action") {
    lines.push(
      primaryName
        ? `Next: take ONE antigen_snapshot and click "${primaryName}" — do not scroll-hunt, re-verify the fill, or take a redaction screenshot; masking is already reported above.`
        : "Next: take ONE antigen_snapshot and click one of the enabled actions above — do not scroll-hunt or re-verify the fill.",
    );
  } else if (outcome === "validation_errors_present") {
    lines.push("Next: take one antigen_snapshot and review the flagged fields before continuing — do not retry the fill blindly.");
  } else if (outcome === "handoff_required_next") {
    lines.push("Next: do NOT click the final action yourself — use the Aegis purchase-confirmation / handoff tools for it.");
  } else if (outcome === "fill_incomplete") {
    lines.push("Next: check filled_fields for the failed entries, take one antigen_snapshot, and re-request only the failed fields.");
  } else if (outcome === "no_next_action_visible") {
    lines.push("Next: take one antigen_snapshot and find the next action there — do not blind-scroll first.");
  } else {
    lines.push("Next: take one antigen_snapshot to confirm the current page state.");
  }
  return lines.join("\n");
}

/**
 * Pass-through wrapper used by the fill execute tool handlers: preserves the
 * API response untouched (including `post_fill_state` when present) and appends
 * the rendered `post_fill_summary` when the state is usable. The API response
 * is NEVER stripped — when `post_fill_state` is absent or unrenderable the data
 * object is returned unchanged (no `post_fill_summary` key added).
 *
 * Extracted from the inline blocks in the execute_profile_field_fill /
 * execute_payment_card_fill_handoff handlers so the pass-through contract is
 * unit-testable (importing the tool server itself starts it).
 *
 * @param {object|undefined} data the API response `data` object
 * @returns {object|undefined} same data, plus `post_fill_summary` when renderable
 */
export function withPostFillSummary(data) {
  if (!data || typeof data !== "object" || !data.post_fill_state) return data;
  const summary = buildPostFillStateText(data.post_fill_state);
  return summary ? { ...data, post_fill_summary: summary } : data;
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

  // ── Active surfaces (ANTIGEN_ACTIVE_SURFACES; fields absent when off) ──
  // The semantic surface view: while a panel/dialog/drawer is up, its stable
  // actions are the reliable click targets — background refs may be blocked or
  // churning. Allowlist-only rendering; never geometry or internal flags.
  const surfaces = Array.isArray(d.active_surfaces) ? d.active_surfaces : [];
  if (surfaces.length > 0) {
    lines.push("");
    lines.push("Active surfaces:");
    for (const s of surfaces) {
      const sid = snapClean(s?.surface_id, 16) || "surf";
      const type = snapClean(s?.surface_type, 24) || "overlay";
      const title = snapClean(s?.title, 120);
      lines.push(`- ${sid}: ${type}${s?.blocking === true ? " (blocking)" : ""}${title ? ` — "${title}"` : ""}`);
      const surfaceActions = Array.isArray(s?.actions) ? s.actions : [];
      for (const a of surfaceActions) {
        const ref = typeof a?.ref === "string" ? a.ref : "unknown";
        let line = `  - ${snapClean(a?.classification, 16) || "secondary"} "${snapClean(a?.name, 80)}" [ref=${ref}]`;
        if (a?.requires_handoff === true) line += " [requires_handoff]";
        lines.push(line);
      }
    }
  }
  const recommended = Array.isArray(d.recommended_actions) ? d.recommended_actions : [];
  if (recommended.length > 0) {
    lines.push("");
    lines.push("Recommended actions (prefer these over background refs while a surface is active):");
    for (const r of recommended) {
      const recRef = typeof r?.ref === "string" ? r.ref : "unknown";
      lines.push(`- ${snapClean(r?.classification, 16) || "action"} "${snapClean(r?.name, 80)}" [ref=${recRef}] (browser_click)`);
    }
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
      // Behind an active blocking surface (flag-gated, boolean only): prefer the
      // surface's recommended actions over this ref.
      if (el?.likely_blocked_by_overlay === true) line += " [likely_blocked_by_overlay]";
      const hrefPath = el?.hints?.href_path;
      if (hrefPath) line += ` [href_path=${snapClean(hrefPath, 160)}]`;
      // Allowlist-only: read just context.section + context.label (no other
      // backend fields), join them, and emit a single bounded [context="..."].
      const ctx = el?.context;
      if (ctx && typeof ctx === "object") {
        const combined = snapClean(`${ctx.section ?? ""} ${ctx.label ?? ""}`, 120);
        if (combined) line += ` [context="${combined}"]`;
      }
      // Allowlist-only current-value hint so the agent can SKIP already-correct
      // fields. Sensitive fields show only present/length — never the value.
      const v = el?.value;
      if (v && typeof v === "object") {
        const vparts = [];
        if (v.sensitive === true) {
          vparts.push(`present=${v.present === true}`);
          if (typeof v.length === "number") vparts.push(`len=${v.length}`);
          vparts.push("sensitive");
        } else {
          if (typeof v.text === "string") vparts.push(`current="${snapClean(v.text, 80)}"`);
          else if (typeof v.selected_text === "string") vparts.push(`selected="${snapClean(v.selected_text, 80)}"`);
          else if (typeof v.present === "boolean") vparts.push(`present=${v.present}`);
          if (v.checked === true) vparts.push("checked");
          if (v.required === true) vparts.push("required");
          if (v.invalid === true) vparts.push("invalid");
        }
        if (vparts.length > 0) line += ` [value: ${vparts.join(", ")}]`;
      }
      lines.push(line);
    }
  }

  lines.push("");
  lines.push(
    "Use these refs with browser_click / browser_scroll_to_ref, browser_type" +
    " (append/search only), and browser_fill / browser_set_value (exact form" +
    " values). Skip fields whose [value: ...] already matches your intent.",
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
 * Reduce a URL to host + path only (query/fragment stripped), for sanitized
 * stderr diagnostics. Mirrors the backend `sanitizeTraceUrl` contract so the
 * adapter never logs raw query strings, secrets, or coordinates. Returns ""
 * when the input is empty/unparseable-without-host.
 */
export function sanitizeHostPath(input) {
  const host = urlHost(input);
  if (!host) return "";
  const path = urlPath(input);
  return path && path !== "/" ? `${host}${path}` : host;
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
 * Whether a same-site navigation is a safe entry/recovery path that may proceed
 * even without a fresh snapshot in hard mode. Conservative by design: only an
 * explicit reload/refresh of the current page, or a search-LANDING page WITHOUT
 * a query string, qualify. Cart/checkout and product deep links are never
 * recovery paths.
 *
 * @param {{ targetUrl: string, currentUrl: (string|null), path: string }} args  `path` is the normalized target path.
 * @returns {boolean}
 */
function isSafeRecoveryPath({ targetUrl, currentUrl, path }) {
  const curHost = urlHost(currentUrl);
  const tgtHost = urlHost(targetUrl);
  // Explicit reload/refresh of the current page (same host + same path).
  if (curHost && tgtHost === curHost && normalizePath(urlPath(currentUrl)) === path) return true;
  // Cart/checkout and product deep links are never recovery paths.
  if (CART_PATH_RE.test(path)) return false;
  if (PRODUCT_PATH_RE.test(path) || PRODUCT_TRAILING_ID_RE.test(path)) return false;
  // Search-landing page WITHOUT a query string is an acceptable entry/recovery path.
  if (SEARCH_PATH_RE.test(path) && !urlHasQuery(targetUrl)) return true;
  return false;
}

/**
 * Classify a browser_navigate target against the most recent snapshot's
 * affordances and decide whether it is an acceptable direct navigation or a
 * shortcut that bypasses available ref-based paths.
 *
 * Always-allow (clean) cases short-circuit first: first navigation, cross-site
 * navigation, and top-level/home paths. In DEFAULT mode, missing/stale snapshot
 * hints are also always allowed. In HARD mode, a missing/stale snapshot is NOT a
 * free pass: same-site product/detail/search-query/cart/checkout/deep navigation
 * is blocked (a fresh antigen_snapshot is the precondition), while safe
 * entry/recovery paths still proceed. After a fresh snapshot exists, same-site
 * product/search/cart deeplinks are flagged when a plausible semantic affordance
 * exists. Blocking happens ONLY when hardMode is true; otherwise the same
 * situation returns decision:"allow" with a warn disposition.
 *
 * @param {{ targetUrl: string, currentUrl: string|null, isFirstNavigation: boolean, navHints: (object|null), hardMode: boolean }} args
 * @returns {{ decision: "allow"|"block", disposition: string, reason: string, category: ("product"|"search"|"cart"|"snapshot_required"|null) }}
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

  // 4. Missing or stale snapshot hints.
  if (!navHints || typeof navHints !== "object") {
    // Default mode: never block on stale/missing hints (diagnostic only).
    if (hardMode !== true) return allow("no_recent_snapshot");
    // Hard mode: a fresh antigen_snapshot is a precondition for same-site deep
    // navigation. Safe entry/recovery shapes are still allowed; everything else
    // (product/detail/search-query/cart/checkout/deep) is blocked so the agent
    // must establish a page map before deep-linking around visible refs.
    if (isSafeRecoveryPath({ targetUrl, currentUrl, path })) return allow("no_recent_snapshot");
    return {
      decision: "block",
      disposition: "direct_navigation_blocked",
      reason: "fresh_snapshot_required",
      category: "snapshot_required",
    };
  }

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
  if (category === "snapshot_required") {
    return `${prefix} Use antigen_snapshot first, then use browser_click/browser_type/browser_scroll_to_ref with visible refs.`;
  }
  if (category === "search") {
    return `${prefix} Use browser_type on the search input ref, then submit/click search.`;
  }
  if (category === "cart") {
    return `${prefix} Use browser_click on the cart/bag/checkout ref.`;
  }
  // product / generic link-result default
  return `${prefix} Use antigen_snapshot, then browser_click the product/result ref.`;
}

/**
 * Error code the Antigen snapshot endpoint returns (HTTP 422) when, in
 * vision capture-and-skip exploration mode (ANTIGEN_VISION_CAPTURE_AND_SKIP),
 * a visual blocker was detected and captured for training. This is NOT a failed
 * snapshot and NOT a human-verification challenge — it is an intentional Antigen
 * policy outcome that means "skip this site/path and move on."
 * @type {"ANTIGEN_VISUAL_BLOCKER_CAPTURED"}
 */
export const VISUAL_BLOCKER_CAPTURED_CODE = "ANTIGEN_VISUAL_BLOCKER_CAPTURED";

/**
 * Agent-facing skip directive emitted (as a NON-error MCP result) for the 422
 * VISUAL_BLOCKER_CAPTURED_CODE. Deliberately frames this as a "visual blocker"
 * "captured for training" — NOT human verification — so the agent skips and
 * gathers data instead of routing the user into the HV / Aegis-UI flow.
 *
 * Safe text only: no challenge details, screenshot paths, URLs, coordinates,
 * base64, iframe srcs, or dataset paths. Never tells the user to open Aegis UI
 * or to solve anything.
 * @type {string}
 */
export const VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT =
  "Antigen captured a visual blocker for training, so skip this site/path and move on. " +
  "Do NOT ask the user to act, and do NOT route this to a person to handle. " +
  "Do NOT retry this snapshot, and do NOT press, click, or type into the blocker. " +
  "No page elements were returned. " +
  "If the task supports exploration, continue with another site, query, or path. " +
  "If there is nowhere else to go, report that this path was blocked and captured for training.";

/**
 * Classifies an Antigen snapshot-endpoint error code into the adapter's handling
 * kind. Pure and stateless: the same code always maps to the same kind, so
 * repeated 422s yield the same skip directive without any adapter state.
 *
 * - "visual_blocker_captured" → emit VISUAL_BLOCKER_SKIP_DIRECTIVE_TEXT as a
 *    NON-error MCP result (skip-and-continue).
 * - "session_not_found"       → existing SESSION_NOT_FOUND error message (unchanged).
 * - "generic"                 → existing generic snapshot-failed error (unchanged,
 *    incl. HUMAN_VERIFICATION_REQUIRED, which keeps its 409 behavior).
 *
 * @param {string} errCode
 * @returns {"visual_blocker_captured" | "session_not_found" | "generic"}
 */
export function classifySnapshotApiErrorKind(errCode) {
  if (errCode === VISUAL_BLOCKER_CAPTURED_CODE) return "visual_blocker_captured";
  if (errCode === "SESSION_NOT_FOUND") return "session_not_found";
  return "generic";
}

/**
 * Whitelist-extract the safe `human_verification_attribution` object the Aegis API
 * attaches to every HUMAN_VERIFICATION_REQUIRED 409 body, so it can be surfaced to
 * the MCP tool caller. Pure and defensive: copies ONLY the approved scalar fields
 * (string/boolean), each behind a type guard, and drops everything else — so even
 * if the API shape changes, no URL, path, query, selector, coordinate, frame path,
 * ref, raw text, or nested object can leak through this layer. The API already
 * sanitizes `reason`; we surface that sanitized value as-is and never derive our own.
 *
 * Returns `null` when attribution is absent, not an object, or when every field was
 * dropped (never returns `{}`), so non-HV errors stay byte-identical downstream.
 *
 * @param {any} errBody Parsed API error body (`{ error: { ... } }`).
 * @returns {null | {
 *   source?: string,
 *   visual_judgment_coverage?: string,
 *   fresh_visual_judgment_event_expected?: boolean,
 *   reason?: string,
 *   trigger_basis?: string,
 *   visual_judgment_ran?: boolean,
 *   visual_judgment_outcome?: string,
 *   visual_judgment_suppress?: boolean,
 * }}
 */
export function extractSafeHvAttribution(errBody) {
  const raw = errBody?.error?.human_verification_attribution;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  // Whitelist of approved keys → expected primitive type. Anything not listed here
  // (frame_path, url, selector, ref ids, boxes, nested objects) is never copied.
  const stringKeys = [
    "source",
    "visual_judgment_coverage",
    "reason",
    "trigger_basis",
    "visual_judgment_outcome",
  ];
  const booleanKeys = [
    "fresh_visual_judgment_event_expected",
    "visual_judgment_ran",
    "visual_judgment_suppress",
  ];

  const out = {};
  for (const k of stringKeys) {
    if (typeof raw[k] === "string") out[k] = raw[k];
  }
  for (const k of booleanKeys) {
    if (typeof raw[k] === "boolean") out[k] = raw[k];
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Build the additive, machine-readable suffix appended to a tool-visible error
 * message when safe HV attribution is present. Returns "" for null/empty so the
 * message is byte-identical when there is nothing to surface. The serialized object
 * is a whitelisted scalar-only map (see extractSafeHvAttribution), so the JSON is
 * safe to hand to the agent.
 *
 * @param {ReturnType<typeof extractSafeHvAttribution>} attribution
 * @returns {string}
 */
export function buildHvAttributionText(attribution) {
  if (!attribution || typeof attribution !== "object" || Object.keys(attribution).length === 0) {
    return "";
  }
  return ` human_verification_attribution=${JSON.stringify(attribution)}`;
}

/**
 * Extracts the safe, agent-facing OWNERSHIP fields from a confirmed
 * HUMAN_VERIFICATION_REQUIRED 409 so the agent's tool result carries a
 * machine-readable signal — not just prose — that Antigen owns the handoff and the
 * agent must wait. Mirrors extractSafeHvAttribution: a strict scalar whitelist, so
 * no value, coordinate, selector, ref, raw text, or nested object can leak. The API
 * already builds these fields; we surface them as-is.
 *
 * Returns `null` when none are present (e.g. non-HV errors, or the uncertain
 * ACTION_BLOCKED_DOMINANT_SURFACE review which is intentionally NOT a handoff), so
 * downstream output stays byte-identical for those paths.
 *
 * @param {any} errBody Parsed API error body (`{ error: { ... } }`).
 * @returns {null | {
 *   handoff_owner?: string,
 *   handoff_type?: string,
 *   confirmed_human_verification?: boolean,
 *   agent_should_wait?: boolean,
 *   agent_must_not_solve?: boolean,
 *   requires_user_attention?: boolean,
 *   capsule_id?: string,
 *   request_id?: string,
 * }}
 */
export function extractSafeHvHandoff(errBody) {
  const raw = errBody?.error;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  // Only emit a handoff block for a CONFIRMED HV handoff. The uncertain
  // dominant-surface review sets confirmed_human_verification === false and must
  // never be surfaced as an Antigen-owned HV handoff.
  if (raw.confirmed_human_verification !== true) return null;

  const stringKeys = ["handoff_owner", "handoff_type", "capsule_id", "request_id"];
  const booleanKeys = [
    "confirmed_human_verification",
    "agent_should_wait",
    "agent_must_not_solve",
    "requires_user_attention",
  ];

  const out = {};
  for (const k of stringKeys) {
    if (typeof raw[k] === "string") out[k] = raw[k];
  }
  for (const k of booleanKeys) {
    if (typeof raw[k] === "boolean") out[k] = raw[k];
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Build the additive, machine-readable suffix for confirmed HV handoff ownership.
 * Returns "" for null/empty so the message is byte-identical when there is nothing
 * to surface. The serialized object is a whitelisted scalar-only map (see
 * extractSafeHvHandoff), so the JSON is safe to hand to the agent.
 *
 * @param {ReturnType<typeof extractSafeHvHandoff>} handoff
 * @returns {string}
 */
export function buildHvHandoffText(handoff) {
  if (!handoff || typeof handoff !== "object" || Object.keys(handoff).length === 0) {
    return "";
  }
  return ` human_verification_handoff=${JSON.stringify(handoff)}`;
}

/**
 * Extract the SAFE-ONLY payment-card-fill bridge block from a runtime fill-boundary
 * refusal (browser_set_value / browser_fill / browser_clear / browser_type). When the
 * Antigen backend detects a payment field it fails closed AND server-side creates a
 * pending payment-card-fill authorization, surfacing it under error.payment_card_fill so
 * the agent learns the authorization already exists and should call
 * wait_for_payment_card_fill_authorization (NOT request_payment_card_fill again). Also
 * surfaces the missing-payment-method state (error.missing_payment_method) so the agent
 * does not prompt the user to approve a nonexistent request. Whitelisted scalars only —
 * never payment_method_id, PAN, CVV, expiry, refs beyond the opaque
 * authorization_id/fill_request_id, or any value.
 *
 * @param {any} errBody
 * @returns {Record<string, unknown> | null}
 */
export function extractSafePaymentCardFillBridge(errBody) {
  const raw = errBody?.error;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  // Missing-payment-method state takes precedence — there is no authorization to wait on.
  if (raw.missing_payment_method === true) {
    return { missing_payment_method: true };
  }

  const pcf = raw.payment_card_fill;
  if (!pcf || typeof pcf !== "object" || Array.isArray(pcf)) return null;
  if (pcf.bridged !== true) return null;

  const stringKeys = [
    "authorization_id",
    "fill_request_id",
    "status",
    "field",
    "domain",
    "payment_method_label",
    "last4",
    "expires_at",
    "next_action",
  ];
  const out = { bridged: true };
  for (const k of stringKeys) {
    if (typeof pcf[k] === "string") out[k] = pcf[k];
  }
  return out;
}

/**
 * Build the additive, machine-readable suffix for the payment-card-fill bridge.
 * Returns "" for null/empty so the message is byte-identical when there is nothing to
 * surface. The serialized object is a whitelisted scalar-only map (see
 * extractSafePaymentCardFillBridge), safe to hand to the agent.
 *
 * @param {ReturnType<typeof extractSafePaymentCardFillBridge>} bridge
 * @returns {string}
 */
export function buildPaymentCardFillBridgeText(bridge) {
  if (!bridge || typeof bridge !== "object" || Object.keys(bridge).length === 0) {
    return "";
  }
  return ` payment_card_fill=${JSON.stringify(bridge)}`;
}
