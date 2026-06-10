/**
 * Antigen post-click intent verification — pure classifier + probe builder.
 *
 * No browser / no CDP. classifyClickVerification is a pure before/after → signal
 * decision; buildPageStateProbeExpr is a raw-JS string we assert shares the
 * overlay snippet with the snapshot extraction (anti-drift). Mirrors the style
 * of antigen-logical-ref-recovery.test.ts (pure logic + string assertions).
 */

import { describe, it, expect } from "vitest";
import {
  classifyClickVerification,
  buildPageStateProbeExpr,
  type PageStateProbe,
  type ClickVerificationContext,
} from "../runtime/antigenClickVerification.js";
import { buildOverlaySnippetJs } from "../runtime/antigenSnapshotRuntime.js";
import { isAntigenPageChanged } from "../runtime/antigenSnapshotStore.js";

function probe(overrides: Partial<PageStateProbe> = {}): PageStateProbe {
  return {
    url: "https://shop.example.com/a",
    title_hash: "aaaa1111",
    overlay: { present: false, blocking: false, overlay_type: null, title_hash: null },
    cart_count: null,
    visible_text_hash: "bbbb2222",
    focused_editable_at_target: false,
    status: "ok",
    ...overrides,
  };
}

function ctx(overrides: Partial<ClickVerificationContext> = {}): ClickVerificationContext {
  return {
    editableTarget: false,
    targetWasBehindBlockingModal: false,
    pageChangedCompare: isAntigenPageChanged,
    ...overrides,
  };
}

describe("classifyClickVerification — verified signals", () => {
  it("url change → url_changed, verified, CLICK_VERIFIED", () => {
    const r = classifyClickVerification(
      probe({ url: "https://shop.example.com/a" }),
      probe({ url: "https://shop.example.com/b" }),
      ctx(),
    );
    expect(r.verification_signal).toBe("url_changed");
    expect(r.intent_verified).toBe(true);
    expect(r.outcome).toBe("CLICK_VERIFIED");
    expect(r.recommended_next_step).toBe("none");
    expect(r.url_changed).toBe(true);
  });

  it("hash-only URL difference does NOT verify (uses isAntigenPageChanged)", () => {
    const r = classifyClickVerification(
      probe({ url: "https://shop.example.com/a" }),
      probe({ url: "https://shop.example.com/a#section" }),
      ctx(),
    );
    expect(r.url_changed).toBe(false);
    expect(r.intent_verified).toBe(false);
    expect(r.verification_signal).toBe("no_effect");
    expect(r.outcome).toBe("CLICK_DISPATCHED_NO_EFFECT");
  });

  it("modal opened → modal_opened, verified", () => {
    const r = classifyClickVerification(
      probe({ overlay: { present: false, blocking: false, overlay_type: null, title_hash: null } }),
      probe({ overlay: { present: true, blocking: true, overlay_type: "dialog", title_hash: "m1" } }),
      ctx(),
    );
    expect(r.verification_signal).toBe("modal_opened");
    expect(r.intent_verified).toBe(true);
    expect(r.overlay_after_blocking).toBe(true);
  });

  it("modal closed → modal_closed, verified", () => {
    const r = classifyClickVerification(
      probe({ overlay: { present: true, blocking: true, overlay_type: "dialog", title_hash: "m1" } }),
      probe({ overlay: { present: false, blocking: false, overlay_type: null, title_hash: null } }),
      ctx(),
    );
    expect(r.verification_signal).toBe("modal_closed");
    expect(r.intent_verified).toBe(true);
  });

  it("overlay type/title change → overlay_changed, verified", () => {
    const r = classifyClickVerification(
      probe({ overlay: { present: true, blocking: false, overlay_type: "toast", title_hash: "t1" } }),
      probe({ overlay: { present: true, blocking: false, overlay_type: "toast", title_hash: "t2" } }),
      ctx(),
    );
    expect(r.verification_signal).toBe("overlay_changed");
    expect(r.intent_verified).toBe(true);
  });

  it("cart count change → cart_changed, verified", () => {
    const r = classifyClickVerification(
      probe({ cart_count: 1 }),
      probe({ cart_count: 2 }),
      ctx(),
    );
    expect(r.verification_signal).toBe("cart_changed");
    expect(r.intent_verified).toBe(true);
  });

  it("cart null→2 is null-safe and does NOT verify", () => {
    const r = classifyClickVerification(
      probe({ cart_count: null }),
      probe({ cart_count: 2 }),
      ctx(),
    );
    expect(r.verification_signal).toBe("no_effect");
    expect(r.intent_verified).toBe(false);
  });

  it("title change → title_changed, verified", () => {
    const r = classifyClickVerification(
      probe({ title_hash: "t1" }),
      probe({ title_hash: "t2" }),
      ctx(),
    );
    expect(r.verification_signal).toBe("title_changed");
    expect(r.intent_verified).toBe(true);
  });

  it("editable target focused → focus_changed, verified (no url/modal/cart needed)", () => {
    const r = classifyClickVerification(
      probe(),
      probe({ focused_editable_at_target: true }),
      ctx({ editableTarget: true }),
    );
    expect(r.verification_signal).toBe("focus_changed");
    expect(r.intent_verified).toBe(true);
  });

  it("non-editable target but focus moved into a field → focus_changed, verified", () => {
    const r = classifyClickVerification(
      probe(),
      probe({ focused_editable_at_target: true }),
      ctx({ editableTarget: false }),
    );
    expect(r.verification_signal).toBe("focus_changed");
    expect(r.intent_verified).toBe(true);
  });
});

describe("classifyClickVerification — non-verified outcomes", () => {
  it("editable target not focused → CLICK_DISPATCHED_NO_EFFECT, refresh_snapshot", () => {
    const r = classifyClickVerification(
      probe(),
      probe({ focused_editable_at_target: false }),
      ctx({ editableTarget: true }),
    );
    expect(r.intent_verified).toBe(false);
    expect(r.outcome).toBe("CLICK_DISPATCHED_NO_EFFECT");
    expect(r.recommended_next_step).toBe("refresh_snapshot");
  });

  it("no change at all → no_effect, CLICK_DISPATCHED_NO_EFFECT", () => {
    const r = classifyClickVerification(probe(), probe(), ctx());
    expect(r.verification_signal).toBe("no_effect");
    expect(r.outcome).toBe("CLICK_DISPATCHED_NO_EFFECT");
    expect(r.recommended_next_step).toBe("try_alternate_ref");
  });

  it("unreadable after-probe → CLICK_INTENT_UNVERIFIED, refresh_snapshot", () => {
    const r = classifyClickVerification(
      probe(),
      probe({ status: "error" }),
      ctx(),
    );
    expect(r.intent_verified).toBe(false);
    expect(r.outcome).toBe("CLICK_INTENT_UNVERIFIED");
    expect(r.recommended_next_step).toBe("refresh_snapshot");
  });

  it("text-hash change alone does NOT verify", () => {
    const r = classifyClickVerification(
      probe({ visible_text_hash: "h1" }),
      probe({ visible_text_hash: "h2" }),
      ctx(),
    );
    expect(r.intent_verified).toBe(false);
    expect(r.outcome).toBe("CLICK_DISPATCHED_NO_EFFECT");
    expect(r.recommended_next_step).toBe("try_alternate_ref");
  });

  it("modal-trap: target behind a persistent blocking modal never verifies, even if text changes", () => {
    const blocking = { present: true, blocking: true, overlay_type: "dialog" as const, title_hash: "m1" };
    const r = classifyClickVerification(
      probe({ overlay: { ...blocking }, visible_text_hash: "h1" }),
      probe({ overlay: { ...blocking }, visible_text_hash: "h2" }), // text changed, same modal
      ctx({ targetWasBehindBlockingModal: true }),
    );
    expect(r.intent_verified).toBe(false);
    expect(r.verification_signal).toBe("no_effect");
    expect(r.outcome).toBe("CLICK_DISPATCHED_NO_EFFECT");
  });

  it("modal-trap guard does NOT fire if the URL actually changed", () => {
    const blocking = { present: true, blocking: true, overlay_type: "dialog" as const, title_hash: "m1" };
    const r = classifyClickVerification(
      probe({ url: "https://shop.example.com/a", overlay: { ...blocking } }),
      probe({ url: "https://shop.example.com/b", overlay: { ...blocking } }),
      ctx({ targetWasBehindBlockingModal: true }),
    );
    expect(r.verification_signal).toBe("url_changed");
    expect(r.intent_verified).toBe(true);
  });
});

describe("buildPageStateProbeExpr — shares the overlay snippet (anti-drift)", () => {
  it("embeds the same structural overlay classifier as the snapshot extraction", () => {
    const expr = buildPageStateProbeExpr({});
    const snippet = buildOverlaySnippetJs();
    // Sentinel function names from the shared snippet must appear in the probe.
    expect(snippet).toContain("function overlayKindOf");
    expect(snippet).toContain("function computeOverlay");
    expect(expr).toContain("function overlayKindOf");
    expect(expr).toContain("function computeOverlay");
    expect(expr).toContain("overlaySummary");
  });

  it("interpolates the target box safely and reads page state, not values", () => {
    const expr = buildPageStateProbeExpr({ targetBox: { x: 10, y: 20, width: 30, height: 40 } });
    expect(expr).toContain('"x":10');
    expect(expr).toContain("focusedEditableAtTarget");
    // Hashing is page-side — the probe never returns raw titles or body text.
    expect(expr).toContain("function fnv");
  });

  it("produces syntactically valid JS (snippet concatenation does not break it)", () => {
    expect(() => new Function(`return ${buildPageStateProbeExpr({})}`)).not.toThrow();
    expect(() =>
      new Function(`return ${buildPageStateProbeExpr({ targetBox: { x: 1, y: 2, width: 3, height: 4 } })}`),
    ).not.toThrow();
  });
});
