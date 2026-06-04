/**
 * Antigen Snapshot Runtime — extraction tests.
 *
 * Strategy (mirrors realistic-browser-actions.test.ts):
 * - Thoroughly unit-test the page-side IIFE builder against a lightweight mock
 *   DOM via `new Function(expr)()`, and the pure TS helpers in isolation.
 * - Add one smoke-level CDP transport test through a self-driving `ws` mock.
 *
 * No jsdom: the test environment is "node"; we stub global.document / window /
 * getComputedStyle per evaluation, exactly like the existing runtime tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Self-driving CDP WebSocket mock (for the smoke transport test) ──────────

const mockState = vi.hoisted(() => ({
  allSentMessages: [] as string[],
  // The array the page-side IIFE "returns" via Runtime.evaluate.
  nextEvalResponse: null as unknown,
  reset() {
    this.allSentMessages = [];
    this.nextEvalResponse = null;
  },
}));

vi.mock("ws", () => {
  const state = mockState;
  class MockWs {
    private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    constructor(_url: string) {
      setImmediate(() => this._fire("open"));
    }
    on(event: string, fn: (...a: unknown[]) => void) {
      const arr = this.handlers.get(event) ?? [];
      arr.push(fn);
      this.handlers.set(event, arr);
    }
    send(rawData: string) {
      state.allSentMessages.push(rawData);
      let msg: { id: number; method: string };
      try {
        msg = JSON.parse(rawData);
      } catch {
        return;
      }
      if (msg.method === "Target.attachToTarget") {
        setImmediate(() =>
          this._fire("message", Buffer.from(JSON.stringify({ id: msg.id, result: { sessionId: "mock-session" } }))),
        );
      }
      if (msg.method === "Runtime.evaluate") {
        const val = state.nextEvalResponse;
        setImmediate(() =>
          this._fire("message", Buffer.from(JSON.stringify({ id: msg.id, result: { result: { value: val } } }))),
        );
      }
    }
    close() {}
    terminate() {}
    _fire(event: string, ...args: unknown[]) {
      (this.handlers.get(event) ?? []).forEach((fn) => fn(...args));
    }
  }
  return { default: MockWs };
});

import {
  buildAntigenExtractionExpr,
  extractAntigenSnapshotCandidatesViaCDP,
  normalizeName,
  hrefPath,
  inferKind,
  inferRole,
  inferTypeable,
  inferClickable,
  computeEnabled,
  mapRawToCandidate,
  sanitizeContext,
  ANTIGEN_CANDIDATE_SELECTOR,
  type RawAntigenCandidate,
} from "../runtime/antigenSnapshotRuntime.js";

// ─── Mock-DOM harness for the page-side IIFE ─────────────────────────────────

interface MockElOpts {
  tag: string;
  attrs?: Record<string, string>;
  type?: string;
  textContent?: string;
  innerText?: string;
  value?: string;
  disabled?: boolean;
  readOnly?: boolean;
  contentEditable?: boolean;
  isContentEditable?: boolean;
  labels?: Array<{ textContent: string }>;
  imgAlt?: string;
  // Layout / style controls
  box?: { left: number; top: number; width: number; height: number };
  visible?: boolean;
  display?: string;
  visibility?: string;
  opacity?: string;
}

interface MockEl {
  __opts: MockElOpts;
  tagName: string;
  textContent: string;
  innerText: string;
  value: string;
  disabled: boolean;
  readOnly: boolean;
  isContentEditable: boolean;
  labels: Array<{ textContent: string }>;
  // Ancestor / sibling links for context extraction (default null).
  parentElement: MockEl | null;
  previousElementSibling: MockEl | null;
  getAttribute: (n: string) => string | null;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  querySelector: (sel: string) => { getAttribute: (n: string) => string | null } | null;
}

function makeEl(opts: MockElOpts): MockEl {
  const visible = opts.visible ?? true;
  const box = opts.box ?? { left: 100, top: 80, width: visible ? 120 : 0, height: visible ? 36 : 0 };
  const attrs: Record<string, string> = { ...(opts.attrs ?? {}) };
  if (opts.type !== undefined) attrs["type"] = opts.type;
  if (opts.contentEditable) attrs["contenteditable"] = "true";

  return {
    __opts: opts,
    tagName: opts.tag.toUpperCase(),
    textContent: opts.textContent ?? "",
    innerText: opts.innerText ?? opts.textContent ?? "",
    value: opts.value ?? "",
    disabled: opts.disabled ?? false,
    readOnly: opts.readOnly ?? false,
    isContentEditable: opts.isContentEditable ?? opts.contentEditable ?? false,
    labels: opts.labels ?? [],
    parentElement: null,
    previousElementSibling: null,
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    getBoundingClientRect: () => box,
    querySelector: (sel: string) => {
      if (sel === "img" && opts.imgAlt !== undefined) {
        return { getAttribute: (n: string) => (n === "alt" ? opts.imgAlt ?? null : null) };
      }
      return null;
    },
  };
}

// ─── Richer DOM-tree harness (for Phase 5A context heuristics) ────────────────
// Supports descendant querySelectorAll, innerText aggregation, sibling links,
// and document.querySelector("h1") — what the deeper context heuristic needs.

interface TNode {
  tagName: string;
  __own: string;
  __kids: TNode[];
  value: string;
  disabled: boolean;
  readOnly: boolean;
  isContentEditable: boolean;
  labels: Array<{ textContent: string }>;
  parentElement: TNode | null;
  previousElementSibling: TNode | null;
  nextElementSibling: TNode | null;
  getAttribute: (n: string) => string | null;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  querySelector: (sel: string) => TNode | null;
  querySelectorAll: (sel: string) => TNode[];
  readonly innerText: string;
  readonly textContent: string;
}

function tDescendants(node: TNode): TNode[] {
  const out: TNode[] = [];
  for (const k of node.__kids) {
    out.push(k);
    out.push(...tDescendants(k));
  }
  return out;
}
function tAggText(node: TNode): string {
  const parts = [node.__own, ...tDescendants(node).map((d) => d.__own)].filter(Boolean);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
function tMatchTok(d: TNode, tok: string): boolean {
  const t = tok.trim();
  if (t === '[role="heading"]') return d.getAttribute("role") === "heading";
  return d.tagName === t.toUpperCase();
}
function tMatchAll(node: TNode, sel: string): TNode[] {
  const toks = sel.split(",");
  return tDescendants(node).filter((d) => toks.some((tok) => tMatchTok(d, tok)));
}
function tnode(opts: {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  type?: string;
  value?: string;
  box?: { left: number; top: number; width: number; height: number };
  children?: TNode[];
}): TNode {
  const attrs: Record<string, string> = { ...(opts.attrs ?? {}) };
  if (opts.type !== undefined) attrs["type"] = opts.type;
  const self: TNode = {
    tagName: opts.tag.toUpperCase(),
    __own: opts.text ?? "",
    __kids: [],
    value: opts.value ?? "",
    disabled: false,
    readOnly: false,
    isContentEditable: false,
    labels: [],
    parentElement: null,
    previousElementSibling: null,
    nextElementSibling: null,
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    getBoundingClientRect: () => opts.box ?? { left: 10, top: 10, width: 120, height: 32 },
    querySelector: (sel: string) => tMatchAll(self, sel)[0] ?? null,
    querySelectorAll: (sel: string) => tMatchAll(self, sel),
    get innerText() {
      return tAggText(self);
    },
    get textContent() {
      return tAggText(self);
    },
  };
  if (opts.children) {
    let prev: TNode | null = null;
    for (const k of opts.children) {
      k.parentElement = self;
      k.previousElementSibling = prev;
      if (prev) prev.nextElementSibling = k;
      prev = k;
      self.__kids.push(k);
    }
  }
  return self;
}

/** A nav-like block of filler links, enough to make an ancestor read as a broad page region. */
function fillerLinks(n: number): TNode {
  const links = Array.from({ length: n }, (_, i) => tnode({ tag: "a", attrs: { href: `/n${i}` }, text: `Nav ${i}` }));
  return tnode({ tag: "nav", children: links });
}

/** Evaluates the extraction IIFE against a TNode tree; `root` backs document.querySelector. */
function extractTree(
  candidates: TNode[],
  root: TNode | null,
  opts?: { maxCandidates?: number; viewportOnly?: boolean },
) {
  const g = global as Record<string, unknown>;
  const savedDoc = g["document"];
  const savedWin = g["window"];
  g["window"] = {
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };
  const all = root ? [root, ...tDescendants(root)] : [];
  g["document"] = {
    querySelectorAll: () => candidates,
    querySelector: (sel: string) => all.find((d) => tMatchTok(d, sel)) ?? null,
    getElementById: (id: string) => all.find((d) => d.getAttribute("id") === id) ?? null,
  };
  try {
    const expr = buildAntigenExtractionExpr({
      maxCandidates: opts?.maxCandidates ?? 200,
      viewportOnly: opts?.viewportOnly ?? false,
    });
    const raw = new Function(`return ${expr}`)() as RawAntigenCandidate[];
    return raw.map((r, i) => mapRawToCandidate(r, i));
  } finally {
    g["document"] = savedDoc;
    g["window"] = savedWin;
  }
}

/**
 * Evaluates the extraction IIFE against a set of mock elements by temporarily
 * installing global.document / window / getComputedStyle.
 */
function evalExtraction(
  els: MockEl[],
  opts?: { maxCandidates?: number; viewportOnly?: boolean; innerWidth?: number; innerHeight?: number },
): RawAntigenCandidate[] {
  const g = global as Record<string, unknown>;
  const savedDoc = g["document"];
  const savedWin = g["window"];

  const getComputedStyle = (el: MockEl) => ({
    display: el.__opts.display ?? "block",
    visibility: el.__opts.visibility ?? "visible",
    opacity: el.__opts.opacity ?? "1",
  });

  const win = {
    innerWidth: opts?.innerWidth ?? 1280,
    innerHeight: opts?.innerHeight ?? 800,
    getComputedStyle,
  };

  g["window"] = win;
  g["document"] = {
    querySelectorAll: () => els,
    getElementById: (id: string) => {
      for (const el of els) {
        if (el.getAttribute("id") === id) return el;
      }
      return null;
    },
  };

  try {
    const expr = buildAntigenExtractionExpr({
      maxCandidates: opts?.maxCandidates ?? 200,
      viewportOnly: opts?.viewportOnly ?? false,
    });
    return new Function(`return ${expr}`)() as RawAntigenCandidate[];
  } finally {
    g["document"] = savedDoc;
    g["window"] = savedWin;
  }
}

/** End-to-end (page extraction + TS mapping) without CDP. */
function extractCandidates(
  els: MockEl[],
  opts?: { maxCandidates?: number; viewportOnly?: boolean; innerWidth?: number; innerHeight?: number },
) {
  const raw = evalExtraction(els, opts);
  return raw.slice(0, opts?.maxCandidates ?? 200).map((r, i) => mapRawToCandidate(r, i));
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockState.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── 0. The generated IIFE is valid JS ───────────────────────────────────────

describe("buildAntigenExtractionExpr — validity", () => {
  it("produces syntactically valid JS for both viewportOnly modes", () => {
    expect(() => new Function(`return ${buildAntigenExtractionExpr({ maxCandidates: 200, viewportOnly: true })}`)).not.toThrow();
    expect(() => new Function(`return ${buildAntigenExtractionExpr({ maxCandidates: 50, viewportOnly: false })}`)).not.toThrow();
  });

  it("uses the documented generic selector list (not site-specific)", () => {
    expect(ANTIGEN_CANDIDATE_SELECTOR).toContain("a[href]");
    expect(ANTIGEN_CANDIDATE_SELECTOR).toContain('[contenteditable="true"]');
    expect(ANTIGEN_CANDIDATE_SELECTOR).toContain('[role="searchbox"]');
    // No brand/site coupling.
    expect(ANTIGEN_CANDIDATE_SELECTOR.toLowerCase()).not.toContain("ikea");
    expect(ANTIGEN_CANDIDATE_SELECTOR.toLowerCase()).not.toContain("target");
  });
});

// ─── 1. Link extraction ───────────────────────────────────────────────────────

describe("extraction — link", () => {
  it("extracts a visible link with name, href, href_path, kind=link, clickable=true", () => {
    const el = makeEl({ tag: "a", attrs: { href: "https://shop.example.com/catalog/lamps?ref=nav" }, textContent: "Lamps" });
    const [c] = extractCandidates([el]);
    expect(c.kind).toBe("link");
    expect(c.name).toBe("Lamps");
    expect(c.href).toBe("https://shop.example.com/catalog/lamps?ref=nav");
    expect(c.href_path).toBe("/catalog/lamps");
    expect(c.clickable).toBe(true);
    expect(c.typeable).toBe(false);
    expect(c.visible).toBe(true);
    expect(c.enabled).toBe(true);
  });

  it("uses inner <img> alt text when a link has no text", () => {
    const el = makeEl({ tag: "a", attrs: { href: "/account" }, imgAlt: "My account" });
    const [c] = extractCandidates([el]);
    expect(c.name).toBe("My account");
    expect(c.kind).toBe("link");
    expect(c.href_path).toBe("/account");
  });
});

// ─── 2. Button extraction ──────────────────────────────────────────────────────

describe("extraction — button", () => {
  it("extracts a visible button with name and kind=button", () => {
    const el = makeEl({ tag: "button", textContent: "Add to cart" });
    const [c] = extractCandidates([el]);
    expect(c.kind).toBe("button");
    expect(c.name).toBe("Add to cart");
    expect(c.clickable).toBe(true);
    expect(c.typeable).toBe(false);
  });

  it("reads input[type=submit] value as the button label", () => {
    const el = makeEl({ tag: "input", type: "submit", value: "Search" });
    const [c] = extractCandidates([el]);
    expect(c.kind).toBe("button");
    expect(c.name).toBe("Search");
  });
});

// ─── 3 & 4. Typeable controls ──────────────────────────────────────────────────

describe("extraction — typeable controls", () => {
  it("extracts a search input via placeholder, typeable=true", () => {
    const el = makeEl({ tag: "input", type: "search", attrs: { placeholder: "Search products" } });
    const [c] = extractCandidates([el]);
    expect(c.kind).toBe("input");
    expect(c.role).toBe("searchbox");
    expect(c.name).toBe("Search products");
    expect(c.typeable).toBe(true);
    expect(c.clickable).toBe(false);
  });

  it("extracts a text input via aria-label, typeable=true", () => {
    const el = makeEl({ tag: "input", type: "text", attrs: { "aria-label": "Full name" } });
    const [c] = extractCandidates([el]);
    expect(c.name).toBe("Full name");
    expect(c.typeable).toBe(true);
  });

  it("extracts a textarea as kind=textarea, typeable=true", () => {
    const el = makeEl({ tag: "textarea", attrs: { "aria-label": "Comments" } });
    const [c] = extractCandidates([el]);
    expect(c.kind).toBe("textarea");
    expect(c.typeable).toBe(true);
  });

  it("extracts a select as kind=select, clickable=true, typeable=false", () => {
    const el = makeEl({ tag: "select", attrs: { "aria-label": "Country" } });
    const [c] = extractCandidates([el]);
    expect(c.kind).toBe("select");
    expect(c.clickable).toBe(true);
    expect(c.typeable).toBe(false);
  });

  it("extracts a contenteditable region as kind=editable, typeable=true", () => {
    const el = makeEl({ tag: "div", contentEditable: true, attrs: { "aria-label": "Message body" } });
    const [c] = extractCandidates([el]);
    expect(c.kind).toBe("editable");
    expect(c.typeable).toBe(true);
  });
});

// ─── 5. Visibility filtering ───────────────────────────────────────────────────

describe("extraction — visibility filtering", () => {
  it("filters out display:none, visibility:hidden, and zero-size elements", () => {
    const visible = makeEl({ tag: "button", textContent: "Visible" });
    const hidden = makeEl({ tag: "button", textContent: "DisplayNone", display: "none" });
    const collapsed = makeEl({ tag: "button", textContent: "VisibilityHidden", visibility: "hidden" });
    const zero = makeEl({ tag: "button", textContent: "Zero", visible: false });
    const transparent = makeEl({ tag: "button", textContent: "Transparent", opacity: "0" });

    const out = extractCandidates([visible, hidden, collapsed, zero, transparent]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Visible");
  });

  it("filters aria-hidden=true elements", () => {
    const el = makeEl({ tag: "button", textContent: "Decorative", attrs: { "aria-hidden": "true" } });
    expect(extractCandidates([el])).toHaveLength(0);
  });
});

// ─── 6. Disabled / aria-disabled ───────────────────────────────────────────────

describe("extraction — enablement", () => {
  it("marks disabled controls as enabled=false", () => {
    const el = makeEl({ tag: "button", textContent: "Submit", disabled: true });
    const [c] = extractCandidates([el]);
    expect(c.enabled).toBe(false);
  });

  it("marks aria-disabled controls as enabled=false and not typeable", () => {
    const el = makeEl({ tag: "input", type: "text", attrs: { "aria-disabled": "true", "aria-label": "Locked" } });
    const [c] = extractCandidates([el]);
    expect(c.enabled).toBe(false);
    expect(c.typeable).toBe(false);
  });

  it("readonly text input is enabled but not typeable", () => {
    const el = makeEl({ tag: "input", type: "text", readOnly: true, attrs: { "aria-label": "Readonly" } });
    const [c] = extractCandidates([el]);
    expect(c.enabled).toBe(true);
    expect(c.typeable).toBe(false);
  });
});

// ─── 7 & 8. Sensitive value protection ─────────────────────────────────────────

describe("extraction — sensitive value protection", () => {
  it("never exposes a password input value (name comes from label, not value)", () => {
    const el = makeEl({
      tag: "input",
      type: "password",
      value: "hunter2-SECRET",
      attrs: { "aria-label": "Password", placeholder: "Enter password" },
    });
    const [c] = extractCandidates([el]);
    expect(c.name).toBe("Password");
    expect(JSON.stringify(c)).not.toContain("hunter2-SECRET");
    expect(JSON.stringify(c)).not.toContain("value");
  });

  it("excludes hidden inputs entirely and never reads their value", () => {
    const hidden = makeEl({ tag: "input", type: "hidden", value: "csrf-TOKEN-XYZ", attrs: { name: "csrf" } });
    const visible = makeEl({ tag: "button", textContent: "Go" });
    const out = extractCandidates([hidden, visible]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Go");
    expect(JSON.stringify(out)).not.toContain("csrf-TOKEN-XYZ");
  });

  it("never reads value for payment-looking (cc) text inputs", () => {
    const el = makeEl({
      tag: "input",
      type: "text",
      value: "4111111111111111",
      attrs: { "aria-label": "Card number", autocomplete: "cc-number" },
    });
    const [c] = extractCandidates([el]);
    expect(c.name).toBe("Card number");
    expect(JSON.stringify(c)).not.toContain("4111111111111111");
  });
});

// ─── 9. Candidate cap ──────────────────────────────────────────────────────────

describe("extraction — cap", () => {
  it("caps candidates at maxCandidates", () => {
    const els = Array.from({ length: 25 }, (_, i) => makeEl({ tag: "button", textContent: `B${i}` }));
    const out = extractCandidates(els, { maxCandidates: 10 });
    expect(out).toHaveLength(10);
    expect(out[0].name).toBe("B0");
    expect(out[9].name).toBe("B9");
  });
});

// ─── 10. Normalization ──────────────────────────────────────────────────────────

describe("normalizeName", () => {
  it("lowercases, strips punctuation, collapses whitespace deterministically", () => {
    expect(normalizeName("  Add  to  Cart!! ")).toBe("add to cart");
    expect(normalizeName("Sign-In / Register")).toBe("sign in register");
    expect(normalizeName('"Buy now."')).toBe("buy now");
  });

  it("keeps & (e.g. category names)", () => {
    expect(normalizeName("Home & Kitchen")).toBe("home & kitchen");
  });

  it("is deterministic across repeated calls", () => {
    const input = "TERTIAL, Work_lamp";
    expect(normalizeName(input)).toBe(normalizeName(input));
    expect(normalizeName(input)).toBe("tertial work lamp");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeName("")).toBe("");
  });
});

// ─── 11. Box presence ──────────────────────────────────────────────────────────

describe("extraction — box", () => {
  it("includes box values for visible candidates", () => {
    const el = makeEl({ tag: "button", textContent: "Buy", box: { left: 42, top: 17, width: 88, height: 30 } });
    const [c] = extractCandidates([el]);
    // Viewport-relative x/y plus document-space doc_x/doc_y (Phase 5C). The
    // simulated page is at scroll offset 0, so doc_x/doc_y equal x/y here.
    expect(c.box).toEqual({ x: 42, y: 17, width: 88, height: 30, doc_x: 42, doc_y: 17 });
  });
});

// ─── 12. Forbidden fields ───────────────────────────────────────────────────────

describe("extraction — output hygiene", () => {
  // Internal identifiers and a planted secret value — none may ever appear.
  // (Note: legitimate accessible names like "Password" are allowed; we assert
  // the structural key allowlist plus the absence of the secret VALUE.)
  const FORBIDDEN = [
    "cdp_url",
    "cdpUrl",
    "user_data_dir",
    "profile_key",
    "pass_id",
    "secret_ref",
    "storageState",
    "innerHTML",
    "SECRETVAL123",
  ];

  it("returned candidates expose only the allowed candidate fields", () => {
    const els = [
      makeEl({ tag: "a", attrs: { href: "/x" }, textContent: "Link" }),
      makeEl({ tag: "button", textContent: "Btn" }),
      makeEl({ tag: "input", type: "password", value: "SECRETVAL123", attrs: { "aria-label": "Password" } }),
    ];
    const out = extractCandidates(els);
    const allowedKeys = new Set([
      "index", "tag", "kind", "role", "name", "normalized_name", "id",
      "href", "href_path", "visible", "enabled", "typeable", "clickable", "box",
      "context",
    ]);
    for (const c of out) {
      for (const key of Object.keys(c)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    }
    const serialized = JSON.stringify(out);
    for (const banned of FORBIDDEN) {
      expect(serialized).not.toContain(banned);
    }
  });
});

// ─── 13 & 14. Empty / malformed input ──────────────────────────────────────────

describe("extraction — empty and malformed input", () => {
  it("returns [] for an empty page", () => {
    expect(extractCandidates([])).toEqual([]);
  });

  it("handles empty/missing text safely (name = empty string)", () => {
    const el = makeEl({ tag: "button" });
    const [c] = extractCandidates([el]);
    expect(c.name).toBe("");
    expect(c.normalized_name).toBe("");
  });

  it("handles a malformed href → href_path null without throwing", () => {
    expect(hrefPath("http://[::bad-url")).toBeNull();
    expect(hrefPath("#section")).toBeNull();
    expect(hrefPath("javascript:void(0)")).toBeNull();
    expect(hrefPath(null)).toBeNull();
    const el = makeEl({ tag: "a", attrs: { href: "#" }, textContent: "Anchor" });
    const [c] = extractCandidates([el]);
    expect(c.href_path).toBeNull();
  });
});

// ─── 15. viewportOnly filtering ─────────────────────────────────────────────────

describe("extraction — viewportOnly", () => {
  it("excludes offscreen elements when viewportOnly is true", () => {
    const onscreen = makeEl({ tag: "button", textContent: "OnScreen", box: { left: 100, top: 100, width: 80, height: 30 } });
    const offscreen = makeEl({ tag: "button", textContent: "OffScreen", box: { left: 5000, top: 5000, width: 80, height: 30 } });
    const out = extractCandidates([onscreen, offscreen], { viewportOnly: true, innerWidth: 1280, innerHeight: 800 });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("OnScreen");
  });

  it("includes offscreen elements when viewportOnly is false", () => {
    const offscreen = makeEl({ tag: "button", textContent: "OffScreen", box: { left: 5000, top: 5000, width: 80, height: 30 } });
    const out = extractCandidates([offscreen], { viewportOnly: false });
    expect(out).toHaveLength(1);
  });
});

// ─── 16. Disambiguation context (Phase 5A) ───────────────────────────────────

describe("extraction — disambiguation context", () => {
  // Upsell: "Complete with" heading + a sibling product link, with the generic
  // "Add to bag" button as a peer inside the same card. The button must pick up
  // the SOLHETTA / LED bulb peer text — not collapse to only "Complete with".
  it("harvests peer/sibling product text for an upsell Add to bag button", () => {
    const heading = tnode({ tag: "h2", text: "Complete with" });
    const link = tnode({ tag: "a", attrs: { href: "/p/solhetta-led-bulb" }, text: "SOLHETTA" });
    const desc = tnode({ tag: "strong", text: "LED bulb E26 450 lumen" });
    const btn = tnode({ tag: "button", text: "Add to bag" });
    const card = tnode({ tag: "div", attrs: { "data-testid": "product-compact" }, children: [link, desc, btn] });
    const section = tnode({ tag: "section", children: [heading, card] });
    const root = tnode({ tag: "main", children: [section] });
    const [c] = extractTree([btn], root);
    expect(c.name).toBe("Add to bag");
    expect(c.context?.section).toBe("Complete with");
    expect(c.context?.label).toContain("SOLHETTA");
    expect(c.context?.label).toContain("LED bulb E26 450 lumen");
    expect(c.context?.label).not.toBe("Complete with");
  });

  it("picks up image alt text as peer context when there is no sibling link text", () => {
    const img = tnode({ tag: "img", attrs: { alt: "SOLHETTA LED bulb E26 450 lumen" } });
    const btn = tnode({ tag: "button", text: "Add to bag" });
    const card = tnode({ tag: "article", children: [img, btn] });
    const root = tnode({ tag: "main", children: [card] });
    const [c] = extractTree([btn], root);
    expect(c.context?.label).toContain("SOLHETTA");
  });

  // Main product: distant purchase-panel "Add to bag" with no local card label
  // falls back to the page H1 + subtitle + nearby price.
  it("falls back to the page product header for a distant main Add to bag button", () => {
    const h1 = tnode({ tag: "h1", text: "TERTIAL" });
    const subtitle = tnode({ tag: "p", text: "Work lamp, dark gray" });
    const header = tnode({ tag: "header", children: [h1, subtitle] });
    const price = tnode({ tag: "span", text: "$19.99" });
    const btn = tnode({ tag: "button", text: "Add to bag" });
    // A purchase panel with no product title of its own, on a broad page.
    const panel = tnode({ tag: "section", children: [price, btn] });
    const root = tnode({ tag: "body", children: [fillerLinks(16), header, panel] });
    const [c] = extractTree([btn], root);
    expect(c.context?.label).toContain("TERTIAL");
    expect(c.context?.label).toContain("Work lamp");
    expect(c.context?.label).toContain("$19.99");
  });

  // The exact QA failure shape: two "Add to bag" buttons in one snapshot must
  // each get a distinct, positive context (not one populated and one blank).
  it("gives two Add to bag buttons distinct positive contexts (SOLHETTA vs TERTIAL)", () => {
    const h1 = tnode({ tag: "h1", text: "TERTIAL Work lamp, dark gray" });
    const mainPrice = tnode({ tag: "span", text: "$19.99" });
    const mainBtn = tnode({ tag: "button", text: "Add to bag" });
    const mainPanel = tnode({ tag: "section", children: [mainPrice, mainBtn] });

    const upHeading = tnode({ tag: "h2", text: "Complete with" });
    const upLink = tnode({ tag: "a", attrs: { href: "/p/solhetta" }, text: "SOLHETTA LED bulb E26 450 lumen" });
    const upBtn = tnode({ tag: "button", text: "Add to bag" });
    const upCard = tnode({ tag: "article", children: [upLink, upBtn] });
    const upSection = tnode({ tag: "section", children: [upHeading, upCard] });

    const root = tnode({
      tag: "body",
      children: [fillerLinks(16), tnode({ tag: "header", children: [h1] }), mainPanel, upSection],
    });
    const [mainC, upC] = extractTree([mainBtn, upBtn], root);
    expect(mainC.name).toBe(upC.name); // indistinguishable by name alone
    // Both populated…
    expect((mainC.context?.label ?? "").length).toBeGreaterThan(0);
    expect((upC.context?.label ?? "").length).toBeGreaterThan(0);
    // …and distinct.
    expect(mainC.context?.label).not.toBe(upC.context?.label);
    expect(mainC.context?.label).toMatch(/TERTIAL|Work lamp/);
    expect(upC.context?.label).toMatch(/SOLHETTA|LED bulb/);
  });

  it("uses an ancestor aria-label as section for a cookie banner control (no product fallback)", () => {
    const btn = tnode({ tag: "button", text: "Ok" });
    const banner = tnode({ tag: "div", attrs: { "aria-label": "Cookie consent banner" }, children: [btn] });
    const h1 = tnode({ tag: "h1", text: "TERTIAL Work lamp" });
    // Broad page so the harvest walk stops before reaching the product header.
    const root = tnode({ tag: "body", children: [fillerLinks(16), tnode({ tag: "header", children: [h1] }), banner] });
    const [c] = extractTree([btn], root);
    expect(c.context?.section).toBe("Cookie consent banner");
    // A control with a section must NOT inherit the page product header.
    expect(c.context?.label ?? "").not.toContain("TERTIAL");
  });

  it("omits context entirely when there is no useful surrounding text", () => {
    const btn = tnode({ tag: "button", text: "Add to bag" });
    const wrap = tnode({ tag: "div", children: [btn] });
    const root = tnode({ tag: "div", children: [wrap] }); // no h1, no peers, no price
    const [c] = extractTree([btn], root);
    expect(c.context).toBeUndefined();
  });

  it("bounds/truncates harvested context to the documented maxima", () => {
    const link = tnode({ tag: "a", attrs: { href: "/p/x" }, text: "Z".repeat(600) });
    const btn = tnode({ tag: "button", text: "Add" });
    const card = tnode({ tag: "article", children: [link, btn] });
    const root = tnode({ tag: "main", children: [card] });
    const [c] = extractTree([btn], root);
    expect((c.context?.label ?? "").length).toBeLessThanOrEqual(120);
    expect((c.context?.nearby_text ?? "").length).toBeLessThanOrEqual(160);
  });

  it("never reads an input value into context (derives from visible text only)", () => {
    const heading = tnode({ tag: "h2", text: "Sign in" });
    const pwd = tnode({ tag: "input", type: "password", value: "hunter2-SECRET", attrs: { "aria-label": "Password" } });
    const card = tnode({ tag: "article", children: [heading, pwd] });
    const root = tnode({ tag: "main", children: [card] });
    const [c] = extractTree([pwd], root);
    expect(JSON.stringify(c.context ?? {})).not.toContain("hunter2-SECRET");
  });

  // The reported QA failure: the main "Add to bag" sits below the fold inside a
  // purchase wrapper whose only grouping signal is a neutral aria-label. That
  // shallow wrapper must NOT block the page-product-header fallback, so the
  // button still inherits the product title + price and stays distinct.
  it("adopts the page product header for a main Add to bag in a neutral wrapper", () => {
    const h1 = tnode({ tag: "h1", text: "TERTIAL Work lamp, dark gray" });
    const price = tnode({ tag: "span", text: "$19.99" });
    const btn = tnode({ tag: "button", text: "Add to bag", box: { left: 10, top: 4000, width: 120, height: 32 } });
    const wrap = tnode({ tag: "div", attrs: { "aria-label": "Purchase options" }, children: [price, btn] });
    const root = tnode({ tag: "body", children: [fillerLinks(16), tnode({ tag: "header", children: [h1] }), wrap] });
    const [c] = extractTree([btn], root);
    expect(c.context?.label).toContain("TERTIAL");
    expect(c.context?.label).toContain("$19.99");
  });

  // Weak, non-product local text (a status <strong>, no price, not a link/heading)
  // is treated as weak for a purchase-commit control and replaced by the header.
  it("overrides weak non-product local text with the page header for an Add to cart", () => {
    const h1 = tnode({ tag: "h1", text: "TERTIAL Work lamp" });
    const status = tnode({ tag: "strong", text: "In stock" });
    const btn = tnode({ tag: "button", text: "Add to cart" });
    const wrap = tnode({ tag: "div", children: [status, btn] });
    const root = tnode({ tag: "body", children: [fillerLinks(16), tnode({ tag: "header", children: [h1] }), wrap] });
    const [c] = extractTree([btn], root);
    expect(c.context?.label).toContain("TERTIAL");
    expect(c.context?.label ?? "").not.toContain("In stock");
  });

  // Strong card-local identity (a product link) is never overridden — protects
  // self-contained product cards / listing-grid pages from the page header.
  it("never overrides a strong card-local product link with the page header", () => {
    const h1 = tnode({ tag: "h1", text: "Living room furniture" });
    const link = tnode({ tag: "a", attrs: { href: "/p/foobar" }, text: "FOOBAR chair" });
    const btn = tnode({ tag: "button", text: "Add to cart" });
    const card = tnode({ tag: "article", children: [link, btn] });
    const root = tnode({ tag: "body", children: [fillerLinks(16), tnode({ tag: "header", children: [h1] }), card] });
    const [c] = extractTree([btn], root);
    expect(c.context?.label).toContain("FOOBAR chair");
    expect(c.context?.label ?? "").not.toContain("Living room");
  });

  // A clearly unrelated structural region (footer/nav landmark) blocks the
  // main-product fallback even for an add-to-cart-named control.
  it("blocks the product fallback for an Add to bag inside a footer landmark", () => {
    const h1 = tnode({ tag: "h1", text: "TERTIAL Work lamp" });
    const btn = tnode({ tag: "button", text: "Add to bag" });
    const footer = tnode({ tag: "footer", children: [btn] });
    const root = tnode({ tag: "body", children: [fillerLinks(16), tnode({ tag: "header", children: [h1] }), footer] });
    const [c] = extractTree([btn], root);
    expect(c.context?.label ?? "").not.toContain("TERTIAL");
  });

  // The relaxed neutral-wrapper path is scoped to add-to-cart/bag/basket: a
  // non-purchase control in a neutral wrapper does not adopt the page header.
  it("does not adopt the page header for a non-purchase control in a neutral wrapper", () => {
    const h1 = tnode({ tag: "h1", text: "TERTIAL Work lamp" });
    const btn = tnode({ tag: "button", text: "Ok" });
    const wrap = tnode({ tag: "div", attrs: { "aria-label": "Notice" }, children: [btn] });
    const root = tnode({ tag: "body", children: [fillerLinks(16), tnode({ tag: "header", children: [h1] }), wrap] });
    const [c] = extractTree([btn], root);
    expect(c.context?.label ?? "").not.toContain("TERTIAL");
  });

  it("does not hard-code site- or brand-specific strings in the extraction source", () => {
    const expr = buildAntigenExtractionExpr({ maxCandidates: 200, viewportOnly: false }).toLowerCase();
    expect(expr).not.toContain("ikea");
    expect(expr).not.toContain("solhetta");
    expect(expr).not.toContain("tertial");
    expect(expr).not.toContain("add to bag");
  });
});

describe("sanitizeContext", () => {
  it("trims, collapses whitespace, and keeps populated fields", () => {
    expect(sanitizeContext({ label: "  Foo   Bar  ", section: "  Sec " }, "x")).toEqual({
      label: "Foo Bar",
      section: "Sec",
    });
  });

  it("re-clamps fields beyond the documented maxima", () => {
    const out = sanitizeContext(
      { label: "L".repeat(300), section: "S".repeat(300), nearby_text: "N".repeat(300) },
      "x",
    );
    expect(out?.label?.length).toBe(120);
    expect(out?.section?.length).toBe(80);
    expect(out?.nearby_text?.length).toBe(160);
  });

  it("drops fields that merely echo the element name", () => {
    expect(sanitizeContext({ label: "Add to bag" }, "Add to bag")).toBeUndefined();
  });

  it("returns undefined for null/empty input", () => {
    expect(sanitizeContext(null, "x")).toBeUndefined();
    expect(sanitizeContext(undefined, "x")).toBeUndefined();
    expect(sanitizeContext({}, "x")).toBeUndefined();
    expect(sanitizeContext({ label: "   " }, "x")).toBeUndefined();
  });
});

// ─── Pure helper unit tests ─────────────────────────────────────────────────────

describe("pure helpers", () => {
  const base: RawAntigenCandidate = {
    tag: "button",
    type: null,
    role: null,
    content_editable: false,
    id: null,
    href: null,
    disabled: false,
    aria_disabled: false,
    read_only: false,
    name: "",
    box: { x: 0, y: 0, width: 10, height: 10 },
  };

  it("inferKind maps roles and tags", () => {
    expect(inferKind({ ...base, tag: "a", href: "/x" })).toBe("link");
    expect(inferKind({ ...base, tag: "div", role: "button" })).toBe("button");
    expect(inferKind({ ...base, tag: "div", role: "checkbox" })).toBe("control");
    expect(inferKind({ ...base, tag: "select" })).toBe("select");
    expect(inferKind({ ...base, tag: "input", type: "radio" })).toBe("control");
    expect(inferKind({ ...base, tag: "summary" })).toBe("summary");
    expect(inferKind({ ...base, tag: "div" })).toBe("unknown");
  });

  it("inferRole prefers explicit role attribute, else infers", () => {
    expect(inferRole({ ...base, role: "menuitem" })).toBe("menuitem");
    expect(inferRole({ ...base, tag: "input", type: "search" })).toBe("searchbox");
    expect(inferRole({ ...base, tag: "select" })).toBe("combobox");
  });

  it("computeEnabled reflects disabled and aria-disabled", () => {
    expect(computeEnabled(base)).toBe(true);
    expect(computeEnabled({ ...base, disabled: true })).toBe(false);
    expect(computeEnabled({ ...base, aria_disabled: true })).toBe(false);
  });

  it("inferTypeable / inferClickable are mutually sensible", () => {
    const search = { ...base, tag: "input", type: "search" };
    expect(inferTypeable(search)).toBe(true);
    expect(inferClickable(search)).toBe(false);

    const link = { ...base, tag: "a", href: "/x" };
    expect(inferTypeable(link)).toBe(false);
    expect(inferClickable(link)).toBe(true);
  });

  it("hrefPath returns pathname only, dropping origin and query", () => {
    expect(hrefPath("https://x.com/a/b?c=1#d")).toBe("/a/b");
    expect(hrefPath("/relative/path?q=2")).toBe("/relative/path");
  });

  it("mapRawToCandidate assembles a full candidate", () => {
    const c = mapRawToCandidate({ ...base, tag: "a", href: "https://x.com/p", name: "Go Home" }, 3);
    expect(c.index).toBe(3);
    expect(c.kind).toBe("link");
    expect(c.normalized_name).toBe("go home");
    expect(c.href_path).toBe("/p");
    expect(c.visible).toBe(true);
  });
});

// ─── Smoke-level CDP transport test ─────────────────────────────────────────────

describe("extractAntigenSnapshotCandidatesViaCDP — transport smoke", () => {
  const DEFAULT_VERSION = { webSocketDebuggerUrl: "ws://localhost:9222/browser" };
  const DEFAULT_TARGETS = [{ id: "target1", url: "https://example.com", type: "page" }];

  function stubFetch(version: unknown, list: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const data = String(url).endsWith("/json/version") ? version : list;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches, evaluates, and assembles candidates from the page result", async () => {
    vi.useFakeTimers();
    stubFetch(DEFAULT_VERSION, DEFAULT_TARGETS);

    const raw: RawAntigenCandidate[] = [
      {
        tag: "a",
        type: null,
        role: null,
        content_editable: false,
        id: "home-link",
        href: "https://example.com/home?ref=1",
        disabled: false,
        aria_disabled: false,
        read_only: false,
        name: "Home",
        box: { x: 10, y: 20, width: 50, height: 18 },
      },
      {
        tag: "input",
        type: "search",
        role: null,
        content_editable: false,
        id: null,
        href: null,
        disabled: false,
        aria_disabled: false,
        read_only: false,
        name: "Search",
        box: { x: 0, y: 0, width: 200, height: 30 },
      },
    ];
    mockState.nextEvalResponse = raw;

    const resultPromise = extractAntigenSnapshotCandidatesViaCDP({ cdpUrl: "http://localhost:9222" });
    await vi.runAllTimersAsync();
    const candidates = await resultPromise;

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ index: 0, kind: "link", name: "Home", href_path: "/home" });
    expect(candidates[1]).toMatchObject({ index: 1, kind: "input", typeable: true });

    // A Runtime.evaluate carrying the extraction IIFE was sent.
    const evals = mockState.allSentMessages
      .map((m) => JSON.parse(m) as { method: string; params?: { expression?: string } })
      .filter((m) => m.method === "Runtime.evaluate");
    expect(evals).toHaveLength(1);
    expect(evals[0].params?.expression).toContain("getBoundingClientRect");

    // No forbidden internals leak into the assembled candidates.
    const serialized = JSON.stringify(candidates);
    for (const banned of ["cdp_url", "user_data_dir", "secret_ref", "password"]) {
      expect(serialized).not.toContain(banned);
    }
  });

  it("returns [] when the page result is not an array (empty page)", async () => {
    vi.useFakeTimers();
    stubFetch(DEFAULT_VERSION, DEFAULT_TARGETS);
    mockState.nextEvalResponse = null;

    const resultPromise = extractAntigenSnapshotCandidatesViaCDP({ cdpUrl: "http://localhost:9222" });
    await vi.runAllTimersAsync();
    expect(await resultPromise).toEqual([]);
  });

  it("throws CDP_FETCH_FAILED when the CDP endpoint is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(extractAntigenSnapshotCandidatesViaCDP({ cdpUrl: "http://localhost:9999" })).rejects.toMatchObject({
      code: "CDP_FETCH_FAILED",
    });
  });
});
