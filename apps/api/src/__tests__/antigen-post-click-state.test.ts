/**
 * buildPostClickState — pure mapper from a click verification's INTERNAL
 * before/after display state to the sanitized agent-facing post_click_state.
 *
 * No browser / no CDP / no env reads. Covers every `change` value, URL
 * sanitization (query strings and fragments NEVER survive — they can carry
 * tokens/PII), names-only surface-action classification (mirrors
 * buildActiveSurfaces: unique CTA → primary, dismiss flag honored,
 * requires_handoff listed-but-flagged), and a recursive leak scan asserting no
 * refs/boxes/coordinates/hrefs/query content in the output.
 */

import { describe, it, expect } from "vitest";
import { buildPostClickState } from "../runtime/antigenSnapshotPageMap.js";
import type {
  ClickVerification,
  PostClickInternal,
  OverlayProbeSummary,
} from "../runtime/antigenClickVerification.js";

function verification(overrides: Partial<ClickVerification> = {}): ClickVerification {
  return {
    click_dispatched: true,
    intent_verified: true,
    verification_signal: "url_changed",
    outcome: "CLICK_VERIFIED",
    recommended_next_step: "none",
    overlay_before_present: false,
    overlay_before_blocking: false,
    overlay_after_present: false,
    overlay_after_blocking: false,
    overlay_before_type: null,
    overlay_after_type: null,
    url_changed: true,
    verify_ms: 12,
    settle_polls: 1,
    ...overrides,
  };
}

function internal(overrides: Partial<PostClickInternal> = {}): PostClickInternal {
  return {
    before_url: "https://www.ikea.com/us/en/cart/",
    after_url: "https://www.ikea.com/us/en/checkout/",
    before_title: "Shopping bag",
    after_title: "Checkout",
    ready_state: "complete",
    main_content_changed: true,
    ...overrides,
  };
}

function overlay(overrides: Partial<OverlayProbeSummary> = {}): OverlayProbeSummary {
  return {
    present: true,
    blocking: true,
    overlay_type: "dialog",
    title_hash: "m1",
    title: "Choose how to check out",
    ...overrides,
  };
}

/** Recursive scan: no internal/geometry/href/query material in the output. */
function assertLeakFree(value: unknown): void {
  const FORBIDDEN_KEYS = new Set(["ref", "box", "x", "y", "width", "height", "href", "href_path", "url", "before_url", "after_url", "title_hash", "post_click_internal", "actions"]);
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { for (const item of v) visit(item); return; }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        expect(FORBIDDEN_KEYS.has(k), `forbidden key "${k}" leaked into post_click_state`).toBe(false);
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

describe("buildPostClickState — change mapping", () => {
  it("returns undefined when verification is absent (flag off)", () => {
    expect(buildPostClickState(undefined, { includeActions: true })).toBeUndefined();
  });

  it("unreadable after-probe (no internal carrier) → unknown + refresh_snapshot", () => {
    const s = buildPostClickState(verification({ url_changed: false }), { includeActions: true });
    expect(s).toBeDefined();
    expect(s!.change).toBe("unknown");
    expect(s!.recommended_next_step).toBe("refresh_snapshot");
    expect(s!.next).toBe("refs_require_fresh_snapshot");
  });

  it("URL changed + document complete → navigation with sanitized paths", () => {
    const s = buildPostClickState(
      verification({ post_click_internal: internal() }),
      { includeActions: true },
    )!;
    expect(s.change).toBe("navigation");
    expect(s.navigation_or_route_detected).toBe(true);
    expect(s.url_changed).toBe(true);
    expect(s.old_url_path).toBe("/us/en/cart/");
    expect(s.new_url_path).toBe("/us/en/checkout/");
    expect(s.new_url_host).toBeUndefined(); // same host — never repeated
    expect(s.title_changed).toBe(true);
    expect(s.old_title).toBe("Shopping bag");
    expect(s.new_title).toBe("Checkout");
    expect(s.document_ready_state).toBe("complete");
    expect(s.recommended_next_step).toBe("refresh_snapshot");
  });

  it("URL changed but document still loading → still_loading + wait_for_load_then_snapshot", () => {
    const s = buildPostClickState(
      verification({ post_click_internal: internal({ ready_state: "interactive" }) }),
      { includeActions: true },
    )!;
    expect(s.change).toBe("still_loading");
    expect(s.recommended_next_step).toBe("wait_for_load_then_snapshot");
  });

  it("blocking modal appeared → modal_opened with surface", () => {
    const s = buildPostClickState(
      verification({
        verification_signal: "modal_opened",
        url_changed: false,
        overlay_after_present: true,
        overlay_after_blocking: true,
        overlay_after_type: "dialog",
        post_click_internal: internal({
          after_url: "https://www.ikea.com/us/en/cart/",
          after_title: "Shopping bag",
          main_content_changed: true,
          after_overlay: overlay(),
        }),
      }),
      { includeActions: false },
    )!;
    expect(s.change).toBe("modal_opened");
    expect(s.url_changed).toBe(false);
    expect(s.surface).toBeDefined();
    expect(s.surface!.overlay_blocking).toBe(true);
    expect(s.surface!.overlay_type).toBe("dialog");
    expect(s.surface!.title).toBe("Choose how to check out");
    expect(s.surface!.surface_actions).toBeUndefined(); // includeActions=false
    expect(s.recommended_next_step).toBe("refresh_snapshot");
  });

  it("overlay disappeared → modal_closed", () => {
    const s = buildPostClickState(
      verification({
        verification_signal: "modal_closed",
        url_changed: false,
        overlay_before_present: true,
        overlay_before_blocking: true,
        overlay_before_type: "dialog",
        post_click_internal: internal({
          after_url: "https://www.ikea.com/us/en/cart/",
          after_title: "Shopping bag",
          main_content_changed: true,
        }),
      }),
      { includeActions: true },
    )!;
    expect(s.change).toBe("modal_closed");
    expect(s.surface).toBeUndefined();
  });

  it("fresh nonblocking overlay (add-to-bag flyout) → surface_changed with surface", () => {
    const s = buildPostClickState(
      verification({
        verification_signal: "overlay_changed",
        url_changed: false,
        overlay_after_present: true,
        overlay_after_blocking: false,
        overlay_after_type: "toast",
        post_click_internal: internal({
          after_url: "https://www.ikea.com/us/en/p/glimma/",
          after_title: "GLIMMA",
          before_title: "GLIMMA",
          main_content_changed: true,
          after_overlay: overlay({ blocking: false, overlay_type: "toast", title: "Added to bag" }),
        }),
      }),
      { includeActions: false },
    )!;
    expect(s.change).toBe("surface_changed");
    expect(s.surface!.overlay_type).toBe("toast");
    expect(s.surface!.overlay_blocking).toBe(false);
  });

  it("same URL, title/content changed (SPA in-place update) → content_updated", () => {
    const s = buildPostClickState(
      verification({
        url_changed: false,
        verification_signal: "title_changed",
        post_click_internal: internal({
          after_url: "https://www.ikea.com/us/en/cart/",
          before_url: "https://www.ikea.com/us/en/cart/",
          main_content_changed: true,
        }),
      }),
      { includeActions: true },
    )!;
    expect(s.change).toBe("content_updated");
    expect(s.navigation_or_route_detected).toBe(true); // title + content both moved
  });

  it("nothing changed → none, mirrors the verification's try_alternate_ref hint", () => {
    const s = buildPostClickState(
      verification({
        intent_verified: false,
        verification_signal: "no_effect",
        outcome: "CLICK_DISPATCHED_NO_EFFECT",
        recommended_next_step: "try_alternate_ref",
        url_changed: false,
        post_click_internal: internal({
          after_url: "https://www.ikea.com/us/en/cart/",
          before_url: "https://www.ikea.com/us/en/cart/",
          before_title: "Shopping bag",
          after_title: "Shopping bag",
          main_content_changed: false,
        }),
      }),
      { includeActions: true },
    )!;
    expect(s.change).toBe("none");
    expect(s.recommended_next_step).toBe("try_alternate_ref");
    expect(s.navigation_or_route_detected).toBe(false);
  });
});

describe("buildPostClickState — URL sanitization", () => {
  it("query strings and fragments NEVER survive (token-bearing checkout URL)", () => {
    const s = buildPostClickState(
      verification({
        post_click_internal: internal({
          after_url: "https://www.ikea.com/checkout?session=tok_secret&user=a@b.com#step2",
        }),
      }),
      { includeActions: true },
    )!;
    expect(s.new_url_path).toBe("/checkout");
    assertLeakFree(s);
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain("tok_secret");
    expect(serialized).not.toContain("a@b.com");
    expect(serialized).not.toContain("session=");
  });

  it("cross-host navigation exposes the new host only when it changed", () => {
    const s = buildPostClickState(
      verification({
        post_click_internal: internal({
          before_url: "https://www.ikea.com/us/en/cart/",
          after_url: "https://pay.example.com/start?sid=tok_secret",
        }),
      }),
      { includeActions: true },
    )!;
    expect(s.new_url_host).toBe("pay.example.com");
    expect(s.new_url_path).toBe("/start");
    expect(JSON.stringify(s)).not.toContain("tok_secret");
  });

  it("unparseable URLs degrade to no path fields, never a throw", () => {
    const s = buildPostClickState(
      verification({
        post_click_internal: internal({ before_url: "not a url", after_url: "%% not a url either" }),
      }),
      { includeActions: true },
    )!;
    expect(s.old_url_path).toBeUndefined();
    expect(s.new_url_path).toBeUndefined();
  });
});

describe("buildPostClickState — names-only surface actions", () => {
  const checkoutModal = (actions: OverlayProbeSummary["actions"]) =>
    verification({
      verification_signal: "modal_opened",
      url_changed: false,
      overlay_after_present: true,
      overlay_after_blocking: true,
      overlay_after_type: "dialog",
      post_click_internal: internal({
        after_url: "https://www.ikea.com/us/en/cart/",
        after_title: "Shopping bag",
        main_content_changed: true,
        after_overlay: overlay({ actions }),
      }),
    });

  it("IKEA guest-checkout modal: all action names surface; competing CTAs stay secondary; dismiss honored", () => {
    const s = buildPostClickState(
      checkoutModal([
        { name: "Continue as guest", kind: "button", dismiss: false },
        { name: "Log in", kind: "button", dismiss: false },
        { name: "Close", kind: "button", dismiss: true },
      ]),
      { includeActions: true },
    )!;
    const actions = s.surface!.surface_actions!;
    expect(actions.map((a) => a.name)).toEqual(["Continue as guest", "Log in", "Close"]);
    const guest = actions.find((a) => a.name === "Continue as guest")!;
    const login = actions.find((a) => a.name === "Log in")!;
    const close = actions.find((a) => a.name === "Close")!;
    expect(close.classification).toBe("dismiss");
    // Both "Continue as guest" and "Log in" are CTA names — two peers means no
    // primary is crowned (never guess between peers), matching buildActiveSurfaces.
    expect(guest.classification).toBe("secondary");
    expect(login.classification).toBe("secondary");
    // A login CLICK is reversible navigation (the credential fill is gated
    // separately) — no handoff flag on either.
    expect(guest.requires_handoff).toBeUndefined();
    expect(login.requires_handoff).toBeUndefined();
    assertLeakFree(s);
  });

  it("a unique low-risk CTA becomes primary", () => {
    const s = buildPostClickState(
      checkoutModal([
        { name: "Continue as guest", kind: "button", dismiss: false },
        { name: "Close", kind: "button", dismiss: true },
      ]),
      { includeActions: true },
    )!;
    const guest = s.surface!.surface_actions!.find((a) => a.name === "Continue as guest")!;
    expect(guest.classification).toBe("primary");
    expect(guest.requires_handoff).toBeUndefined();
  });

  it("two competing CTAs → both secondary (never guess between peers)", () => {
    const s = buildPostClickState(
      checkoutModal([
        { name: "Continue as guest", kind: "button", dismiss: false },
        { name: "Continue with club card", kind: "button", dismiss: false },
      ]),
      { includeActions: true },
    )!;
    for (const a of s.surface!.surface_actions!) expect(a.classification).toBe("secondary");
  });

  it("a final-commit action is listed with requires_handoff, never as primary", () => {
    const s = buildPostClickState(
      checkoutModal([
        { name: "Place order", kind: "button", dismiss: false },
        { name: "Keep shopping", kind: "button", dismiss: false },
      ]),
      { includeActions: true },
    )!;
    const place = s.surface!.surface_actions!.find((a) => a.name === "Place order")!;
    expect(place.requires_handoff).toBe(true);
    expect(place.classification).not.toBe("primary");
  });

  it("dedupes by normalized name, drops empty names, caps at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `Option ${i + 1}`,
      kind: "button" as const,
      dismiss: false,
    }));
    const s = buildPostClickState(
      checkoutModal([
        { name: "", kind: "button", dismiss: false },
        { name: "Continue as guest", kind: "button", dismiss: false },
        { name: "continue as GUEST", kind: "button", dismiss: false }, // dup after normalization
        ...many,
      ]),
      { includeActions: true },
    )!;
    const names = s.surface!.surface_actions!.map((a) => a.name);
    expect(names.filter((n) => n.toLowerCase() === "continue as guest")).toHaveLength(1);
    expect(names.length).toBeLessThanOrEqual(8);
    expect(names).not.toContain("");
  });

  it("includeActions=false omits surface_actions even when the probe collected them", () => {
    const s = buildPostClickState(
      checkoutModal([{ name: "Continue as guest", kind: "button", dismiss: false }]),
      { includeActions: false },
    )!;
    expect(s.surface).toBeDefined();
    expect(s.surface!.surface_actions).toBeUndefined();
  });

  it("clips long action names to 80 chars", () => {
    const long = "Continue as guest " + "x".repeat(200);
    const s = buildPostClickState(
      checkoutModal([{ name: long, kind: "button", dismiss: false }]),
      { includeActions: true },
    )!;
    expect(s.surface!.surface_actions![0].name.length).toBeLessThanOrEqual(80);
  });
});
