/**
 * buildPostFillState — pure mapper from the after-fill probe + server-side fill
 * truth to the sanitized agent-facing post_fill_state (the protected-fill
 * analogue of post_click_state).
 *
 * No browser / no CDP / no env reads. Covers every `outcome` value, the
 * probe-absent degradation (outcome "unknown", fill truth intact), names-only
 * next-action classification (disabled never primary, handoff never primary,
 * dedupe + ≤8 cap), masking/redaction summary incl. the fail-closed iframe
 * mismatch flag, and a recursive leak scan asserting no refs / boxes /
 * coordinates / selectors / urls / values in the output.
 */

import { describe, it, expect } from "vitest";
import {
  buildPostFillState,
  type BuildPostFillStateInput,
} from "../runtime/antigenSnapshotPageMap.js";
import type {
  PageStateProbe,
  FillStateProbe,
  FillProbeAction,
} from "../runtime/antigenClickVerification.js";

function fillProbe(overrides: Partial<FillStateProbe> = {}): FillStateProbe {
  return {
    invalid_count: 0,
    alert_count: 0,
    filled_marker_count: 4,
    masked_marker_count: 4,
    form_actions: [],
    ...overrides,
  };
}

function probe(
  fill: Partial<FillStateProbe> = {},
  overrides: Partial<PageStateProbe> = {},
): PageStateProbe {
  return {
    // Deliberately token-bearing: the builder consumes this internally (intent
    // classification only) and must never emit any part of it.
    url: "https://www.ikea.com/us/en/checkout/?session=tok_secret#payment",
    title_hash: "t1",
    title: "Checkout",
    ready_state: "complete",
    overlay: { present: false, blocking: false, overlay_type: null, title_hash: null },
    cart_count: null,
    visible_text_hash: "v1",
    focused_editable_at_target: false,
    status: "ok",
    fill_state: fillProbe(fill),
    ...overrides,
  };
}

function build(
  input: Partial<BuildPostFillStateInput> = {},
  opts: { includeActions: boolean } = { includeActions: true },
) {
  return buildPostFillState(
    {
      filled_count: 4,
      failed_count: 0,
      pageUrl: "https://www.ikea.com/us/en/checkout/?session=tok_secret#payment",
      ...input,
    },
    opts,
  );
}

const action = (name: string, over: Partial<FillProbeAction> = {}): FillProbeAction => ({
  name,
  kind: "button",
  disabled: false,
  dismiss: false,
  ...over,
});

/** Recursive scan: no internal/geometry/selector/url/value material in the output. */
function assertLeakFree(value: unknown): void {
  const FORBIDDEN_KEYS = new Set([
    "ref", "box", "x", "y", "width", "height", "href", "href_path",
    "url", "page_url", "pageUrl", "before_url", "after_url", "title_hash",
    "value", "selector", "fill_id", "form_actions", "probe",
    "post_click_internal", "actions", "cdp_url",
  ]);
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { for (const item of v) visit(item); return; }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        expect(FORBIDDEN_KEYS.has(k), `forbidden key "${k}" leaked into post_fill_state`).toBe(false);
        visit(val);
      }
      return;
    }
    if (typeof v === "string") {
      expect(v).not.toContain("?");
      expect(v).not.toContain("#");
      expect(v).not.toContain("tok_secret");
    }
  };
  visit(value);
}

describe("buildPostFillState — outcome mapping", () => {
  it("probe absent → unknown; fill truth + literal-false + next constant intact", () => {
    const s = build({ probe: undefined, filled_count: 3, failed_count: 1 });
    expect(s.outcome).toBe("unknown");
    expect(s.filled_count).toBe(3);
    expect(s.failed_count).toBe(1);
    expect(s.validation_error_count).toBeUndefined();
    expect(s.next_action_names).toBeUndefined();
    expect(s.raw_values_revealed_to_agent).toBe(false);
    expect(s.recommended_next_step).toBe("refresh_snapshot");
    expect(s.next).toBe("refs_require_fresh_snapshot");
    assertLeakFree(s);
  });

  it("probe status error → unknown (an unreadable probe never falsifies state)", () => {
    const s = build({ probe: probe({}, { status: "error" }) });
    expect(s.outcome).toBe("unknown");
  });

  it("probe ok but without fill_state (non-fill probe shape) → unknown", () => {
    const p = probe();
    delete (p as Record<string, unknown>).fill_state;
    expect(build({ probe: p }).outcome).toBe("unknown");
  });

  it("failed_count > 0 → fill_incomplete (server-side truth wins over a clean page)", () => {
    const s = build({
      probe: probe({ form_actions: [action("Continue to payment")] }),
      filled_count: 2,
      failed_count: 2,
    });
    expect(s.outcome).toBe("fill_incomplete");
    expect(s.recommended_next_step).toBe("refresh_snapshot");
  });

  it("visible validation errors → validation_errors_present + review_validation_errors", () => {
    const s = build({
      probe: probe({ invalid_count: 2, alert_count: 1, form_actions: [action("Continue to payment")] }),
    });
    expect(s.outcome).toBe("validation_errors_present");
    expect(s.validation_error_count).toBe(3);
    expect(s.recommended_next_step).toBe("review_validation_errors");
  });

  it("enabled low-risk next action → ready_for_next_action with a named primary", () => {
    const s = build({
      probe: probe({
        form_actions: [
          action("Continue to payment"),
          action("Close", { dismiss: true }),
        ],
      }),
    });
    expect(s.outcome).toBe("ready_for_next_action");
    expect(s.recommended_next_step).toBe("snapshot_then_click_named_action");
    const cont = s.next_action_names!.find((a) => a.name === "Continue to payment")!;
    expect(cont.classification).toBe("primary");
    expect(cont.disabled).toBeUndefined();
    expect(cont.requires_handoff).toBeUndefined();
    assertLeakFree(s);
  });

  it("only enabled action is a final commit → handoff_required_next, never primary", () => {
    const s = build({
      probe: probe({
        form_actions: [
          action("Place order"),
          action("Continue to payment", { disabled: true }),
        ],
      }),
    });
    expect(s.outcome).toBe("handoff_required_next");
    expect(s.recommended_next_step).toBe("handoff_required");
    const place = s.next_action_names!.find((a) => a.name === "Place order")!;
    expect(place.requires_handoff).toBe(true);
    expect(place.classification).not.toBe("primary");
  });

  it("all candidates disabled → no_next_action_visible; disabled flag surfaces", () => {
    const s = build({
      probe: probe({ form_actions: [action("Continue to payment", { disabled: true })] }),
    });
    expect(s.outcome).toBe("no_next_action_visible");
    expect(s.recommended_next_step).toBe("refresh_snapshot");
    const cont = s.next_action_names![0];
    expect(cont.disabled).toBe(true);
    expect(cont.classification).not.toBe("primary");
  });

  it("no candidates at all → no_next_action_visible without next_action_names", () => {
    const s = build({ probe: probe({ form_actions: [] }) });
    expect(s.outcome).toBe("no_next_action_visible");
    expect(s.next_action_names).toBeUndefined();
  });

  it("only a dismiss action → no_next_action_visible (dismiss is not a next step)", () => {
    const s = build({ probe: probe({ form_actions: [action("Close", { dismiss: true })] }) });
    expect(s.outcome).toBe("no_next_action_visible");
  });
});

describe("buildPostFillState — next-action classification", () => {
  it("two competing enabled CTAs → both secondary (never guess between peers)", () => {
    const s = build({
      probe: probe({
        form_actions: [action("Continue to payment"), action("Continue to delivery")],
      }),
    });
    expect(s.outcome).toBe("ready_for_next_action");
    for (const a of s.next_action_names!) expect(a.classification).toBe("secondary");
  });

  it("a disabled CTA never becomes primary even when it is the unique CTA", () => {
    const s = build({
      probe: probe({
        form_actions: [
          action("Continue to payment", { disabled: true }),
          action("Gift options"),
        ],
      }),
    });
    const cont = s.next_action_names!.find((a) => a.name === "Continue to payment")!;
    expect(cont.classification).not.toBe("primary");
  });

  it("dedupes by normalized name, drops empty names, caps at 8, clips at 80", () => {
    const many = Array.from({ length: 12 }, (_, i) => action(`Option ${i + 1}`));
    const s = build({
      probe: probe({
        form_actions: [
          action(""),
          action("Continue to payment"),
          action("continue to PAYMENT"), // dup after normalization
          action("Continue to payment " + "x".repeat(200)),
          ...many,
        ],
      }),
    });
    const names = s.next_action_names!.map((a) => a.name);
    expect(names.filter((n) => n.toLowerCase() === "continue to payment")).toHaveLength(1);
    expect(names.length).toBeLessThanOrEqual(8);
    expect(names).not.toContain("");
    for (const n of names) expect(n.length).toBeLessThanOrEqual(80);
  });

  it("validation_error_count caps at 99", () => {
    const s = build({ probe: probe({ invalid_count: 500, alert_count: 500 }) });
    expect(s.validation_error_count).toBe(99);
  });
});

describe("buildPostFillState — masking / redaction summary", () => {
  it("marker counts surface when the probe was readable", () => {
    const s = build({ probe: probe({ filled_marker_count: 5, masked_marker_count: 3 }) });
    expect(s.masking.dom_filled_marker_count).toBe(5);
    expect(s.masking.visual_mask_marker_count).toBe(3);
  });

  it("marker counts absent when the probe was unreadable (never fabricated zeros)", () => {
    const s = build({ probe: undefined });
    expect(s.masking.dom_filled_marker_count).toBeUndefined();
    expect(s.masking.visual_mask_marker_count).toBeUndefined();
  });

  it("registry-derived iframe fields are reported; matching expectation sets no mismatch", () => {
    const s = build({
      probe: probe(),
      iframe_redaction_fields: ["card_number", "cvv"],
      expected_iframe_field: "cvv",
    });
    expect(s.masking.iframe_redaction_fields).toEqual(["card_number", "cvv"]);
    expect(s.masking.iframe_redaction_mismatch).toBeUndefined();
  });

  it("expected iframe field missing from the registry → mismatch flag (fail-closed report, never silent)", () => {
    const s = build({
      probe: probe(),
      iframe_redaction_fields: ["card_number"],
      expected_iframe_field: "cvv",
    });
    expect(s.masking.iframe_redaction_mismatch).toBe(true);
  });

  it("expected iframe field with an EMPTY registry → mismatch flag", () => {
    const s = build({ probe: probe(), expected_iframe_field: "card_number" });
    expect(s.masking.iframe_redaction_mismatch).toBe(true);
  });
});

describe("buildPostFillState — surface + leak boundary", () => {
  it("active overlay after the fill surfaces as PostClickSurface; actions gated on includeActions", () => {
    const overlayProbe = probe(
      { form_actions: [action("Continue to payment")] },
      {
        overlay: {
          present: true,
          blocking: true,
          overlay_type: "dialog",
          title_hash: "m1",
          title: "Verify your address",
          actions: [{ name: "Use suggested address", kind: "button", dismiss: false }],
        },
      },
    );
    const withActions = build({ probe: overlayProbe }, { includeActions: true });
    expect(withActions.surface).toBeDefined();
    expect(withActions.surface!.overlay_blocking).toBe(true);
    expect(withActions.surface!.title).toBe("Verify your address");
    expect(withActions.surface!.surface_actions!.map((a) => a.name)).toEqual(["Use suggested address"]);

    const withoutActions = build({ probe: overlayProbe }, { includeActions: false });
    expect(withoutActions.surface).toBeDefined();
    expect(withoutActions.surface!.surface_actions).toBeUndefined();
    // next_action_names is the point of the feature — NOT gated on includeActions.
    expect(withoutActions.next_action_names).toBeDefined();
  });

  it("probe_ms is bounded and negative values are dropped", () => {
    expect(build({ probe: probe(), probe_ms: 1e9 }).probe_ms).toBe(600_000);
    expect(build({ probe: probe(), probe_ms: -5 }).probe_ms).toBeUndefined();
    expect(build({ probe: probe(), probe_ms: 142 }).probe_ms).toBe(142);
  });

  it("full leak scan across a rich state (token URL, overlay, handoff, iframe fields)", () => {
    const s = build({
      probe: probe(
        {
          invalid_count: 0,
          alert_count: 0,
          form_actions: [
            action("Continue to payment"),
            action("Place order"),
            action("Close", { dismiss: true }),
          ],
        },
        {
          overlay: {
            present: true,
            blocking: false,
            overlay_type: "toast",
            title_hash: "h",
            title: "Card details saved",
            actions: [{ name: "Undo", kind: "button", dismiss: false }],
          },
        },
      ),
      probe_ms: 180,
      iframe_redaction_fields: ["card_number", "cvv", "expiry"],
      expected_iframe_field: "expiry",
    });
    assertLeakFree(s);
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain("tok_secret");
    expect(serialized).not.toContain("ikea.com");
    expect(serialized).not.toContain("ag_");
  });

  it("raw_values_revealed_to_agent is the literal false on every outcome", () => {
    const variants = [
      build({ probe: undefined }),
      build({ probe: probe({}, { status: "error" }) }),
      build({ probe: probe(), failed_count: 1 }),
      build({ probe: probe({ invalid_count: 1 }) }),
      build({ probe: probe({ form_actions: [action("Continue to payment")] }) }),
      build({ probe: probe({ form_actions: [action("Place order")] }) }),
      build({ probe: probe() }),
    ];
    for (const s of variants) {
      expect(s.raw_values_revealed_to_agent).toBe(false);
      expect(s.next).toBe("refs_require_fresh_snapshot");
    }
  });
});
