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
  selectSettleSchedule,
  CLICK_VERIFY_SETTLE_SCHEDULE_MS,
  CART_MUTATION_SETTLE_SCHEDULE_MS,
  CHECKOUT_TRANSITION_SETTLE_SCHEDULE_MS,
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
    cartMutationIntent: false,
    checkoutTransitionIntent: false,
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

describe("classifyClickVerification — cart-mutation intent (Step-2 add-to-bag fix)", () => {
  it("cart_mutation first add null→1 verifies as cart_changed", () => {
    const r = classifyClickVerification(
      probe({ cart_count: null }),
      probe({ cart_count: 1 }),
      ctx({ cartMutationIntent: true }),
    );
    expect(r.verification_signal).toBe("cart_changed");
    expect(r.intent_verified).toBe(true);
    expect(r.outcome).toBe("CLICK_VERIFIED");
  });

  it("generic click null→1 does NOT verify (cart-mutation gate)", () => {
    const r = classifyClickVerification(
      probe({ cart_count: null }),
      probe({ cart_count: 1 }),
      ctx({ cartMutationIntent: false }),
    );
    expect(r.intent_verified).toBe(false);
    expect(r.verification_signal).toBe("no_effect");
  });

  it("0→1 still verifies for a generic click (both-present path, intent-agnostic)", () => {
    const r = classifyClickVerification(
      probe({ cart_count: 0 }),
      probe({ cart_count: 1 }),
      ctx(),
    );
    expect(r.verification_signal).toBe("cart_changed");
    expect(r.intent_verified).toBe(true);
  });

  it("cart_mutation null→0 does NOT verify (no positive quantity)", () => {
    const r = classifyClickVerification(
      probe({ cart_count: null }),
      probe({ cart_count: 0 }),
      ctx({ cartMutationIntent: true }),
    );
    expect(r.intent_verified).toBe(false);
    expect(r.verification_signal).toBe("no_effect");
  });

  it("persistent toast + new region (count 1→2, same dominant) verifies overlay_changed ONLY for cart_mutation", () => {
    const persistent = { present: true, blocking: false, overlay_type: "toast" as const, title_hash: "t1" };
    const before = probe({ cart_count: null, overlay: { ...persistent, count: 1 } });
    const after = probe({ cart_count: null, overlay: { ...persistent, count: 2 } });

    const cart = classifyClickVerification(before, after, ctx({ cartMutationIntent: true }));
    expect(cart.verification_signal).toBe("overlay_changed");
    expect(cart.intent_verified).toBe(true);

    const generic = classifyClickVerification(before, after, ctx({ cartMutationIntent: false }));
    expect(generic.intent_verified).toBe(false);
    expect(generic.verification_signal).toBe("no_effect");
  });

  it("does not leak overlay count / cart_count onto the ClickVerification result", () => {
    const r = classifyClickVerification(
      probe({ cart_count: null, overlay: { present: true, blocking: false, overlay_type: "toast", title_hash: "t1", count: 1 } }),
      probe({ cart_count: 1, overlay: { present: true, blocking: false, overlay_type: "toast", title_hash: "t1", count: 2 } }),
      ctx({ cartMutationIntent: true }),
    );
    const keys = Object.keys(r);
    expect(keys).not.toContain("count");
    expect(keys).not.toContain("cart_count");
    expect(keys).not.toContain("title_hash");
    expect(keys).not.toContain("visible_text_hash");
  });
});

describe("selectSettleSchedule — cart_mutation polls longer (async confirmation)", () => {
  it("cart_mutation, non-editable, not modal-trap → extended schedule (~1.2s, ≤1.3s)", () => {
    const s = selectSettleSchedule(ctx({ cartMutationIntent: true }), false);
    expect(s).toBe(CART_MUTATION_SETTLE_SCHEDULE_MS);
    expect(s.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1300);
    expect(s.reduce((a, b) => a + b, 0)).toBeGreaterThan(CLICK_VERIFY_SETTLE_SCHEDULE_MS.reduce((a, b) => a + b, 0));
  });

  it("navigation / generic click → default cheap schedule", () => {
    expect(selectSettleSchedule(ctx({ cartMutationIntent: false }), false)).toBe(CLICK_VERIFY_SETTLE_SCHEDULE_MS);
  });

  it("editable/focus target never gets the extended schedule (cheap single-probe path)", () => {
    // Even if cartMutationIntent were set, an editable target uses the default
    // (and the runtime skips the poll loop entirely for editable targets).
    expect(selectSettleSchedule(ctx({ cartMutationIntent: true }), true)).toBe(CLICK_VERIFY_SETTLE_SCHEDULE_MS);
  });

  it("cart_mutation behind a blocking modal (modal-trap) uses the default schedule, not extended", () => {
    expect(
      selectSettleSchedule(ctx({ cartMutationIntent: true, targetWasBehindBlockingModal: true }), false),
    ).toBe(CLICK_VERIFY_SETTLE_SCHEDULE_MS);
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

describe("selectSettleSchedule — checkout_transition polls longer (slow checkout overlays)", () => {
  it("checkout_transition, non-editable, not modal-trap → extended schedule (~1.6s, ≤1.7s)", () => {
    const s = selectSettleSchedule(ctx({ checkoutTransitionIntent: true }), false);
    expect(s).toBe(CHECKOUT_TRANSITION_SETTLE_SCHEDULE_MS);
    expect(s.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1700);
    expect(s.reduce((a, b) => a + b, 0)).toBeGreaterThan(CLICK_VERIFY_SETTLE_SCHEDULE_MS.reduce((a, b) => a + b, 0));
  });

  it("editable/focus target never gets the extended schedule", () => {
    expect(selectSettleSchedule(ctx({ checkoutTransitionIntent: true }), true)).toBe(CLICK_VERIFY_SETTLE_SCHEDULE_MS);
  });

  it("checkout_transition behind a blocking modal (modal-trap) uses the default schedule", () => {
    expect(
      selectSettleSchedule(ctx({ checkoutTransitionIntent: true, targetWasBehindBlockingModal: true }), false),
    ).toBe(CLICK_VERIFY_SETTLE_SCHEDULE_MS);
  });

  it("cart_mutation takes precedence when both intents are set", () => {
    expect(
      selectSettleSchedule(ctx({ cartMutationIntent: true, checkoutTransitionIntent: true }), false),
    ).toBe(CART_MUTATION_SETTLE_SCHEDULE_MS);
  });
});

describe("buildPageStateProbeExpr — display state + surface-action collection (post_click_state)", () => {
  it("collection is OFF by default and ON only when requested", () => {
    expect(buildPageStateProbeExpr({})).toContain("var COLLECT_ACTIONS=false");
    const on = buildPageStateProbeExpr({ collectSurfaceActions: true });
    expect(on).toContain("var COLLECT_ACTIONS=true");
    expect(on).toContain("function overlayActions");
    expect(on).toContain("function actionName");
  });

  it("action names read .value ONLY for submit/button/reset inputs (nameOf precedence)", () => {
    const expr = buildPageStateProbeExpr({ collectSurfaceActions: true });
    expect(expr).toContain("tag==='input'&&(type==='submit'||type==='button'||type==='reset')");
    // No generic value read outside that guard: every `.value` mention sits
    // inside the guarded actionName branch (same as buildSurfaceActionSearchExpr).
    const valueReads = expr.split("el.value").length - 1;
    expect(valueReads).toBeLessThanOrEqual(2); // null-check + read, one guarded site
  });

  it("returns ready_state and clipped display titles alongside the hashes", () => {
    const expr = buildPageStateProbeExpr({});
    expect(expr).toContain("document.readyState");
    expect(expr).toContain("ready_state:");
    expect(expr).toContain("title: docTitle?clip(docTitle,120):null");
    expect(expr).toContain("title:ttl?clip(ttl,120):null");
    // Hash comparison keys remain.
    expect(expr).toContain("title_hash: docTitle?fnv(docTitle):null");
  });

  it("remains syntactically valid JS with collection enabled", () => {
    expect(() =>
      new Function(`return ${buildPageStateProbeExpr({ collectSurfaceActions: true, targetBox: { x: 1, y: 2, width: 3, height: 4 } })}`),
    ).not.toThrow();
  });
});

describe("classifyClickVerification — display fields never affect classification", () => {
  it("differing overlay display titles with the SAME title_hash do not verify overlay_changed", () => {
    const r = classifyClickVerification(
      probe({ overlay: { present: true, blocking: false, overlay_type: "toast", title_hash: "t1", title: "Saved to bag" } }),
      probe({ overlay: { present: true, blocking: false, overlay_type: "toast", title_hash: "t1", title: "A totally different display title" } }),
      ctx(),
    );
    expect(r.intent_verified).toBe(false);
    expect(r.verification_signal).toBe("no_effect");
  });

  it("differing document display titles with the SAME title_hash do not verify title_changed", () => {
    const r = classifyClickVerification(
      probe({ title: "Shopping bag", title_hash: "h1" }),
      probe({ title: "Checkout", title_hash: "h1" }),
      ctx(),
    );
    expect(r.intent_verified).toBe(false);
  });

  it("ready_state and probe actions never leak onto the ClickVerification result", () => {
    const r = classifyClickVerification(
      probe({ ready_state: "interactive" }),
      probe({
        ready_state: "complete",
        overlay: {
          present: true, blocking: true, overlay_type: "dialog", title_hash: "m1",
          title: "Choose how to check out",
          actions: [{ name: "Continue as guest", kind: "button", dismiss: false }],
        },
      }),
      ctx(),
    );
    expect(r.verification_signal).toBe("modal_opened");
    const keys = Object.keys(r);
    expect(keys).not.toContain("ready_state");
    expect(keys).not.toContain("actions");
    expect(keys).not.toContain("title");
    expect(keys).not.toContain("post_click_internal"); // runtime fills this, never the classifier
  });
});
