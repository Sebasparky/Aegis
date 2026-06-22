/**
 * Human Presence Relay v1 — request lifecycle + endpoint tests.
 *
 * Harness mirrors antigen-active-surfaces.test.ts / challenge-lifecycle.test.ts:
 * persistence is a no-op mock, store Maps and the snapshot store are REAL, the
 * CDP transports (snapshot extraction + the relay's hold/probe executors) are
 * mocked. ANTIGEN_HUMAN_VERIFICATION is on for the suite (off for the flag-off
 * test).
 *
 * Covers: snapshot auto-create + dedupe, the HUMAN_VERIFICATION_REQUIRED
 * pre-action guard on click/type/set-value/scroll (with a no-secrets assertion
 * on every payload), the hold lifecycle (start/heartbeat/end), completion side
 * effects (UAR + grant, snapshot invalidation → fresh-snapshot requirement,
 * agent resume), retry-on-still-present, lazy TTL expiry, cancel, checkbox
 * confirm, manual recheck, challenge-vanished resolution, the agent poll
 * endpoint, and the human_presence receipts timeline.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock the CDP extraction transports — the snapshot store stays real.
const extractMock = vi.hoisted(() => vi.fn());
const pageMetaMock = vi.hoisted(() => vi.fn());
const bundleMock = vi.hoisted(() => vi.fn());
const pageWallMock = vi.hoisted(() => vi.fn());
// Cheap in-bundle page-level HV hint. Resolves `undefined` by default (flag off /
// no hint); page-level tests opt in via hvHintMock.mockResolvedValue(true).
const hvHintMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/antigenSnapshotRuntime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/antigenSnapshotRuntime.js")>(
    "../runtime/antigenSnapshotRuntime.js",
  );
  bundleMock.mockImplementation(async (params: Record<string, unknown>) => {
    const candidates = await extractMock(params);
    let pageMeta: unknown;
    try {
      pageMeta = await pageMetaMock(params);
    } catch {
      pageMeta = undefined;
    }
    let hvWallHint: unknown;
    try {
      hvWallHint = await hvHintMock(params);
    } catch {
      hvWallHint = undefined;
    }
    return {
      candidates,
      ...(pageMeta !== undefined ? { pageMeta } : {}),
      ...(hvWallHint !== undefined ? { hvWallHint } : {}),
    };
  });
  return {
    ...actual,
    extractAntigenSnapshotCandidatesViaCDP: extractMock,
    extractAntigenPageMetaViaCDP: pageMetaMock,
    extractAntigenSnapshotBundleViaCDP: bundleMock,
    detectPageHumanVerificationWallViaCDP: pageWallMock,
  };
});

const liveUrlMock = vi.hoisted(() => vi.fn());
const resolveTargetMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/cdpTargetSelection.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/cdpTargetSelection.js")>(
    "../runtime/cdpTargetSelection.js",
  );
  return { ...actual, readLiveCdpPageUrl: liveUrlMock, resolveSnapshotCdpTarget: resolveTargetMock };
});

// Mock ONLY the relay's CDP executors — the hold session state machine has its
// own unit suite (human-presence-relay.test.ts); here the routes are under test.
const startHoldMock = vi.hoisted(() => vi.fn());
const heartbeatMock = vi.hoisted(() => vi.fn());
const endHoldMock = vi.hoisted(() => vi.fn());
const probeMock = vi.hoisted(() => vi.fn());
const confirmClickMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/humanPresenceRelay.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/humanPresenceRelay.js")>(
    "../runtime/humanPresenceRelay.js",
  );
  return {
    ...actual,
    startHoldSession: startHoldMock,
    heartbeatHoldSession: heartbeatMock,
    endHoldSession: endHoldMock,
    probeHumanVerification: probeMock,
    confirmPresenceClick: confirmClickMock,
  };
});

// Mock the realistic click runtime so post-guard clicks don't touch CDP.
const clickKnownBoxMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/realisticBrowserActions.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/realisticBrowserActions.js")>(
    "../runtime/realisticBrowserActions.js",
  );
  return { ...actual, realisticClickKnownBox: clickKnownBoxMock };
});

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TaskBrowserSession, HumanVerificationRequest } from "@aegis/types";
import type { AntigenSnapshotCandidate, AntigenOverlayInfo } from "../runtime/antigenSnapshotRuntime.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";
import { clearAntigenSnapshotStoreForTests } from "../runtime/antigenSnapshotStore.js";
import { clearAllActiveHumanVerificationForTests } from "../runtime/humanVerificationState.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { humanVerificationRoutes } from "../routes/human-verification.js";
import { sensitiveReceiptsRouter } from "../routes/sensitive-receipts.js";
import {
  agentDelegations,
  passes,
  humanVerificationRequests,
  userApprovalReceipts,
  sensitiveGrants,
} from "../store/index.js";

const BEARER = "Bearer tok_hv_001";
const DELEGATION_ID = "del_hv_001";
const MOCK_USER_ID = "user_001";
const SESSION_ID = "tbsess_hv_001";
const PAGE_URL = "https://www.bathandbodyworks.com/";
const DOMAIN = "www.bathandbodyworks.com";

const SNAPSHOT_URL = "/api/agent/v1/runtime/browser-snapshot";
const CLICK_URL = "/api/agent/v1/runtime/browser-click";

const HV_OVERLAY: AntigenOverlayInfo = {
  overlay_type: "dialog",
  blocking: true,
  modal_title: "Before we continue",
  human_verification: true,
  hv_challenge_type: "press_and_hold",
};

function candidate(overrides: Partial<AntigenSnapshotCandidate> = {}): AntigenSnapshotCandidate {
  return {
    index: 0,
    tag: "button",
    kind: "button",
    role: "button",
    name: "Ok",
    normalized_name: "ok",
    id: null,
    href: null,
    href_path: null,
    visible: true,
    enabled: true,
    typeable: false,
    clickable: true,
    box: { x: 100, y: 200, width: 80, height: 40 },
    ...overrides,
  };
}

/** Page candidates WITH the blocking press-and-hold challenge. */
function challengeCandidates(): AntigenSnapshotCandidate[] {
  return [
    candidate({
      index: 0,
      tag: "input",
      kind: "input",
      role: "searchbox",
      name: "Search products",
      normalized_name: "search products",
      typeable: true,
      clickable: false,
      box: { x: 10, y: 10, width: 200, height: 32 },
    }),
    candidate({
      index: 1,
      name: "Press & Hold",
      normalized_name: "press & hold",
      box: { x: 280, y: 300, width: 140, height: 44 },
      overlay: { ...HV_OVERLAY, hv_control: true },
    }),
  ];
}

/** Plain page candidates — no challenge. */
function normalCandidates(): AntigenSnapshotCandidate[] {
  return [
    candidate({
      index: 0,
      tag: "input",
      kind: "input",
      role: "searchbox",
      name: "Search products",
      normalized_name: "search products",
      typeable: true,
      clickable: false,
      box: { x: 10, y: 10, width: 200, height: 32 },
    }),
    candidate({ index: 1, name: "Add to bag", normalized_name: "add to bag" }),
  ];
}

function seedSession(): TaskBrowserSession {
  const session: TaskBrowserSession = {
    browser_session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    delegation_id: DELEGATION_ID,
    status: "ready",
    cdp_url: "http://localhost:9222",
    cdp_port: 9222,
    user_data_dir: "/tmp/aegis-agent-browser-hv",
    ephemeral: true,
    mode: "headless",
    debug_visible: false,
    runtime_mode: "local_runtime_endpoint",
    current_url: PAGE_URL,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  } as TaskBrowserSession;
  taskBrowserSessions.set(SESSION_ID, session);
  return session;
}

let server: FastifyInstance;

async function takeSnapshot(candidates: AntigenSnapshotCandidate[]) {
  extractMock.mockResolvedValue(candidates);
  const res = await server.inject({
    method: "POST",
    url: SNAPSHOT_URL,
    headers: { authorization: BEARER },
    payload: { browser_runtime_id: SESSION_ID, action: "dom_snapshot" },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data;
}

function theRequest(): HumanVerificationRequest {
  const all = [...humanVerificationRequests.values()];
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
}

async function clickRef(ref: string) {
  return server.inject({
    method: "POST",
    url: CLICK_URL,
    headers: { authorization: BEARER },
    payload: { browser_runtime_id: SESSION_ID, ref },
  });
}

/** No internal targeting/geometry data may appear in any payload. */
function expectNoSecrets(body: string) {
  expect(body).not.toContain("hv_control");
  expect(body).not.toContain("control_box");
  expect(body).not.toContain("selector");
  expect(body).not.toContain("cdp_url");
  expect(body).not.toContain('"box"');
  expect(body).not.toContain("user_data_dir");
}

beforeAll(async () => {
  process.env.ANTIGEN_HUMAN_VERIFICATION = "true";
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  passes.set("pass_hv_001", {
    id: "pass_hv_001",
    token: "tok_hv_001",
    user_id: MOCK_USER_ID,
    agent_name: "TestHvAgent",
    status: "active",
    expires_at: expiry,
    created_at: new Date().toISOString(),
  } as any);
  agentDelegations.set(DELEGATION_ID, {
    id: DELEGATION_ID,
    user_id: MOCK_USER_ID,
    user_aegis_id: "aegisid_test",
    agent_name: "TestHvAgent",
    channel: "api",
    status: "active",
    token_id: "pass_hv_001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.register(humanVerificationRoutes);
  await server.register(sensitiveReceiptsRouter);
  await server.ready();
});

afterAll(async () => {
  delete process.env.ANTIGEN_HUMAN_VERIFICATION;
  await server.close();
  passes.delete("pass_hv_001");
  agentDelegations.delete(DELEGATION_ID);
});

beforeEach(() => {
  process.env.ANTIGEN_HUMAN_VERIFICATION = "true";
  taskBrowserSessions.clear();
  clearAntigenSnapshotStoreForTests();
  clearAllActiveHumanVerificationForTests();
  humanVerificationRequests.clear();
  userApprovalReceipts.clear();
  sensitiveGrants.clear();
  vi.clearAllMocks();
  seedSession();
  liveUrlMock.mockResolvedValue(PAGE_URL);
  resolveTargetMock.mockResolvedValue(null);
  pageMetaMock.mockResolvedValue(undefined);
  // Default: no page-level wall and no hint — only the page-level tests opt in.
  pageWallMock.mockResolvedValue(null);
  hvHintMock.mockResolvedValue(undefined);
  clickKnownBoxMock.mockResolvedValue({ success: true });
});

describe("page-level wall (cross-origin iframe) → request auto-create", () => {
  const PAGE_WALL = {
    human_verification: true as const,
    hv_challenge_type: "press_and_hold" as const,
    user_presence_required: true as const,
    blocking: true as const,
    page_level: true as const,
  };

  it("creates a page-level HVR + blocking surface when element_count is 0", async () => {
    pageWallMock.mockResolvedValue(PAGE_WALL);
    const data = await takeSnapshot([]); // zero candidates — the B&BW wall shape

    // The page-level probe ran (no per-candidate member, near-empty page).
    expect(pageWallMock).toHaveBeenCalled();
    expect(data.element_count).toBe(0);
    expect(data.page_level_human_verification).toBe(true);
    expect(data.recommended_next_step).toBe("human_presence_relay_required");

    // A blocking human_verification surface is synthesized despite 0 candidates.
    const hvSurface = (data.active_surfaces ?? []).find(
      (s: Record<string, unknown>) => s.surface_kind === "human_verification",
    );
    expect(hvSurface).toBeDefined();
    expect(hvSurface.challenge_type).toBe("press_and_hold");
    expect(hvSurface.user_presence_required).toBe(true);
    expect(hvSurface.blocking).toBe(true);
    expect(hvSurface.page_level).toBe(true);
    expect(hvSurface.actions).toEqual([]);

    // Agent-facing block flags page_level and never authorizes purchase.
    expect(data.human_verification.page_level).toBe(true);
    expect(data.human_verification.purchase_authorized).toBe(false);

    const request = theRequest();
    expect(request.status).toBe("pending_user");
    expect(request.page_level).toBe(true);
    expect(request.challenge_type).toBe("press_and_hold");
  });

  // Plain background candidates with NO HV member — the live overlay-wall shape
  // where the wall blocks a still-present page. More than PAGE_HV_PROBE_MAX_ELEMENTS
  // so the low-element fast path does NOT fire; only the hint can gate the probe.
  function manyBackgroundCandidates(): AntigenSnapshotCandidate[] {
    return Array.from({ length: 8 }, (_, i) =>
      candidate({ index: i, name: `Add to bag ${i}`, normalized_name: `add to bag ${i}` }),
    );
  }

  it("OVERLAY wall over a preserved background: hint gates the probe despite high element_count", async () => {
    pageWallMock.mockResolvedValue(PAGE_WALL);
    hvHintMock.mockResolvedValue(true); // strong HV text + inaccessible iframe
    const data = await takeSnapshot(manyBackgroundCandidates());

    // Background DOM preserved, yet the probe still ran (gated by the hint).
    expect(data.element_count).toBeGreaterThan(3);
    expect(pageWallMock).toHaveBeenCalled();
    expect(data.page_level_human_verification).toBe(true);
    expect(data.recommended_next_step).toBe("human_presence_relay_required");

    const hvSurface = (data.active_surfaces ?? []).find(
      (s: Record<string, unknown>) => s.surface_kind === "human_verification",
    );
    expect(hvSurface).toBeDefined();
    expect(hvSurface.challenge_type).toBe("press_and_hold");
    expect(hvSurface.page_level).toBe(true);
    expect(hvSurface.user_presence_required).toBe(true);

    expect(theRequest().page_level).toBe(true);
  });

  it("background click after overlay-wall detection returns HUMAN_VERIFICATION_REQUIRED, not ANTIGEN_REF_STALE", async () => {
    pageWallMock.mockResolvedValue(PAGE_WALL);
    hvHintMock.mockResolvedValue(true);
    await takeSnapshot(manyBackgroundCandidates());

    const res = await server.inject({
      method: "POST",
      url: "/api/agent/v1/runtime/browser-click",
      headers: { authorization: BEARER },
      payload: { browser_runtime_id: SESSION_ID, ref: "ag_1" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    // The guard short-circuits BEFORE ref resolution — the click executor that
    // would otherwise surface ANTIGEN_REF_STALE is never reached.
    expect(clickKnownBoxMock).not.toHaveBeenCalled();
    expectNoSecrets(res.body);
  });

  it("no hint + high element_count: the probe is NOT run (clean pages pay nothing)", async () => {
    pageWallMock.mockResolvedValue(PAGE_WALL);
    hvHintMock.mockResolvedValue(false);
    const data = await takeSnapshot(manyBackgroundCandidates());
    expect(pageWallMock).not.toHaveBeenCalled();
    expect(data.page_level_human_verification).toBeUndefined();
    expect(data.human_verification).toBeUndefined();
  });

  it("arms the guard: click/type/set-value/scroll are rejected HUMAN_VERIFICATION_REQUIRED", async () => {
    pageWallMock.mockResolvedValue(PAGE_WALL);
    await takeSnapshot([]);

    for (const url of [
      "/api/agent/v1/runtime/browser-click",
      "/api/agent/v1/runtime/browser-type",
      "/api/agent/v1/runtime/browser-set-value",
      "/api/agent/v1/runtime/browser-scroll-to-ref",
    ]) {
      const res = await server.inject({
        method: "POST",
        url,
        headers: { authorization: BEARER },
        // Supply every field each endpoint's schema needs (text/value/ref) so the
        // 409 comes from the guard, not payload validation.
        payload: { browser_runtime_id: SESSION_ID, ref: "ag_1", text: "x", value: "x" },
      });
      expect(res.statusCode).toBe(409);
      const body = res.body;
      expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
      expectNoSecrets(body);
    }
  });

  it("the hold-start relay refuses a page-level wall (manual completion only)", async () => {
    pageWallMock.mockResolvedValue(PAGE_WALL);
    await takeSnapshot([]);
    const request = theRequest();
    const res = await server.inject({
      method: "POST",
      url: `/api/internal/human-verification-requests/${request.request_id}/hold-start`,
      headers: { authorization: BEARER },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("MANUAL_COMPLETION_REQUIRED");
    // The relay's CDP hold executor is never invoked for a page-level wall.
    expect(startHoldMock).not.toHaveBeenCalled();
  });

  it("flag OFF: the page-level probe never runs and no HV fields appear", async () => {
    process.env.ANTIGEN_HUMAN_VERIFICATION = "false";
    pageWallMock.mockResolvedValue(PAGE_WALL);
    const data = await takeSnapshot([]);
    expect(pageWallMock).not.toHaveBeenCalled();
    expect(data.page_level_human_verification).toBeUndefined();
    expect(data.human_verification).toBeUndefined();
    expect(humanVerificationRequests.size).toBe(0);
  });
});

describe("snapshot detection → request auto-create", () => {
  it("creates a HumanVerificationRequest and surfaces relay guidance in the snapshot", async () => {
    const data = await takeSnapshot(challengeCandidates());

    expect(data.recommended_next_step).toBe("human_presence_relay_required");
    expect(data.human_verification).toBeDefined();
    expect(data.human_verification.challenge_type).toBe("press_and_hold");
    expect(data.human_verification.domain).toBe(DOMAIN);
    expect(data.human_verification.user_presence_required).toBe(true);
    expect(data.human_verification.purchase_authorized).toBe(false);

    const request = theRequest();
    expect(request.status).toBe("pending_user");
    expect(request.delegation_id).toBe(DELEGATION_ID);
    expect(request.browser_session_id).toBe(SESSION_ID);
    expect(data.human_verification.request_id).toBe(request.request_id);

    expectNoSecrets(JSON.stringify(data.human_verification));
  });

  it("dedupes: repeated snapshots reuse the one active request per session+domain", async () => {
    await takeSnapshot(challengeCandidates());
    const first = theRequest().request_id;
    await takeSnapshot(challengeCandidates());
    expect(humanVerificationRequests.size).toBe(1);
    expect(theRequest().request_id).toBe(first);
  });

  it("flag off: no request, no guidance fields, no guard (byte-identical off)", async () => {
    process.env.ANTIGEN_HUMAN_VERIFICATION = "false";
    const data = await takeSnapshot(challengeCandidates());
    expect(data.recommended_next_step).toBeUndefined();
    expect(data.human_verification).toBeUndefined();
    expect(humanVerificationRequests.size).toBe(0);

    const searchRef = data.elements.find((e: { name: string }) => e.name === "Search products").ref;
    const res = await clickRef(searchRef);
    expect(res.json().error?.code).not.toBe("HUMAN_VERIFICATION_REQUIRED");
  });

  it("a challenge that vanishes before any interaction resolves as cancelled, never completed", async () => {
    await takeSnapshot(challengeCandidates());
    const request = theRequest();
    await takeSnapshot(normalCandidates());
    expect(request.status).toBe("cancelled");
    expect(request.error).toBe("challenge_no_longer_present");
    expect(userApprovalReceipts.size).toBe(0);
    expect(sensitiveGrants.size).toBe(0);
  });
});

describe("HUMAN_VERIFICATION_REQUIRED pre-action guard", () => {
  it("blocks click/type/set-value/scroll on background refs with 409 + safe payload", async () => {
    const data = await takeSnapshot(challengeCandidates());
    const request = theRequest();
    const searchRef = data.elements.find((e: { name: string }) => e.name === "Search products").ref;

    const calls: Array<{ url: string; payload: Record<string, unknown> }> = [
      { url: CLICK_URL, payload: { browser_runtime_id: SESSION_ID, ref: searchRef } },
      { url: "/api/agent/v1/runtime/browser-type", payload: { browser_runtime_id: SESSION_ID, ref: searchRef, text: "candles" } },
      { url: "/api/agent/v1/runtime/browser-set-value", payload: { browser_runtime_id: SESSION_ID, ref: searchRef, value: "candles" } },
      { url: "/api/agent/v1/runtime/browser-scroll-to-ref", payload: { browser_runtime_id: SESSION_ID, ref: searchRef } },
    ];
    for (const call of calls) {
      const res = await server.inject({ method: "POST", url: call.url, headers: { authorization: BEARER }, payload: call.payload });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
      expect(body.error.request_id).toBe(request.request_id);
      expect(body.error.purchase_authorized).toBe(false);
      expect(body.error.next_action).toContain("antigen_snapshot");
      // The cached-marker guard reused a prior snapshot's marker — no fresh visual
      // judgment ran. Attribution is always present (no debug flag set here).
      expect(body.error.human_verification_attribution).toMatchObject({
        source: "cached_hv_marker_guard",
        visual_judgment_coverage: "not_covered_reused_existing_state",
        fresh_visual_judgment_event_expected: false,
      });
      expectNoSecrets(res.body);
      // The guard fires BEFORE ref resolution — no pointer dispatch, no
      // stale-ref machinery, no logical recovery behind the challenge.
      expect(clickKnownBoxMock).not.toHaveBeenCalled();
    }
  });

  it("keeps blocking with the terminal status after expiry until a fresh snapshot", async () => {
    const data = await takeSnapshot(challengeCandidates());
    const request = theRequest();
    request.expires_at = new Date(Date.now() - 1000).toISOString();
    const searchRef = data.elements.find((e: { name: string }) => e.name === "Search products").ref;

    const res = await clickRef(searchRef);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(res.json().error.status).toBe("expired");
    expect(request.status).toBe("expired");

    // Fresh snapshot with no challenge clears the guard.
    const fresh = await takeSnapshot(normalCandidates());
    const freshRef = fresh.elements.find((e: { name: string }) => e.name === "Add to bag").ref;
    const ok = await clickRef(freshRef);
    expect(ok.json().error?.code).not.toBe("HUMAN_VERIFICATION_REQUIRED");
  });
});

describe("hold lifecycle", () => {
  it("hold-start → in_progress; heartbeat → holding; hold-end with cleared challenge → completed", async () => {
    await takeSnapshot(challengeCandidates());
    const request = theRequest();
    startHoldMock.mockResolvedValue({ ok: true });
    heartbeatMock.mockReturnValue({ holding: true });
    endHoldMock.mockResolvedValue({ hold_state: "released", held_ms: 920, challenge_present: false });

    const start = await server.inject({ method: "POST", url: `/api/internal/human-verification-requests/${request.request_id}/hold-start`, payload: {} });
    expect(start.statusCode).toBe(200);
    expect(start.json().data.hold_state).toBe("holding");
    expect(request.status).toBe("in_progress");
    expect(request.hold_attempt_count).toBe(1);

    const beat = await server.inject({ method: "POST", url: `/api/internal/human-verification-requests/${request.request_id}/heartbeat`, payload: {} });
    expect(beat.json().data.hold_state).toBe("holding");

    const end = await server.inject({ method: "POST", url: `/api/internal/human-verification-requests/${request.request_id}/hold-end`, payload: {} });
    expect(end.statusCode).toBe(200);
    expect(end.json().data.status).toBe("completed");
    expect(end.json().data.challenge_present).toBe(false);
    expect(request.status).toBe("completed");
    expect(request.completion_mode).toBe("relayed_live_presence");
    expectNoSecrets(end.body);

    // Signed UAR + presence grant (non-blocking — wait for it).
    await vi.waitFor(() => {
      expect(userApprovalReceipts.size).toBe(1);
      expect(sensitiveGrants.size).toBe(1);
    });
    const grant = [...sensitiveGrants.values()][0];
    expect(grant.grant_type).toBe("human_presence_verification");
    expect(grant.scope.human_verification_request_id).toBe(request.request_id);
    const uar = [...userApprovalReceipts.values()][0];
    expect(uar.approval_source).toBe("human_presence_verification");

    // Fresh-snapshot requirement enforced mechanically: prior refs are gone.
    const stale = await clickRef("ag_1");
    expect(stale.statusCode).toBe(422);
    expect(stale.json().error.code).toBe("ANTIGEN_REF_NOT_FOUND");

    // The next snapshot stamps resumed_at (agent resumed).
    await takeSnapshot(normalCandidates());
    expect(request.resumed_at).toBeDefined();
  });

  it("hold-end with the challenge still present stays in_progress and is retryable", async () => {
    await takeSnapshot(challengeCandidates());
    const request = theRequest();
    startHoldMock.mockResolvedValue({ ok: true });
    endHoldMock.mockResolvedValue({ hold_state: "released", held_ms: 250, challenge_present: true });

    await server.inject({ method: "POST", url: `/api/internal/human-verification-requests/${request.request_id}/hold-start`, payload: {} });
    const end = await server.inject({ method: "POST", url: `/api/internal/human-verification-requests/${request.request_id}/hold-end`, payload: {} });
    expect(end.json().data.status).toBe("in_progress");
    expect(end.json().data.challenge_present).toBe(true);
    expect(userApprovalReceipts.size).toBe(0);

    // Retry allowed until TTL.
    const retry = await server.inject({ method: "POST", url: `/api/internal/human-verification-requests/${request.request_id}/hold-start`, payload: {} });
    expect(retry.statusCode).toBe(200);
    expect(request.hold_attempt_count).toBe(2);
  });

  it("hold-start on a vanished challenge resolves cancelled (challenge_gone), never completed", async () => {
    await takeSnapshot(challengeCandidates());
    const request = theRequest();
    startHoldMock.mockResolvedValue({ ok: false, code: "CHALLENGE_NOT_PRESENT", message: "gone" });

    const res = await server.inject({ method: "POST", url: `/api/internal/human-verification-requests/${request.request_id}/hold-start`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.hold_state).toBe("challenge_gone");
    expect(request.status).toBe("cancelled");
    expect(sensitiveGrants.size).toBe(0);
  });

  it("hold-start rejects non-press-and-hold challenge types", async () => {
    await takeSnapshot([
      ...normalCandidates(),
      candidate({
        index: 2,
        tag: "input",
        kind: "control",
        role: "checkbox",
        name: "I'm not a robot",
        normalized_name: "i'm not a robot",
        overlay: { ...HV_OVERLAY, hv_challenge_type: "checkbox_human", hv_control: true },
      }),
    ]);
    const request = theRequest();
    expect(request.challenge_type).toBe("checkbox_human");
    const res = await server.inject({ method: "POST", url: `/api/internal/human-verification-requests/${request.request_id}/hold-start`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("WRONG_CHALLENGE_TYPE");
  });
});

describe("checkbox confirm + manual recheck + cancel", () => {
  async function seedCheckboxRequest() {
    await takeSnapshot([
      ...normalCandidates(),
      candidate({
        index: 2,
        tag: "input",
        kind: "control",
        role: "checkbox",
        name: "I'm not a robot",
        normalized_name: "i'm not a robot",
        overlay: { ...HV_OVERLAY, hv_challenge_type: "checkbox_human", hv_control: true },
      }),
    ]);
    return theRequest();
  }

  it("confirm mirrors one click and completes when the challenge clears", async () => {
    const request = await seedCheckboxRequest();
    confirmClickMock.mockResolvedValue({ ok: true, challenge_present: false });

    const res = await server.inject({ method: "POST", url: `/api/internal/human-verification-requests/${request.request_id}/confirm`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.confirm_state).toBe("cleared");
    expect(request.status).toBe("completed");
    expect(confirmClickMock).toHaveBeenCalledTimes(1);
  });

  it("recheck (manual captcha path) completes as manual_user_completion when the probe shows it cleared", async () => {
    await takeSnapshot([
      ...normalCandidates(),
      candidate({
        index: 2,
        name: "Verify",
        normalized_name: "verify",
        overlay: { ...HV_OVERLAY, hv_challenge_type: "image_captcha" },
      }),
    ]);
    const request = theRequest();
    expect(request.challenge_type).toBe("image_captcha");
    probeMock.mockResolvedValue({ ok: true, probe: { present: false, vw: 1280, vh: 800 } });

    const res = await server.inject({ method: "POST", url: `/api/internal/human-verification-requests/${request.request_id}/recheck`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(request.status).toBe("completed");
    expect(request.completion_mode).toBe("manual_user_completion");
    // No auto-solve: the manual path never dispatched a click or hold.
    expect(confirmClickMock).not.toHaveBeenCalled();
    expect(startHoldMock).not.toHaveBeenCalled();
  });

  it("cancel marks the request cancelled and the agent poll reflects it", async () => {
    const request = await seedCheckboxRequest();
    const res = await server.inject({ method: "POST", url: `/api/internal/human-verification-requests/${request.request_id}/cancel`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(request.status).toBe("cancelled");

    const poll = await server.inject({ method: "GET", url: `/api/agent/v1/human-verification-requests/${request.request_id}`, headers: { authorization: BEARER } });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().data.status).toBe("cancelled");
    expect(poll.json().data.next_action).toContain("antigen_snapshot");
    expectNoSecrets(poll.body);
  });
});

describe("agent poll endpoint", () => {
  it("is delegation-scoped and lazily expires", async () => {
    await takeSnapshot(challengeCandidates());
    const request = theRequest();

    const ok = await server.inject({ method: "GET", url: `/api/agent/v1/human-verification-requests/${request.request_id}`, headers: { authorization: BEARER } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.user_presence_required).toBe(true);
    expect(ok.json().data.purchase_authorized).toBe(false);

    request.expires_at = new Date(Date.now() - 1000).toISOString();
    const expired = await server.inject({ method: "GET", url: `/api/agent/v1/human-verification-requests/${request.request_id}`, headers: { authorization: BEARER } });
    expect(expired.json().data.status).toBe("expired");
  });
});

describe("receipts timeline (event_group=human_presence)", () => {
  it("derives the full event trail with purchase_authorized=false and no internals", async () => {
    await takeSnapshot(challengeCandidates());
    const request = theRequest();
    startHoldMock.mockResolvedValue({ ok: true });
    endHoldMock.mockResolvedValue({ hold_state: "released", held_ms: 900, challenge_present: false });
    await server.inject({ method: "POST", url: `/api/internal/human-verification-requests/${request.request_id}/hold-start`, payload: {} });
    await server.inject({ method: "POST", url: `/api/internal/human-verification-requests/${request.request_id}/hold-end`, payload: {} });
    await takeSnapshot(normalCandidates()); // stamps resumed_at

    const res = await server.inject({ method: "GET", url: "/api/internal/sensitive-receipts/recent?event_group=human_presence&since=24h" });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ event_type: string; metadata: Record<string, unknown> }>;
    const types = items.map((i: { event_type: string }) => i.event_type);
    expect(types).toContain("human_verification_detected");
    expect(types).toContain("human_presence_requested");
    expect(types).toContain("human_presence_started");
    expect(types).toContain("human_presence_completed");
    expect(types).toContain("human_verification_completed");
    expect(types).toContain("agent_resumed_after_human_presence");
    for (const item of items) {
      expect(item.metadata.purchase_authorized).toBe(false);
    }
    expectNoSecrets(res.body);
  });
});
