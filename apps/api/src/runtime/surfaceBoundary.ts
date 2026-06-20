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
  | "inspectable_dominant_surface"
  | "off_path_iframe"
  | "legacy_no_progress_fallback"
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
  // New surface-boundary signals (computed in buildAmbiguousVisualObstructionExpr).
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
}

export interface SurfaceBoundaryDecision {
  /** The route the future SurfaceBoundaryRouter WOULD take. Logged only. */
  route_decided: SurfaceBoundaryRoute;
  /** Why the route was reached. `legacy_no_progress_fallback` marks fallback origin. */
  trigger_basis: SurfaceBoundaryTriggerBasis;
  inspectability_class: SurfaceInspectabilityClass;
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
  const scrim = s.viewport_scrim_seen === true;
  const modal = s.top_layer_dialog_seen === true; // :modal top-layer dialog
  const blocksCenter = s.surface_blocks_viewport_center === true;
  const overMain = s.surface_over_main_content === true;
  const offPath = s.off_path_iframe_seen === true;
  const inspectableText = s.surface_text_inspectable === true;
  const contradiction = s.visual_dom_contradiction_seen === true;
  const normalDomBehind =
    s.normal_page_dom_present_behind_surface === true ||
    s.background_refs_available_behind_surface === true;
  const overlapsTarget = opts.overlapsAgentTarget === true;

  // Opacity discriminator is the dominant cross-origin iframe ONLY. A scrim or
  // :modal with readable DOM text behind it is inspectable, not opaque.
  const opaqueDominant = opaqueIframe;
  // Cross-origin presence alone is never enough — require dominance / center /
  // contradiction / explicit target overlap.
  const opaqueAutonomyRelevant =
    opaqueDominant && (blocksCenter || overMain || contradiction || overlapsTarget);

  // An inspectable boundary worth DOM-semantic routing is readable surface text
  // WITH a genuine blocking backdrop or top-layer modal. A bare large hero /
  // carousel (no scrim, not :modal) is NOT a boundary and routes to `none`.
  const inspectableDominant = inspectableText && !opaqueIframe && (scrim || modal);

  let route: SurfaceBoundaryRoute;
  let computedBasis: SurfaceBoundaryTriggerBasis;
  if (opaqueAutonomyRelevant) {
    route = "visual_classifier_candidate";
    computedBasis = "opaque_dominant_surface";
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
  else if (inspectableDominant) inspectability_class = "inspectable";
  else inspectability_class = "none";

  return {
    route_decided: route,
    trigger_basis,
    inspectability_class,
    opaque_dominant_surface_with_background_dom_contradiction:
      opaqueDominant && (contradiction || normalDomBehind),
    surface_newly_appeared: "unknown",
    surface_overlaps_agent_target:
      opts.overlapsAgentTarget === undefined ? "unknown" : opts.overlapsAgentTarget,
  };
}
