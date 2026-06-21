/**
 * Surface-Boundary Router — SHADOW telemetry pure-verdict truth table.
 *
 * `classifySurfaceBoundary` is observational only: it records the route a future
 * SurfaceBoundaryRouter WOULD take for a dominant visible surface. It must NEVER
 * gate VGC minting / a 409 / recheck, and it must reproduce the architectural
 * distinction:
 *   - inspectable dominant surface  → dom_semantic_candidate
 *   - opaque + dominant + relevant   → visual_classifier_candidate (NOT "HV confirmed")
 *   - off-path / non-dominant iframe  → ignore_off_path
 *   - repeated-stale / no-progress    → legacy_no_progress_fallback basis (fallback only)
 *
 * A readable login wall / payment confirmation is still a real boundary — it routes
 * to the DOM semantic classifier, not to the opaque visual path.
 */

import { describe, it, expect } from "vitest";
import { classifySurfaceBoundary } from "../runtime/surfaceBoundary.js";

describe("classifySurfaceBoundary — pure shadow verdict", () => {
  it("returns none/none for empty or garbage input", () => {
    for (const input of [undefined, null, {}] as const) {
      const d = classifySurfaceBoundary(input);
      expect(d.route_decided).toBe("none");
      expect(d.trigger_basis).toBe("none");
      expect(d.inspectability_class).toBe("none");
      expect(d.surface_newly_appeared).toBe("unknown");
      expect(d.surface_overlaps_agent_target).toBe("unknown");
    }
  });

  it("opaque DOMINANT iframe over a normal page → visual_classifier_candidate (mixed, contradiction)", () => {
    const d = classifySurfaceBoundary({
      opaque_iframe_seen: true,
      visible_cross_origin_iframe_seen: true,
      opaque_dominant_surface_seen: true,
      surface_over_main_content: true,
      surface_blocks_viewport_center: true,
      surface_text_uninspectable: true,
      normal_page_dom_present_behind_surface: true,
      visual_dom_contradiction_seen: true,
    });
    expect(d.route_decided).toBe("visual_classifier_candidate");
    expect(d.trigger_basis).toBe("opaque_dominant_surface");
    expect(d.inspectability_class).toBe("mixed");
    expect(d.opaque_dominant_surface_with_background_dom_contradiction).toBe(true);
  });

  it("opaque DOMINANT iframe full-denial wall (no bg DOM) → visual_classifier_candidate (opaque)", () => {
    const d = classifySurfaceBoundary({
      opaque_iframe_seen: true,
      visible_cross_origin_iframe_seen: true,
      opaque_dominant_surface_seen: true,
      surface_over_main_content: true,
      surface_text_uninspectable: true,
      normal_page_dom_present_behind_surface: false,
    });
    expect(d.route_decided).toBe("visual_classifier_candidate");
    expect(d.inspectability_class).toBe("opaque");
  });

  it("centered scrim modal with READABLE text → dom_semantic_candidate (the live B&BW shape, but text extractable)", () => {
    const d = classifySurfaceBoundary({
      screen_viewport_scrim_seen: true,
      screen_centered_modal_seen: true,
      surface_dominant_visible_surface_seen: true,
      surface_dominant_text_extraction_attempted: true,
      surface_dominant_text_extractable: true,
    });
    expect(d.route_decided).toBe("dom_semantic_candidate");
    expect(d.trigger_basis).toBe("inspectable_dominant_surface");
    expect(d.inspectability_class).toBe("inspectable");
    expect(d.visual_classifier_candidate_reason).toBe("none");
  });

  it("centered scrim modal with NO extractable text → visual_classifier_candidate / unreadable_dominant_surface (the B&BW/PerimeterX miss)", () => {
    const d = classifySurfaceBoundary({
      screen_viewport_scrim_seen: true,
      screen_centered_modal_seen: true,
      surface_dominant_visible_surface_seen: true,
      surface_dominant_text_extraction_attempted: true,
      surface_dominant_text_extractable: false,
      surface_dominant_text_uninspectable: true,
      surface_visible_but_semantically_unclassified: true,
      // Critically: NO cross-origin iframe signal — opacity is semantic, not iframe.
      opaque_iframe_seen: false,
      visible_inaccessible_iframe_seen: false,
    });
    expect(d.route_decided).toBe("visual_classifier_candidate");
    expect(d.trigger_basis).toBe("unreadable_dominant_surface");
    expect(d.inspectability_class).toBe("opaque");
    expect(d.visual_classifier_candidate_reason).toBe("unreadable_dominant_surface");
  });

  it("live B&BW shape — kind-driven (strict probe missed, no pre-set uninspectable) → visual_classifier_candidate / unreadable_dominant_surface", () => {
    // The exact live signal set: screen scan saw scrim + centered, the dominant
    // surface kind is scrim_center_modal, but its own text was NOT extractable, and
    // the source-of-truth uninspectable boolean was NOT pre-derived. NO cross-origin
    // iframe signal — opacity is semantic, not iframe.
    const d = classifySurfaceBoundary({
      screen_viewport_scrim_seen: true,
      screen_centered_modal_seen: true,
      surface_dominant_visible_surface_seen: true,
      surface_dominant_visible_surface_kind: "scrim_center_modal",
      surface_dominant_text_extractable: false,
      opaque_iframe_seen: false,
      visible_inaccessible_iframe_seen: false,
    });
    expect(d.route_decided).toBe("visual_classifier_candidate");
    expect(d.trigger_basis).toBe("unreadable_dominant_surface");
    expect(d.inspectability_class).toBe("opaque");
    expect(d.visual_classifier_candidate_reason).toBe("unreadable_dominant_surface");
  });

  it("readable modal WITH scrim (kind set, text extractable) → dom_semantic_candidate", () => {
    const d = classifySurfaceBoundary({
      screen_viewport_scrim_seen: true,
      screen_centered_modal_seen: true,
      surface_dominant_visible_surface_seen: true,
      surface_dominant_visible_surface_kind: "scrim_center_modal",
      surface_dominant_text_extraction_attempted: true,
      surface_dominant_text_extractable: true,
    });
    expect(d.route_decided).toBe("dom_semantic_candidate");
    expect(d.trigger_basis).toBe("inspectable_dominant_surface");
    expect(d.inspectability_class).toBe("inspectable");
  });

  it("bare hero/carousel (no scrim, kind unknown) does not become unreadable_dominant", () => {
    const d = classifySurfaceBoundary({
      surface_dominant_visible_surface_seen: true,
      surface_dominant_visible_surface_kind: "unknown",
      surface_dominant_text_extractable: false,
    });
    expect(d.route_decided).toBe("none");
    expect(d.trigger_basis).toBe("none");
  });

  it("fixed_overlay kind WITHOUT a scrim (centered only) stays none — the scrim gate holds", () => {
    const d = classifySurfaceBoundary({
      screen_centered_modal_seen: true,
      surface_dominant_visible_surface_seen: true,
      surface_dominant_visible_surface_kind: "fixed_overlay",
      surface_dominant_text_extractable: false,
    });
    // No scrim ⇒ not a blocking wall in shadow mode, even with an eligible kind.
    expect(d.route_decided).toBe("none");
  });

  it("protected DOMINANT iframe still routes opaque_dominant_surface (not unreadable_dominant_surface)", () => {
    const d = classifySurfaceBoundary({
      opaque_iframe_seen: true,
      surface_over_main_content: true,
      surface_blocks_viewport_center: true,
      // even if a scrim + uninspectable text co-occur, the cross-origin iframe wins
      screen_viewport_scrim_seen: true,
      screen_centered_modal_seen: true,
      surface_dominant_text_extraction_attempted: true,
      surface_dominant_text_extractable: false,
      surface_dominant_text_uninspectable: true,
    });
    expect(d.route_decided).toBe("visual_classifier_candidate");
    expect(d.trigger_basis).toBe("opaque_dominant_surface");
    expect(d.visual_classifier_candidate_reason).toBe("opaque_iframe");
  });

  it("a dominant surface with NO scrim (lone centered modal) does not become unreadable_dominant", () => {
    const d = classifySurfaceBoundary({
      screen_centered_modal_seen: true,
      surface_dominant_visible_surface_seen: true,
      surface_dominant_text_extraction_attempted: true,
      surface_dominant_text_extractable: false,
      surface_dominant_text_uninspectable: true,
    });
    // No scrim ⇒ not enough to call it a blocking wall in shadow mode.
    expect(d.route_decided).toBe("none");
  });

  it("inspectable modal WITH a scrim/backdrop → dom_semantic_candidate (inspectable)", () => {
    const d = classifySurfaceBoundary({
      viewport_scrim_seen: true,
      surface_text_inspectable: true,
      surface_over_main_content: true,
      normal_page_dom_present_behind_surface: true,
    });
    expect(d.route_decided).toBe("dom_semantic_candidate");
    expect(d.trigger_basis).toBe("inspectable_dominant_surface");
    expect(d.inspectability_class).toBe("inspectable");
  });

  it("readable login wall / payment confirmation (top-layer modal) is still a boundary → dom_semantic_candidate", () => {
    const d = classifySurfaceBoundary({
      top_layer_dialog_seen: true,
      surface_text_inspectable: true,
      surface_over_main_content: true,
    });
    expect(d.route_decided).toBe("dom_semantic_candidate");
    expect(d.trigger_basis).toBe("inspectable_dominant_surface");
  });

  it("benign hero/carousel (large+centered, NO scrim/modal, NO opaque iframe) → none", () => {
    const d = classifySurfaceBoundary({
      large_centered_overlay_seen: true,
      surface_over_main_content: true,
      surface_text_inspectable: true, // readable, but NOT a backdrop'd modal
      normal_page_dom_present_behind_surface: true,
    });
    expect(d.route_decided).toBe("none");
    expect(d.trigger_basis).toBe("none");
  });

  it("ordinary cross-origin ad iframe (non-dominant, off-path) → ignore_off_path", () => {
    const d = classifySurfaceBoundary({
      visible_cross_origin_iframe_seen: true,
      off_path_iframe_seen: true,
      opaque_iframe_seen: false,
      normal_page_dom_present_behind_surface: true,
    });
    expect(d.route_decided).toBe("ignore_off_path");
    expect(d.trigger_basis).toBe("off_path_iframe");
    expect(d.inspectability_class).toBe("none");
  });

  it("cross-origin presence ALONE (not dominant, not off-path-flagged) is not a candidate", () => {
    const d = classifySurfaceBoundary({ visible_cross_origin_iframe_seen: true });
    expect(d.route_decided).toBe("none");
  });

  it("repeated-stale / no-progress backstop marks legacy_no_progress_fallback basis when a route fires", () => {
    const d = classifySurfaceBoundary(
      {
        opaque_iframe_seen: true,
        surface_over_main_content: true,
        surface_blocks_viewport_center: true,
      },
      { fromNoProgressFallback: true },
    );
    expect(d.route_decided).toBe("visual_classifier_candidate");
    expect(d.trigger_basis).toBe("legacy_no_progress_fallback");
  });

  it("fromNoProgressFallback does NOT invent a route when there is no surface", () => {
    const d = classifySurfaceBoundary({}, { fromNoProgressFallback: true });
    expect(d.route_decided).toBe("none");
    expect(d.trigger_basis).toBe("none");
  });

  // ── Browser-check interstitial route (passive Cloudflare-style) ──
  it("browser-check phrase + stuck (no HV) → visual_classifier_candidate / browser_check_interstitial", () => {
    const d = classifySurfaceBoundary({
      browser_check_phrase_seen: true,
      browser_check_stuck: true,
      page_appears_unusable: true,
    });
    expect(d.route_decided).toBe("visual_classifier_candidate");
    expect(d.trigger_basis).toBe("browser_check_interstitial");
    expect(d.visual_classifier_candidate_reason).toBe("browser_check_interstitial");
    expect(d.inspectability_class).toBe("opaque");
  });

  it("browser-check phrase SEEN but NOT stuck (transient) → none (never captured)", () => {
    const d = classifySurfaceBoundary({
      browser_check_phrase_seen: true,
      browser_check_stuck: false,
      page_appears_unusable: true,
    });
    expect(d.route_decided).toBe("none");
    expect(d.trigger_basis).toBe("none");
  });

  it("HV precedence: browser-check phrase + page-level HV text on an unusable page → page_level_hv_wall (NOT browser-check)", () => {
    const d = classifySurfaceBoundary({
      browser_check_phrase_seen: true,
      browser_check_stuck: true,
      screen_hv_phrase_seen: true,
      page_appears_unusable: true,
    });
    expect(d.route_decided).toBe("visual_classifier_candidate");
    expect(d.trigger_basis).toBe("page_level_hv_wall");
    expect(d.visual_classifier_candidate_reason).toBe("page_level_hv_wall");
  });

  it("browser-check signals absent ⇒ classifier byte-identical (no spurious route)", () => {
    // A normal product grid with rich content: no browser-check signals fed.
    const d = classifySurfaceBoundary({ page_has_rich_interactive_content: true });
    expect(d.route_decided).toBe("none");
    expect(d.trigger_basis).toBe("none");
  });

  it("surface_overlaps_agent_target reflects the provided value when known", () => {
    const provided = classifySurfaceBoundary(
      { opaque_iframe_seen: true },
      { overlapsAgentTarget: true },
    );
    expect(provided.route_decided).toBe("visual_classifier_candidate");
    expect(provided.surface_overlaps_agent_target).toBe(true);

    const unknown = classifySurfaceBoundary({ opaque_iframe_seen: true });
    expect(unknown.surface_overlaps_agent_target).toBe("unknown");
  });
});
