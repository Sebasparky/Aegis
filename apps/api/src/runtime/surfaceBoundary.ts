/**
 * Surface-Boundary Router — SHADOW TELEMETRY ONLY (no behavior change).
 *
 * This is the pure, future-facing decision the planned `SurfaceBoundaryRouter`
 * (a.k.a. `OpaqueBoundaryRouter`) WOULD make about a dominant visible surface. It
 * is computed alongside the existing ambiguous visual-obstruction signals and is
 * logged under ANTIGEN_HV_DEBUG ONLY. It NEVER gates VGC minting, a 409, recheck,
 * or any current human-verification path — callers must not branch on its result.
 *
 * The architectural distinction it encodes (this is NOT "opaque == HV"):
 *
 *  - Inspectable dominant surface  → would route to a DOM/accessibility SEMANTIC
 *    classifier later (marketing modal, cookie banner, login wall, payment
 *    confirmation, ordinary site modal). "Inspectable" means "suitable for DOM
 *    semantic classification", NOT "not a blocker" — a readable login wall or
 *    payment confirmation is still a real boundary.
 *
 *  - Opaque + dominant + autonomy-relevant surface → would route to a VISUAL
 *    classifier candidate / protected-boundary review later (protected HV iframe,
 *    bot-prevention widget, opaque payment/identity widget, unknown protected
 *    boundary). "Opaque" means "needs visual classification", NOT "HV confirmed".
 *
 *  - Agent-stuck / repeated-stale / no-progress → FALLBACK ONLY, recorded via the
 *    `legacy_no_progress_fallback` trigger basis. Never the primary basis.
 *
 * Conservatism rule: a cross-origin iframe is only a visual-classifier candidate
 * when it is DOMINANT (covers the viewport center) or otherwise autonomy-relevant.
 * Cross-origin presence alone (a generic ad/embed) routes to `ignore_off_path`.
 *
 * Inputs are booleans only — no rects, coordinates, iframe src, raw text, or
 * screenshots ever reach this module.
 */

export type SurfaceInspectabilityClass = "inspectable" | "opaque" | "mixed" | "none";

export type SurfaceBoundaryRoute =
  | "visual_classifier_candidate"
  | "dom_semantic_candidate"
  | "ignore_off_path"
  | "none"
  | "unknown";

export type SurfaceBoundaryTriggerBasis =
  | "opaque_dominant_surface"
  | "unreadable_dominant_surface"
  | "inspectable_dominant_surface"
  | "off_path_iframe"
  | "legacy_no_progress_fallback"
  | "none";

/** Why a `visual_classifier_candidate` was proposed (shadow attribution only). */
export type SurfaceVisualClassifierCandidateReason =
  | "opaque_iframe"
  | "unreadable_dominant_surface"
  | "visual_dom_mismatch"
  | "none";

/**
 * Booleans-only signal surface. Structurally a superset-compatible subset of
 * `AmbiguousVisualObstructionProbe` plus the new surface-boundary fields, so the
 * existing probe object can be passed directly. All optional — absent ⇒ false.
 */
export interface SurfaceBoundarySignals {
  // Existing ambiguous-obstruction signals reused as policy inputs.
  denial_text_seen?: boolean;
  viewport_scrim_seen?: boolean;
  top_layer_dialog_seen?: boolean;
  large_centered_overlay_seen?: boolean;
  pointer_interceptor_seen?: boolean;
  visible_inaccessible_iframe_seen?: boolean;
  // Surface-boundary signals (computed in buildAmbiguousVisualObstructionExpr).
  visible_cross_origin_iframe_seen?: boolean;
  opaque_iframe_seen?: boolean;
  off_path_iframe_seen?: boolean;
  opaque_dominant_surface_seen?: boolean;
  surface_text_inspectable?: boolean;
  surface_text_uninspectable?: boolean;
  surface_over_main_content?: boolean;
  surface_blocks_viewport_center?: boolean;
  normal_page_dom_present_behind_surface?: boolean;
  background_refs_available_behind_surface?: boolean;
  visual_dom_contradiction_seen?: boolean;
  // Screen-scan signals (computed in buildPageHvWallHintExpr; always present on a
  // snapshot). These catch a dominant SAME-ORIGIN / textless wall the iframe-only
  // signals above cannot — the live B&BW/PerimeterX "Press & Hold" case.
  screen_viewport_scrim_seen?: boolean;
  screen_centered_modal_seen?: boolean;
  // Dominant-visible-surface inspectability: a visible dominant surface is present
  // but its semantic text was NOT extractable through the DOM/open-shadow scan
  // (challenge text inside an iframe document / closed shadow / canvas). This is the
  // `dominant_visible_surface_uninspectable` concept — opacity that is NOT a
  // cross-origin iframe. Booleans only; the harvested text never leaves the page.
  surface_dominant_visible_surface_seen?: boolean;
  surface_dominant_visible_surface_kind?:
    | "scrim_center_modal"
    | "top_layer_dialog"
    | "fixed_overlay"
    | "iframe"
    | "unknown";
  surface_dominant_text_extraction_attempted?: boolean;
  surface_dominant_text_extractable?: boolean;
  surface_dominant_text_uninspectable?: boolean;
  surface_visible_but_semantically_unclassified?: boolean;
}

export interface SurfaceBoundaryDecision {
  /** The route the future SurfaceBoundaryRouter WOULD take. Logged only. */
  route_decided: SurfaceBoundaryRoute;
  /** Why the route was reached. `legacy_no_progress_fallback` marks fallback origin. */
  trigger_basis: SurfaceBoundaryTriggerBasis;
  inspectability_class: SurfaceInspectabilityClass;
  /** Why a visual-classifier candidate was proposed (shadow attribution). */
  visual_classifier_candidate_reason: SurfaceVisualClassifierCandidateReason;
  /** Opaque dominant surface sitting over a still-present normal page DOM. */
  opaque_dominant_surface_with_background_dom_contradiction: boolean;
  /** v1: never plumbed (no snapshot baseline) — always "unknown". */
  surface_newly_appeared: "unknown";
  /** v1: "unknown" unless an action-target overlap was provided by the caller. */
  surface_overlaps_agent_target: "unknown" | boolean;
}

export interface ClassifySurfaceBoundaryOptions {
  /** Set true on the repeated-stale / no-progress action backstop path. */
  fromNoProgressFallback?: boolean;
  /** Whether the surface overlaps the agent's action target, when known. */
  overlapsAgentTarget?: boolean;
}

/**
 * Pure verdict mirroring `classifyAmbiguousVisualObstruction`'s shape. Side-effect
 * free, total over garbage input. Does NOT mutate or gate anything.
 */
export function classifySurfaceBoundary(
  signals: SurfaceBoundarySignals | null | undefined,
  opts: ClassifySurfaceBoundaryOptions = {},
): SurfaceBoundaryDecision {
  const s = signals && typeof signals === "object" ? signals : {};

  const opaqueIframe = s.opaque_iframe_seen === true; // dominant cross-origin iframe (can't read its text)
  const scrim = s.viewport_scrim_seen === true; // ambiguous probe scrim (>=0.85 coverage)
  const screenScrim = s.screen_viewport_scrim_seen === true; // screen scan scrim (>=0.5 coverage)
  const modal = s.top_layer_dialog_seen === true; // :modal top-layer dialog
  const screenCentered = s.screen_centered_modal_seen === true;
  const blocksCenter = s.surface_blocks_viewport_center === true;
  const overMain = s.surface_over_main_content === true;
  const offPath = s.off_path_iframe_seen === true;
  const inspectableText = s.surface_text_inspectable === true;
  const contradiction = s.visual_dom_contradiction_seen === true;
  const normalDomBehind =
    s.normal_page_dom_present_behind_surface === true ||
    s.background_refs_available_behind_surface === true;
  const overlapsTarget = opts.overlapsAgentTarget === true;

  // Dominant visible surface present but its semantic text was NOT extractable
  // through the DOM/open-shadow scan (text inside an iframe document, closed shadow,
  // or canvas). The extraction was attempted and produced nothing classifier-usable.
  const textAttempted = s.surface_dominant_text_extraction_attempted === true;
  const textExtractable = s.surface_dominant_text_extractable === true;
  const textUninspectable =
    s.surface_dominant_text_uninspectable === true || (textAttempted && !textExtractable);

  // A dominant surface is known to be present (scrim-backed centered / top-layer /
  // fixed wall) but its own text could not be read. The strict DOM probe may have
  // failed to isolate the surface's subtree on a live B&BW/PerimeterX "Press & Hold"
  // wall whose card renders in an iframe/closed shadow — so derive uninspectability
  // from the surface KIND when the source-of-truth boolean wasn't pre-set. Restricted
  // to scrim/centered/top-layer/fixed kinds (never a bare hero) and gated below by the
  // scrim+centered requirement so it cannot overfire.
  const dominantSeen = s.surface_dominant_visible_surface_seen === true;
  const dominantKind = s.surface_dominant_visible_surface_kind ?? "unknown";
  const dominantKindEligible =
    dominantKind === "scrim_center_modal" ||
    dominantKind === "top_layer_dialog" ||
    dominantKind === "fixed_overlay";

  // Aggregate dominance signals across BOTH probes: the ambiguous geometry probe
  // (iframe/0.85-scrim/pointer) and the always-present screen scan (0.5-scrim +
  // centered modal). The screen scan is what catches the same-origin / textless wall.
  const scrimAny = screenScrim || scrim;
  const centeredAny = screenCentered || s.large_centered_overlay_seen === true || blocksCenter;

  // Route 1 — OPAQUE: a dominant cross-origin iframe we cannot read. Cross-origin
  // presence alone is never enough — require dominance / center / contradiction /
  // explicit target overlap.
  const opaqueDominant = opaqueIframe;
  const opaqueAutonomyRelevant =
    opaqueDominant && (blocksCenter || overMain || contradiction || overlapsTarget);

  // Route 2 — UNREADABLE DOMINANT SURFACE (the dominant_visible_surface_uninspectable
  // concept): a scrim + centered surface is visibly present but its text is not
  // extractable. This is the live B&BW/PerimeterX "Press & Hold" wall whose card +
  // button render inside an iframe/shadow the DOM scan never descends into, so the
  // phrase scanner sees nothing. NOT a cross-origin iframe; opacity is semantic.
  const unreadableDominant =
    !opaqueDominant &&
    scrimAny &&
    centeredAny &&
    (textUninspectable || (dominantSeen && dominantKindEligible && !textExtractable));

  // Route 3 — INSPECTABLE: a readable surface WITH a genuine blocking backdrop /
  // top-layer modal (or a scrim+centered surface that DID yield text). A bare large
  // hero / carousel (no scrim, not :modal) is NOT a boundary and routes to `none`.
  const inspectableDominant =
    !opaqueIframe &&
    !unreadableDominant &&
    ((inspectableText && (scrim || modal)) ||
      (scrimAny && centeredAny && textAttempted && textExtractable));

  let route: SurfaceBoundaryRoute;
  let computedBasis: SurfaceBoundaryTriggerBasis;
  let reason: SurfaceVisualClassifierCandidateReason = "none";
  if (opaqueAutonomyRelevant) {
    route = "visual_classifier_candidate";
    computedBasis = "opaque_dominant_surface";
    reason = contradiction ? "visual_dom_mismatch" : "opaque_iframe";
  } else if (unreadableDominant) {
    route = "visual_classifier_candidate";
    computedBasis = "unreadable_dominant_surface";
    reason = "unreadable_dominant_surface";
  } else if (inspectableDominant) {
    route = "dom_semantic_candidate";
    computedBasis = "inspectable_dominant_surface";
  } else if (offPath) {
    route = "ignore_off_path";
    computedBasis = "off_path_iframe";
  } else {
    route = "none";
    computedBasis = "none";
  }

  // When the decision was reached via the repeated-stale / no-progress action
  // backstop, mark its fallback origin (a real route still computed above).
  const trigger_basis: SurfaceBoundaryTriggerBasis =
    opts.fromNoProgressFallback === true && route !== "none"
      ? "legacy_no_progress_fallback"
      : computedBasis;

  let inspectability_class: SurfaceInspectabilityClass;
  if (opaqueIframe && (inspectableText || normalDomBehind)) inspectability_class = "mixed";
  else if (opaqueIframe) inspectability_class = "opaque";
  else if (unreadableDominant) inspectability_class = "opaque"; // visible but semantically unreadable
  else if (inspectableDominant) inspectability_class = "inspectable";
  else inspectability_class = "none";

  return {
    route_decided: route,
    trigger_basis,
    inspectability_class,
    visual_classifier_candidate_reason: reason,
    opaque_dominant_surface_with_background_dom_contradiction:
      opaqueDominant && (contradiction || normalDomBehind),
    surface_newly_appeared: "unknown",
    surface_overlaps_agent_target:
      opts.overlapsAgentTarget === undefined ? "unknown" : opts.overlapsAgentTarget,
  };
}
