/**
 * Human Presence Relay v1 — pure page-map / surface builder tests
 * (ANTIGEN_HUMAN_VERIFICATION, default-off).
 *
 * Proves the snapshot-derivation layer:
 *  - a human-verification overlay group becomes a `human_verification` warning
 *    kind FIRST (never collapses into modal/login_prompt),
 *  - the active surface carries surface_kind/challenge_type/
 *    user_presence_required, every action requires a handoff, the challenge
 *    controls are never recommended, and recommended_next_step =
 *    "human_presence_relay_required",
 *  - a structurally-identical promo dialog (no HV classification) keeps the
 *    existing behavior,
 *  - the agent-facing element view exposes the classification but NEVER the
 *    internal hv_control targeting marker,
 *  - flag off is byte-identical (classification ignored everywhere).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

import type { AntigenOverlayInfo } from "../runtime/antigenSnapshotRuntime.js";
import type { AntigenSnapshotElementRecord } from "../runtime/antigenSnapshotStore.js";
import { toExternalAntigenSnapshotElement } from "../runtime/antigenSnapshotStore.js";
import { buildActiveSurfaces, buildAntigenPageMap } from "../runtime/antigenSnapshotPageMap.js";
import { isHumanVerificationEnabled } from "../runtime/humanVerificationState.js";

const HV_OVERLAY: AntigenOverlayInfo = {
  overlay_type: "dialog",
  blocking: true,
  modal_title: "Before we continue",
  human_verification: true,
  hv_challenge_type: "press_and_hold",
};

const PROMO_OVERLAY: AntigenOverlayInfo = {
  overlay_type: "dialog",
  blocking: true,
  modal_title: "We Missed You!",
};

let refCounter = 0;
function record(overrides: Partial<AntigenSnapshotElementRecord> = {}): AntigenSnapshotElementRecord {
  refCounter += 1;
  return {
    snapshot_id: "snap_test",
    ref: `ag_${refCounter}`,
    browser_session_id: "tbsess_hv_001",
    browser_runtime_id: "tbsess_hv_001",
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
    box: { x: 100, y: 100, width: 120, height: 40 },
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 90_000).toISOString(),
    ...overrides,
  };
}

function hvRecords() {
  refCounter = 0;
  const bgSearch = record({
    tag: "input",
    kind: "input",
    role: "searchbox",
    name: "Search products",
    normalized_name: "search products",
    typeable: true,
    clickable: false,
  }); // ag_1 — background
  const holdButton = record({
    name: "Press & Hold",
    normalized_name: "press & hold",
    overlay: { ...HV_OVERLAY, hv_control: true },
  }); // ag_2 — the challenge control
  return { bgSearch, holdButton };
}

function promoRecords() {
  refCounter = 0;
  const bgSearch = record({
    tag: "input",
    kind: "input",
    role: "searchbox",
    name: "Search",
    normalized_name: "search",
    typeable: true,
    clickable: false,
  });
  const dismiss = record({
    name: "No thanks",
    normalized_name: "no thanks",
    overlay: { ...PROMO_OVERLAY, is_dismiss: true },
  });
  return { bgSearch, dismiss };
}

beforeEach(() => {
  process.env.ANTIGEN_HUMAN_VERIFICATION = "true";
});

afterEach(() => {
  delete process.env.ANTIGEN_HUMAN_VERIFICATION;
});

describe("isHumanVerificationEnabled — strict opt-in", () => {
  it("is off by default and for any non-'true' value", () => {
    delete process.env.ANTIGEN_HUMAN_VERIFICATION;
    expect(isHumanVerificationEnabled()).toBe(false);
    process.env.ANTIGEN_HUMAN_VERIFICATION = "1";
    expect(isHumanVerificationEnabled()).toBe(false);
  });
  it("is on only for the literal 'true'", () => {
    process.env.ANTIGEN_HUMAN_VERIFICATION = "true";
    expect(isHumanVerificationEnabled()).toBe(true);
  });
});

describe("buildActiveSurfaces — human-verification surface", () => {
  it("classifies the surface and forces relay-only semantics", () => {
    const r = hvRecords();
    const out = buildActiveSurfaces(Object.values(r));

    expect(out.blocking_active).toBe(true);
    const surface = out.surfaces[0];
    expect(surface.surface_kind).toBe("human_verification");
    expect(surface.challenge_type).toBe("press_and_hold");
    expect(surface.user_presence_required).toBe(true);
    // Every action on the challenge surface requires a handoff…
    for (const action of surface.actions) {
      expect(action.requires_handoff).toBe(true);
    }
    // …so the challenge controls are NEVER recommended as low-risk actions,
    // and the page-level next step is the relay.
    expect(out.recommended_actions).toEqual([]);
    expect(out.recommended_next_step).toBe("human_presence_relay_required");
    // Background refs are annotated blocked while the challenge is up.
    expect(out.likely_blocked_refs).toContain(r.bgSearch.ref);
  });

  it("leaves a structurally-identical promo dialog unchanged (no HV semantics)", () => {
    const r = promoRecords();
    const out = buildActiveSurfaces(Object.values(r));

    const surface = out.surfaces[0];
    expect(surface.surface_kind).toBeUndefined();
    expect(surface.challenge_type).toBeUndefined();
    expect(surface.user_presence_required).toBeUndefined();
    expect(out.recommended_next_step).toBeUndefined();
    // Normal modal behavior intact: the dismiss action is still recommended.
    expect(out.recommended_actions.some((a) => a.ref === r.dismiss.ref)).toBe(true);
  });

  it("flag off: human-verification classification is ignored entirely", () => {
    process.env.ANTIGEN_HUMAN_VERIFICATION = "false";
    const r = hvRecords();
    const out = buildActiveSurfaces(Object.values(r));
    const surface = out.surfaces[0];
    expect(surface.surface_kind).toBeUndefined();
    expect(out.recommended_next_step).toBeUndefined();
  });
});

describe("page map warnings — human_verification kind wins first", () => {
  it("an HV overlay group is a human_verification warning, never modal/login_prompt", () => {
    const r = hvRecords();
    const pageMap = buildAntigenPageMap({ records: Object.values(r), viewportOnly: false, url: "https://www.bathandbodyworks.com/" });
    const hvWarning = pageMap.warnings_or_modals.find((w) => w.kind === "human_verification");
    expect(hvWarning).toBeDefined();
    expect(hvWarning!.blocking).toBe(true);
  });

  it("the promo dialog stays a plain modal warning", () => {
    const r = promoRecords();
    const pageMap = buildAntigenPageMap({ records: Object.values(r), viewportOnly: false, url: "https://www.bathandbodyworks.com/" });
    expect(pageMap.warnings_or_modals.some((w) => w.kind === "human_verification")).toBe(false);
  });
});

describe("external element view — classification visible, hv_control never", () => {
  it("exposes human_verification + hv_challenge_type and strips hv_control", () => {
    const { holdButton } = hvRecords();
    const ext = toExternalAntigenSnapshotElement(holdButton);
    expect(ext.overlay?.human_verification).toBe(true);
    expect(ext.overlay?.hv_challenge_type).toBe("press_and_hold");
    expect(JSON.stringify(ext)).not.toContain("hv_control");
    expect(JSON.stringify(ext)).not.toContain('"box"');
  });

  it("flag off: no human-verification fields appear at all", () => {
    process.env.ANTIGEN_HUMAN_VERIFICATION = "false";
    const { holdButton } = hvRecords();
    const ext = toExternalAntigenSnapshotElement(holdButton);
    expect(JSON.stringify(ext)).not.toContain("human_verification");
    expect(JSON.stringify(ext)).not.toContain("hv_");
  });
});
