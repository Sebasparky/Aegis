/**
 * Antigen Snapshot v2 page map — unit tests for buildAntigenPageMap.
 *
 * Pure builder: synthetic AntigenSnapshotElementRecord fixtures + optional page
 * meta in, agent-readable page map out. No DOM, no CDP. Asserts page_kind
 * classification, prioritized/categorized actions, action hints, QUALITATIVE
 * viewport status (no raw geometry), best-effort product cards, warning/modal
 * detection, and evidence metadata.
 */

import { describe, it, expect } from "vitest";
import type { AntigenSnapshotElementRecord } from "../runtime/antigenSnapshotStore.js";
import type { AntigenPageMeta } from "../runtime/antigenSnapshotRuntime.js";
import { buildAntigenPageMap } from "../runtime/antigenSnapshotPageMap.js";

let seq = 0;
function rec(overrides: Partial<AntigenSnapshotElementRecord> = {}): AntigenSnapshotElementRecord {
  seq += 1;
  return {
    snapshot_id: "snap_test",
    ref: `ag_${seq}`,
    browser_session_id: "sess",
    browser_runtime_id: "sess",
    user_id: "user_001",
    tag: "button",
    kind: "button",
    role: "button",
    name: "Button",
    normalized_name: "button",
    id: null,
    href: null,
    href_path: null,
    visible: true,
    enabled: true,
    typeable: false,
    clickable: true,
    box: { x: 10, y: 10, width: 120, height: 40 },
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 10_000).toISOString(),
    ...overrides,
  };
}

const VP: AntigenPageMeta = {
  viewport_w: 1280,
  viewport_h: 800,
  scroll_x: 0,
  scroll_y: 0,
  doc_h: 4000,
};

// ─── A. page_summary + evidence ──────────────────────────────────────────────

describe("buildAntigenPageMap — page_summary + evidence", () => {
  it("derives host/path, page_kind, heading, excerpt, and counts", () => {
    const records = [
      rec({ ref: "ag_1", kind: "link", role: "link", name: "Lamps", normalized_name: "lamps", href_path: "/lamps" }),
      rec({ ref: "ag_2", name: "Add to bag", normalized_name: "add to bag" }),
      rec({ ref: "ag_3", kind: "input", role: "textbox", typeable: true, clickable: false, name: "Email", normalized_name: "email" }),
    ];
    const map = buildAntigenPageMap({
      records,
      pageMeta: { ...VP, heading: "Desk lamps", text_excerpt: "Showing 24 results for desk lamp" },
      viewportOnly: true,
      url: "https://www.example.com/us/en/search/?q=lamp#frag",
    });
    expect(map.page_summary.url_host).toBe("www.example.com");
    expect(map.page_summary.url_path).toBe("/us/en/search/");
    expect(map.page_summary.visible_heading).toBe("Desk lamps");
    expect(map.page_summary.visible_text_excerpt).toContain("results");
    expect(map.page_summary.page_kind).toBe("product_page"); // add-to-bag present

    expect(map.evidence_partial.element_count).toBe(3);
    expect(map.evidence_partial.clickable_count).toBe(2);
    expect(map.evidence_partial.typeable_count).toBe(1);
    expect(typeof map.evidence_partial.visible_text_hash).toBe("string");
  });

  it("omits visible_text_hash when there is no text source", () => {
    const map = buildAntigenPageMap({ records: [rec()], viewportOnly: true, url: null });
    expect(map.evidence_partial.visible_text_hash).toBeUndefined();
    expect(map.page_summary.page_kind).toBe("generic");
  });

  it("classifies page_kind from cart language + checkout", () => {
    const records = [rec({ name: "Checkout", normalized_name: "checkout" })];
    const map = buildAntigenPageMap({
      records,
      pageMeta: { ...VP, text_excerpt: "Your cart subtotal $40 checkout now" },
      viewportOnly: true,
      url: "https://shop.example.com/cart",
    });
    expect(map.page_summary.page_kind).toBe("cart");
  });
});

// ─── B. Prioritized actions ──────────────────────────────────────────────────

describe("buildAntigenPageMap — prioritization", () => {
  it("ranks Add to bag in primary_actions above footer/nav clutter", () => {
    const footer = rec({ ref: "ag_1", kind: "link", role: "link", name: "Privacy", normalized_name: "privacy", href_path: "/privacy", context: { section: "Footer" } });
    const add = rec({ ref: "ag_2", name: "Add to bag", normalized_name: "add to bag" });
    const search = rec({ ref: "ag_3", kind: "input", role: "searchbox", typeable: true, clickable: false, name: "Search IKEA", normalized_name: "search ikea" });

    const map = buildAntigenPageMap({ records: [footer, add, search], viewportOnly: true, url: "https://x.com/" });

    const primaryRefs = map.primary_actions.map((a) => a.ref);
    expect(primaryRefs).toContain("ag_2");
    expect(map.primary_actions[0].ref).toBe("ag_2");
    expect(map.primary_actions[0].priority).toBe("high");

    // Footer link is navigation, never primary.
    expect(primaryRefs).not.toContain("ag_1");
    expect(map.navigation.map((a) => a.ref)).toContain("ag_1");

    // Search input is a form field with a browser_type hint.
    const form = map.forms.find((f) => f.input_refs.includes("ag_3"));
    expect(form).toBeDefined();
    const searchHint = map.action_hints.find((h) => h.ref === "ag_3");
    expect(searchHint?.action_hint).toBe("browser_type");
  });
});

// ─── C. Action hints ─────────────────────────────────────────────────────────

describe("buildAntigenPageMap — action hints", () => {
  it("maps visible click → browser_click, input → browser_type, below-viewport → scroll_then_click", () => {
    const visibleBtn = rec({ ref: "ag_1", name: "Continue", normalized_name: "continue", box: { x: 10, y: 100, width: 100, height: 30 } });
    const input = rec({ ref: "ag_2", kind: "input", role: "textbox", typeable: true, clickable: false, name: "Name", normalized_name: "name" });
    const belowBtn = rec({ ref: "ag_3", name: "Place order", normalized_name: "place order", box: { x: 10, y: 2400, width: 120, height: 40 } });

    const map = buildAntigenPageMap({ records: [visibleBtn, input, belowBtn], pageMeta: VP, viewportOnly: false, url: "https://x.com/" });
    const hint = (ref: string) => map.action_hints.find((h) => h.ref === ref)?.action_hint;
    expect(hint("ag_1")).toBe("browser_click");
    expect(hint("ag_2")).toBe("browser_type");
    expect(hint("ag_3")).toBe("browser_scroll_to_ref_then_click");

    expect(map.ref_status["ag_1"].viewport_status).toBe("visible");
    expect(map.ref_status["ag_3"].viewport_status).toBe("below_viewport");
    expect(map.ref_status["ag_3"].scroll_required).toBe(true);
  });

  it("marks a cookie dismiss button with a dismiss_overlay reason and browser_click", () => {
    const ok = rec({ ref: "ag_1", name: "Accept all", normalized_name: "accept all", context: { section: "Cookie consent banner" } });
    const map = buildAntigenPageMap({ records: [ok], viewportOnly: true, url: "https://x.com/" });
    const cookie = map.warnings_or_modals.find((w) => w.kind === "cookie_banner");
    expect(cookie?.dismiss_refs).toContain("ag_1");
    const hint = map.action_hints.find((h) => h.ref === "ag_1");
    expect(hint?.action_hint).toBe("browser_click");
    expect(hint?.reason).toBe("dismiss_overlay");
  });
});

// ─── D. Qualitative viewport status only (no raw geometry) ────────────────────

describe("buildAntigenPageMap — no raw geometry", () => {
  it("emits qualitative status and never serializes boxes/coords/page-meta numbers", () => {
    const records = [
      rec({ ref: "ag_1", name: "Add to bag", normalized_name: "add to bag", box: { x: 5, y: 5, width: 99, height: 44, doc_x: 5, doc_y: 5 } }),
      rec({ ref: "ag_2", kind: "input", role: "textbox", typeable: true, clickable: false, name: "Q", normalized_name: "q" }),
    ];
    const map = buildAntigenPageMap({ records, pageMeta: { ...VP, scroll_y: 200, text_excerpt: "hello world" }, viewportOnly: false, url: "https://x.com/p" });

    // Qualitative status present…
    expect(map.ref_status["ag_1"].viewport_status).toBe("visible");
    expect(typeof map.ref_status["ag_1"].scroll_required).toBe("boolean");
    expect(map.ref_status["ag_1"].stability_hint).toBe("fresh");

    // …and no raw geometry / page-meta numbers anywhere in the serialized map.
    const raw = JSON.stringify(map);
    for (const f of [
      "\"box\"", "\"x\":", "\"y\":", "\"width\"", "\"height\"",
      "doc_x", "doc_y", "viewport_w", "viewport_h", "scroll_x", "scroll_y", "nearby_text",
    ]) {
      expect(raw).not.toContain(f);
    }
  });

  it("falls back to unknown status when viewport height is missing and not viewport-only", () => {
    const map = buildAntigenPageMap({ records: [rec({ ref: "ag_1" })], viewportOnly: false, url: null });
    expect(map.ref_status["ag_1"].viewport_status).toBe("unknown");
  });
});

// ─── E. Product cards ─────────────────────────────────────────────────────────

describe("buildAntigenPageMap — product cards (best-effort)", () => {
  it("groups title/price/add_ref and clips, without leaking nearby_text", () => {
    const link = rec({ ref: "ag_1", kind: "link", role: "link", name: "BILLY Bookcase", normalized_name: "billy bookcase", href_path: "/p/billy", context: { label: "BILLY Bookcase white $59.99", nearby_text: "BILLY Bookcase white $59.99 SECRET_NEARBY" } });
    const add = rec({ ref: "ag_2", name: "Add to bag", normalized_name: "add to bag", context: { label: "BILLY Bookcase white $59.99", nearby_text: "BILLY Bookcase white $59.99 SECRET_NEARBY" } });

    const map = buildAntigenPageMap({ records: [link, add], viewportOnly: true, url: "https://x.com/" });
    expect(map.product_cards.length).toBe(1);
    const card = map.product_cards[0];
    expect(card.add_ref).toBe("ag_2");
    expect(card.details_ref).toBe("ag_1");
    expect(card.title).toContain("BILLY");
    expect(card.title).not.toContain("$59.99"); // price stripped from title
    expect(card.price_text).toBe("$59.99");

    const raw = JSON.stringify(map);
    expect(raw).not.toContain("SECRET_NEARBY");
    expect(raw).not.toContain("nearby_text");
  });

  it("returns no product cards when there are no add-to-cart controls", () => {
    const map = buildAntigenPageMap({ records: [rec({ name: "Continue", normalized_name: "continue" })], viewportOnly: true, url: null });
    expect(map.product_cards).toEqual([]);
  });
});

// ─── F. Warning / modal detection ─────────────────────────────────────────────

describe("buildAntigenPageMap — warnings/modals", () => {
  it("detects a cookie banner with kind and dismiss ref", () => {
    const accept = rec({ ref: "ag_1", name: "Accept", normalized_name: "accept", context: { section: "Cookie consent" } });
    const map = buildAntigenPageMap({ records: [accept], viewportOnly: true, url: "https://x.com/" });
    const cookie = map.warnings_or_modals.find((w) => w.kind === "cookie_banner");
    expect(cookie).toBeDefined();
    expect(cookie?.dismiss_refs).toContain("ag_1");
    expect(cookie?.action_hint).toBe("browser_click");
  });

  it("detects a login modal overlay", () => {
    const close = rec({ ref: "ag_1", name: "Close", normalized_name: "close", context: { section: "Sign in dialog" } });
    const map = buildAntigenPageMap({ records: [close], viewportOnly: true, url: "https://x.com/" });
    const modal = map.warnings_or_modals.find((w) => w.kind === "login_prompt");
    expect(modal).toBeDefined();
    expect(modal?.dismiss_refs).toContain("ag_1");
  });
});

// ─── G. Structural overlays + prioritization ─────────────────────────────────

describe("buildAntigenPageMap — structural overlays", () => {
  it("surfaces active_overlay + a modal warning with title / primary / dismiss refs", () => {
    const cont = rec({
      ref: "ag_1",
      name: "Continue",
      normalized_name: "continue",
      overlay: { overlay_type: "dialog", blocking: true, modal_title: "Continue as guest" },
    });
    const close = rec({
      ref: "ag_2",
      name: "Close",
      normalized_name: "close",
      overlay: { overlay_type: "dialog", blocking: true, modal_title: "Continue as guest", is_dismiss: true },
    });
    const map = buildAntigenPageMap({ records: [cont, close], viewportOnly: true, url: "https://x.com/checkout" });

    expect(map.active_overlay?.present).toBe(true);
    expect(map.active_overlay?.overlay_type).toBe("dialog");
    expect(map.active_overlay?.blocking).toBe(true);
    expect(map.active_overlay?.modal_title).toBe("Continue as guest");
    expect(map.active_overlay?.primary_action_refs).toEqual(["ag_1"]);
    expect(map.active_overlay?.dismiss_refs).toEqual(["ag_2"]);
    expect(map.active_overlay?.action_refs).toEqual(["ag_1", "ag_2"]);

    const modal = map.warnings_or_modals.find((w) => w.kind === "modal");
    expect(modal?.overlay_type).toBe("dialog");
    expect(modal?.blocking).toBe(true);
    expect(modal?.modal_title).toBe("Continue as guest");
    expect(modal?.primary_action_refs).toEqual(["ag_1"]);
    expect(modal?.dismiss_refs).toEqual(["ag_2"]);
  });

  it("prioritizes the modal's CTA and demotes background actions behind a blocking modal", () => {
    const cont = rec({
      ref: "ag_1",
      name: "Continue",
      normalized_name: "continue",
      overlay: { overlay_type: "dialog", blocking: true, modal_title: "Continue as guest" },
    });
    const bgAdd = rec({ ref: "ag_2", name: "Add to bag", normalized_name: "add to bag" });
    const map = buildAntigenPageMap({ records: [cont, bgAdd], viewportOnly: true, url: "https://x.com/" });

    expect(map.primary_actions[0].ref).toBe("ag_1");
    expect(map.primary_actions[0].reason).toBe("modal_primary_action");
    expect(map.primary_actions.map((a) => a.ref)).not.toContain("ag_2");

    const bg = [...map.primary_actions, ...map.secondary_actions, ...map.navigation].find((a) => a.ref === "ag_2");
    expect(bg?.priority).toBe("low");
    expect(bg?.reason).toBe("behind_active_modal");
  });

  it("excludes inert background controls from action buckets but keeps active_overlay", () => {
    const signin = rec({
      ref: "ag_1",
      name: "Sign in",
      normalized_name: "sign in",
      overlay: { overlay_type: "dialog", blocking: true, modal_title: "Sign in" },
    });
    const inertBtn = rec({
      ref: "ag_2",
      name: "Browse",
      normalized_name: "browse",
      overlay: { overlay_type: "overlay", blocking: false, background: true, in_inert: true },
    });
    const map = buildAntigenPageMap({ records: [signin, inertBtn], viewportOnly: true, url: "https://x.com/" });

    const allActionRefs = [...map.primary_actions, ...map.secondary_actions, ...map.navigation].map((a) => a.ref);
    expect(allActionRefs).not.toContain("ag_2");
    expect(map.active_overlay?.primary_action_refs).toEqual(["ag_1"]);
  });

  it("a nonblocking toast does NOT demote the rest of the page", () => {
    const view = rec({
      ref: "ag_1",
      kind: "link",
      role: "link",
      name: "View bag",
      normalized_name: "view bag",
      href_path: "/cart",
      overlay: { overlay_type: "toast", blocking: false, modal_title: "Added to bag" },
    });
    const add = rec({ ref: "ag_2", name: "Add to bag", normalized_name: "add to bag" });
    const map = buildAntigenPageMap({ records: [view, add], viewportOnly: true, url: "https://x.com/" });

    const toast = map.warnings_or_modals.find((w) => w.kind === "toast");
    expect(toast?.blocking).toBe(false);
    expect(map.active_overlay?.overlay_type).toBe("toast");
    expect(map.active_overlay?.blocking).toBe(false);

    const addAction = [...map.primary_actions, ...map.secondary_actions].find((a) => a.ref === "ag_2");
    expect(addAction?.priority).toBe("high");
    expect(addAction?.reason).not.toBe("behind_active_modal");
  });

  it("surfaces a same-URL checkout dialog even when section text lacks modal keywords", () => {
    const choose = rec({
      ref: "ag_1",
      name: "Choose delivery",
      normalized_name: "choose delivery",
      context: { section: "Delivery options" },
      overlay: { overlay_type: "dialog", blocking: true, modal_title: "Choose delivery" },
    });
    const map = buildAntigenPageMap({ records: [choose], viewportOnly: true, url: "https://x.com/checkout" });
    const modal = map.warnings_or_modals.find((w) => w.kind === "modal");
    expect(modal?.modal_title).toBe("Choose delivery");
    expect(map.active_overlay?.modal_title).toBe("Choose delivery");
  });

  it("omits active_overlay when no overlay is present", () => {
    const add = rec({ ref: "ag_1", name: "Add to bag", normalized_name: "add to bag" });
    const map = buildAntigenPageMap({ records: [add], viewportOnly: true, url: "https://x.com/" });
    expect(map.active_overlay).toBeUndefined();
  });

  it("active_overlay exposes only safe fields — no internal flags or geometry", () => {
    const cont = rec({
      ref: "ag_1",
      name: "Continue",
      normalized_name: "continue",
      overlay: { overlay_type: "dialog", blocking: true, modal_title: "Continue as guest", in_inert: true },
    });
    const map = buildAntigenPageMap({ records: [cont], viewportOnly: true, url: "https://x.com/" });
    const keys = Object.keys(map.active_overlay ?? {}).sort();
    expect(keys).toEqual(
      ["action_refs", "blocking", "dismiss_refs", "modal_title", "overlay_type", "present", "primary_action_refs"].sort(),
    );
    const serialized = JSON.stringify(map.active_overlay);
    expect(serialized).not.toContain("in_inert");
    expect(serialized).not.toContain("bg_hidden");
    expect(serialized).not.toContain("background");
    expect(serialized).not.toMatch(/"(box|x|y|width|height|doc_x|doc_y)"/);
  });
});

describe("buildAntigenPageMap — overlay taxonomy (structural type before login)", () => {
  it("an add-to-bag toast with a 'Log in' link is a toast, NOT login_prompt; background not demoted", () => {
    const view = rec({
      ref: "ag_1", kind: "link", role: "link", name: "View bag", normalized_name: "view bag", href_path: "/cart",
      overlay: { overlay_type: "toast", blocking: false, modal_title: "Added to bag" },
    });
    const login = rec({
      ref: "ag_2", kind: "link", role: "link", name: "Log in", normalized_name: "log in", href_path: "/login",
      overlay: { overlay_type: "toast", blocking: false, modal_title: "Added to bag" },
    });
    const bgAdd = rec({ ref: "ag_3", name: "Add to bag", normalized_name: "add to bag" });
    const map = buildAntigenPageMap({ records: [view, login, bgAdd], viewportOnly: true, url: "https://x.com/" });

    expect(map.warnings_or_modals.some((w) => w.kind === "toast")).toBe(true);
    expect(map.warnings_or_modals.some((w) => w.kind === "login_prompt")).toBe(false);
    const addAction = [...map.primary_actions, ...map.secondary_actions].find((a) => a.ref === "ag_3");
    expect(addAction?.priority).toBe("high");
    expect(addAction?.reason).not.toBe("behind_active_modal");
  });

  it("a cart flyout with an account link is cart_drawer/flyout, NOT login_prompt", () => {
    const checkout = rec({
      ref: "ag_1", name: "Go to checkout", normalized_name: "go to checkout",
      overlay: { overlay_type: "drawer", blocking: false, modal_title: "Your shopping bag" },
    });
    const login = rec({
      ref: "ag_2", kind: "link", role: "link", name: "Log in to checkout faster", normalized_name: "log in to checkout faster",
      overlay: { overlay_type: "drawer", blocking: false, modal_title: "Your shopping bag" },
    });
    const map = buildAntigenPageMap({ records: [checkout, login], viewportOnly: true, url: "https://x.com/" });
    const w = map.warnings_or_modals.find((m) => m.overlay_type === "drawer");
    expect(["cart_drawer", "flyout"]).toContain(w?.kind);
    expect(w?.kind).not.toBe("login_prompt");
  });

  it("a checkout method dialog (guest + login) is login_checkout with active_overlay + demoted background", () => {
    const guest = rec({
      ref: "ag_1", name: "Continue as guest", normalized_name: "continue as guest",
      overlay: { overlay_type: "dialog", blocking: true, modal_title: "Choose how you would like to check out" },
    });
    const login = rec({
      ref: "ag_2", name: "Log in", normalized_name: "log in",
      overlay: { overlay_type: "dialog", blocking: true, modal_title: "Choose how you would like to check out" },
    });
    const bgCart = rec({ ref: "ag_3", kind: "link", role: "link", name: "View bag", normalized_name: "view bag", href_path: "/cart" });
    const map = buildAntigenPageMap({ records: [guest, login, bgCart], viewportOnly: true, url: "https://x.com/checkout" });

    expect(map.warnings_or_modals.some((w) => w.kind === "login_checkout")).toBe(true);
    expect(map.warnings_or_modals.some((w) => w.kind === "login_prompt")).toBe(false);
    expect(map.active_overlay?.present).toBe(true);
    expect(map.active_overlay?.blocking).toBe(true);
    expect(map.active_overlay?.modal_title).toBe("Choose how you would like to check out");
    expect(map.active_overlay?.primary_action_refs).toContain("ag_1");

    const bg = [...map.primary_actions, ...map.secondary_actions, ...map.navigation].find((a) => a.ref === "ag_3");
    expect(bg?.priority).toBe("low");
    expect(bg?.reason).toBe("behind_active_modal");
  });

  it("a chat widget is chat_widget/nonblocking and never wins active_overlay over a blocking modal", () => {
    const chat = rec({
      ref: "ag_1", name: "Send", normalized_name: "send",
      overlay: { overlay_type: "popover", blocking: false, modal_title: "Live chat" },
    });
    const confirm = rec({
      ref: "ag_2", name: "Confirm order", normalized_name: "confirm order",
      overlay: { overlay_type: "dialog", blocking: true, modal_title: "Confirm your order" },
    });
    const map = buildAntigenPageMap({ records: [chat, confirm], viewportOnly: true, url: "https://x.com/" });

    const chatW = map.warnings_or_modals.find((w) => w.overlay_type === "popover");
    expect(chatW?.kind).toBe("chat_widget");
    expect(chatW?.blocking).toBe(false);
    // The blocking modal — not the chat widget — is the dominant active overlay.
    expect(map.active_overlay?.overlay_type).toBe("dialog");
    expect(map.active_overlay?.blocking).toBe(true);
    expect(map.active_overlay?.modal_title).toBe("Confirm your order");
  });

  it("a lone chat widget does NOT demote the rest of the page", () => {
    const chat = rec({
      ref: "ag_1", name: "Send", normalized_name: "send",
      overlay: { overlay_type: "popover", blocking: false, modal_title: "Help chat" },
    });
    const add = rec({ ref: "ag_2", name: "Add to bag", normalized_name: "add to bag" });
    const map = buildAntigenPageMap({ records: [chat, add], viewportOnly: true, url: "https://x.com/" });
    const addAction = [...map.primary_actions, ...map.secondary_actions].find((a) => a.ref === "ag_2");
    expect(addAction?.priority).toBe("high");
    expect(addAction?.reason).not.toBe("behind_active_modal");
  });

  it("a cookie consent rendered as role=dialog stays cookie_banner — never the blocking active_overlay", () => {
    const accept = rec({
      ref: "ag_1", name: "Accept all", normalized_name: "accept all",
      context: { section: "Cookie consent" },
      overlay: { overlay_type: "dialog", blocking: true, modal_title: "We use cookies" },
    });
    const map = buildAntigenPageMap({ records: [accept], viewportOnly: true, url: "https://x.com/" });
    expect(map.warnings_or_modals.some((w) => w.kind === "cookie_banner")).toBe(true);
    // Cookie banners never count as the dominant active overlay and never demote.
    expect(map.active_overlay).toBeUndefined();
    const action = [...map.primary_actions, ...map.secondary_actions].find((a) => a.ref === "ag_1");
    expect(action?.reason).not.toBe("modal_primary_action");
    expect(action?.reason).not.toBe("behind_active_modal");
  });
});
