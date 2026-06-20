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
