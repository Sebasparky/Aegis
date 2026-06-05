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
