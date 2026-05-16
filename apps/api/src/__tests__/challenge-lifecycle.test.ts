import { vi } from "vitest";

// Must be hoisted before any route imports to prevent import.meta.url errors
// and suppress disk writes during tests.
vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Keep resolutionCodes Map real; mock only the Gmail search functions.
vi.mock("../runtime/emailChallengeResolver.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../runtime/emailChallengeResolver.js")>();
  return {
    ...orig,
    searchGmailForChallengeCode: vi.fn(),
    isEmailChallengeSupported: vi.fn().mockReturnValue(true),
  };
});

// Keep challengeCodes Map real; mock only the CDP fill function.
vi.mock("../runtime/challengeInjection.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../runtime/challengeInjection.js")>();
  return {
    ...orig,
    executeChallengeInjectionViaCDP: vi.fn(),
  };
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { SecurityChallenge, ChallengeEmailResolution } from "@aegis/types";
import { IDS, seedTestData } from "./helpers.js";
import { securityChallenges, challengeEmailResolutions, MOCK_USER_ID } from "../store/index.js";
import {
  searchGmailForChallengeCode,
  isEmailChallengeSupported,
  resolutionCodes,
} from "../runtime/emailChallengeResolver.js";
import { executeChallengeInjectionViaCDP, challengeCodes } from "../runtime/challengeInjection.js";
import { agentApiRoutes } from "../routes/agent-api.js";
import { securityChallengeRoutes } from "../routes/security-challenges.js";
import { emailChallengeResolverRoutes } from "../routes/email-challenge-resolver.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_DOMAIN = "service.test.local";
const TEST_PAGE_URL = `https://${TEST_DOMAIN}/login/verify`;
const AGENT_TOKEN = `Bearer ${IDS.TOKEN_ALL}`;

const PAST = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 5 * 60 * 1000).toISOString();

// A generic search result — no provider-specific values.
const MOCK_CODE = "847261";
const MOCK_SEARCH_RESULT_SNIPPET = {
  code: MOCK_CODE,
  sender_domain: `mail.${TEST_DOMAIN}`,
  received_at: new Date().toISOString(),
  extraction_source: "subject_snippet" as const,
};
const MOCK_SEARCH_RESULT_BODY = {
  ...MOCK_SEARCH_RESULT_SNIPPET,
  extraction_source: "body_text" as const,
};

// ─── Server ───────────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  seedTestData();
  server = Fastify({ logger: false });
  await server.register(agentApiRoutes);
  await server.register(securityChallengeRoutes);
  await server.register(emailChallengeResolverRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  securityChallenges.clear();
  challengeEmailResolutions.clear();
  resolutionCodes.clear();
  challengeCodes.clear();
  vi.resetAllMocks();
  // Re-apply default: all test domains are treated as supported.
  vi.mocked(isEmailChallengeSupported).mockReturnValue(true);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;
function uid(prefix: string) {
  return `${prefix}_test_${++_seq}`;
}

function injectChallenge(
  overrides: Partial<SecurityChallenge> & { challenge_id: string },
): SecurityChallenge {
  const ch: SecurityChallenge = {
    user_id: MOCK_USER_ID,
    delegation_id: IDS.DELEGATION_ALL,
    domain: TEST_DOMAIN,
    page_url: TEST_PAGE_URL,
    challenge_type: "email_device_verification",
    status: "pending_user",
    instructions: `Enter the verification code for ${TEST_DOMAIN}.`,
    raw_code_revealed_to_agent: false,
    created_at: new Date().toISOString(),
    expires_at: FUTURE,
    ...overrides,
  };
  securityChallenges.set(ch.challenge_id, ch);
  return ch;
}

function injectResolution(
  overrides: Partial<ChallengeEmailResolution> & { resolution_id: string; challenge_id: string },
): ChallengeEmailResolution {
  const now = new Date().toISOString();
  const res: ChallengeEmailResolution = {
    user_id: MOCK_USER_ID,
    delegation_id: IDS.DELEGATION_ALL,
    provider: "gmail",
    domain: TEST_DOMAIN,
    status: "pending_approval",
    raw_code_revealed_to_agent: false,
    email_body_revealed_to_agent: false,
    search_window_started_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  challengeEmailResolutions.set(res.resolution_id, res);
  return res;
}

// Asserts that a raw verification code does not appear in the HTTP response body.
function assertNoCodeLeak(rawBody: string) {
  expect(rawBody).not.toContain(MOCK_CODE);
}

// ─── Group A: User-initiated happy path ──────────────────────────────────────

describe("Email resolution happy path — user-initiated start", () => {
  it("start → code_found, inject → injected; code never appears in any response body", async () => {
    const challenge = injectChallenge({ challenge_id: uid("chlg") });

    // Step 1: User clicks "Find code" — search returns code from subject/snippet.
    vi.mocked(searchGmailForChallengeCode).mockResolvedValueOnce(MOCK_SEARCH_RESULT_SNIPPET);
    vi.mocked(executeChallengeInjectionViaCDP).mockResolvedValueOnce({ success: true });

    const startRes = await server.inject({
      method: "POST",
      url: "/api/internal/challenge-email-resolutions/start",
      headers: { "content-type": "application/json" },
      payload: { challenge_id: challenge.challenge_id },
    });
    expect(startRes.statusCode).toBe(200);
    const startBody = startRes.json();
    expect(startBody.ok).toBe(true);
    expect(startBody.data.status).toBe("code_found");
    expect(startBody.data.extraction_source).toBe("subject_snippet");
    expect(startBody.data.raw_code_revealed_to_agent).toBe(false);
    expect(startBody.data.email_body_revealed_to_agent).toBe(false);
    assertNoCodeLeak(startRes.body);

    const resolutionId: string = startBody.data.resolution_id;

    // Step 2: Agent triggers injection.
    const injectRes = await server.inject({
      method: "POST",
      url: `/api/agent/v1/challenge-email-resolutions/${resolutionId}/inject`,
      headers: { authorization: AGENT_TOKEN, "content-type": "application/json" },
      payload: {},
    });
    expect(injectRes.statusCode).toBe(200);
    const injectBody = injectRes.json();
    expect(injectBody.ok).toBe(true);
    expect(injectBody.data.status).toBe("injected");
    expect(injectBody.data.raw_code_revealed_to_agent).toBe(false);
    expect(injectBody.data.email_body_revealed_to_agent).toBe(false);
    assertNoCodeLeak(injectRes.body);

    // Step 3: List does not clobber the injected resolution — even if challenge expires.
    // Simulate challenge expiry.
    const storedChallenge = securityChallenges.get(challenge.challenge_id)!;
    storedChallenge.expires_at = PAST;
    securityChallenges.set(challenge.challenge_id, storedChallenge);

    const listRes = await server.inject({
      method: "GET",
      url: "/api/internal/challenge-email-resolutions",
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    assertNoCodeLeak(listRes.body);

    const listed = listBody.data.find((r: { resolution_id: string }) => r.resolution_id === resolutionId);
    expect(listed).toBeDefined();
    expect(listed.status).toBe("injected");
    expect(listed.raw_code_revealed_to_agent).toBe(false);
    expect(listed.email_body_revealed_to_agent).toBe(false);
  });

  it("body_text extraction source propagates through start and list responses", async () => {
    const challenge = injectChallenge({ challenge_id: uid("chlg") });

    vi.mocked(searchGmailForChallengeCode).mockResolvedValueOnce(MOCK_SEARCH_RESULT_BODY);
    vi.mocked(executeChallengeInjectionViaCDP).mockResolvedValueOnce({ success: true });

    const startRes = await server.inject({
      method: "POST",
      url: "/api/internal/challenge-email-resolutions/start",
      headers: { "content-type": "application/json" },
      payload: { challenge_id: challenge.challenge_id },
    });
    expect(startRes.statusCode).toBe(200);
    const startBody = startRes.json();
    expect(startBody.data.status).toBe("code_found");
    expect(startBody.data.extraction_source).toBe("body_text");
    expect(startBody.data.email_body_revealed_to_agent).toBe(false);
    assertNoCodeLeak(startRes.body);

    // Inject succeeds.
    const injectRes = await server.inject({
      method: "POST",
      url: `/api/agent/v1/challenge-email-resolutions/${startBody.data.resolution_id}/inject`,
      headers: { authorization: AGENT_TOKEN, "content-type": "application/json" },
      payload: {},
    });
    expect(injectRes.statusCode).toBe(200);
    expect(injectRes.json().data.status).toBe("injected");
    assertNoCodeLeak(injectRes.body);

    // List shows extraction_source after injection.
    const listRes = await server.inject({
      method: "GET",
      url: `/api/internal/challenge-email-resolutions?challenge_id=${challenge.challenge_id}`,
    });
    const listed = listRes.json().data[0];
    expect(listed.extraction_source).toBe("body_text");
    expect(listed.email_body_revealed_to_agent).toBe(false);
    assertNoCodeLeak(listRes.body);
  });
});

// ─── Group B: Agent-initiated path ────────────────────────────────────────────

describe("Email resolution — agent-initiated path (email-resolution-request → approve)", () => {
  it("creates pending_approval, approve runs search, inject transitions to injected", async () => {
    const challenge = injectChallenge({ challenge_id: uid("chlg") });

    // Step 1: Agent requests email resolution — no search yet.
    const reqRes = await server.inject({
      method: "POST",
      url: `/api/agent/v1/security-challenges/${challenge.challenge_id}/email-resolution-request`,
      headers: { authorization: AGENT_TOKEN, "content-type": "application/json" },
      payload: {},
    });
    expect(reqRes.statusCode).toBe(200);
    const reqBody = reqRes.json();
    expect(reqBody.data.status).toBe("pending_approval");
    expect(reqBody.data.raw_code_revealed_to_agent).toBe(false);
    assertNoCodeLeak(reqRes.body);

    const resolutionId: string = reqBody.data.resolution_id;

    // Step 2: User approves in Antigen UI — search runs.
    vi.mocked(searchGmailForChallengeCode).mockResolvedValueOnce(MOCK_SEARCH_RESULT_SNIPPET);
    vi.mocked(executeChallengeInjectionViaCDP).mockResolvedValueOnce({ success: true });

    const approveRes = await server.inject({
      method: "POST",
      url: `/api/internal/challenge-email-resolutions/${resolutionId}/approve`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(approveRes.statusCode).toBe(200);
    const approveBody = approveRes.json();
    expect(approveBody.data.status).toBe("code_found");
    expect(approveBody.data.raw_code_revealed_to_agent).toBe(false);
    expect(approveBody.data.email_body_revealed_to_agent).toBe(false);
    assertNoCodeLeak(approveRes.body);

    // Step 3: Agent injects the found code.
    const injectRes = await server.inject({
      method: "POST",
      url: `/api/agent/v1/challenge-email-resolutions/${resolutionId}/inject`,
      headers: { authorization: AGENT_TOKEN, "content-type": "application/json" },
      payload: {},
    });
    expect(injectRes.statusCode).toBe(200);
    expect(injectRes.json().data.status).toBe("injected");
    assertNoCodeLeak(injectRes.body);
  });
});

// ─── Group C: Security challenge lazy expiry ─────────────────────────────────

describe("Security challenge lazy expiry", () => {
  it("expires only pending_user and code_submitted; all terminal statuses are unchanged", async () => {
    const cases: Array<{ id: string; initialStatus: SecurityChallenge["status"] }> = [
      { id: uid("chlg"), initialStatus: "pending_user" },
      { id: uid("chlg"), initialStatus: "code_submitted" },
      { id: uid("chlg"), initialStatus: "code_injected" },
      { id: uid("chlg"), initialStatus: "user_completed" },
      { id: uid("chlg"), initialStatus: "cancelled" },
      { id: uid("chlg"), initialStatus: "failed" },
      { id: uid("chlg"), initialStatus: "expired" },
    ];

    for (const { id, initialStatus } of cases) {
      injectChallenge({ challenge_id: id, status: initialStatus, expires_at: PAST });
    }

    // Trigger lazy expiry via the list endpoint.
    const res = await server.inject({
      method: "GET",
      url: "/api/internal/security-challenges?include_terminal=true",
    });
    expect(res.statusCode).toBe(200);

    // Assert in-memory Map state (the authoritative source for the invariant).
    const [pending, submitted, injected, completed, cancelled, failed, alreadyExpired] = cases.map(
      ({ id }) => securityChallenges.get(id)!,
    );

    expect(pending.status).toBe("expired");    // pending_user → expired
    expect(submitted.status).toBe("expired");  // code_submitted → expired
    expect(injected.status).toBe("code_injected");    // unchanged
    expect(completed.status).toBe("user_completed");  // unchanged
    expect(cancelled.status).toBe("cancelled");       // unchanged
    expect(failed.status).toBe("failed");             // unchanged
    expect(alreadyExpired.status).toBe("expired");    // unchanged — already terminal
  });
});

// ─── Group D: Email resolution lazy expiry invariants ─────────────────────────

describe("Email resolution lazy expiry invariants", () => {
  it("injected resolution is NOT overwritten when linked challenge is expired", async () => {
    const chlgId = uid("chlg");
    injectChallenge({ challenge_id: chlgId, status: "code_injected", expires_at: PAST });
    const res = injectResolution({
      resolution_id: uid("ceres"),
      challenge_id: chlgId,
      status: "injected",
    });

    const listRes = await server.inject({ method: "GET", url: "/api/internal/challenge-email-resolutions" });
    expect(listRes.statusCode).toBe(200);

    const stored = challengeEmailResolutions.get(res.resolution_id)!;
    expect(stored.status).toBe("injected");

    const listed = listRes.json().data.find((r: { resolution_id: string }) => r.resolution_id === res.resolution_id);
    expect(listed?.status).toBe("injected");
  });

  it("code_found resolution is expired and resolutionCodes entry deleted when linked challenge is expired", async () => {
    const chlgId = uid("chlg");
    injectChallenge({ challenge_id: chlgId, status: "pending_user", expires_at: PAST });
    const res = injectResolution({
      resolution_id: uid("ceres"),
      challenge_id: chlgId,
      status: "code_found",
    });
    // Simulate a live code in memory.
    resolutionCodes.set(res.resolution_id, { code: MOCK_CODE, expires_at: FUTURE });

    const listRes = await server.inject({ method: "GET", url: "/api/internal/challenge-email-resolutions" });
    expect(listRes.statusCode).toBe(200);

    expect(challengeEmailResolutions.get(res.resolution_id)!.status).toBe("expired");
    expect(resolutionCodes.has(res.resolution_id)).toBe(false);
  });

  it("pending_approval resolution is expired when linked challenge is expired", async () => {
    const chlgId = uid("chlg");
    injectChallenge({ challenge_id: chlgId, status: "pending_user", expires_at: PAST });
    const res = injectResolution({
      resolution_id: uid("ceres"),
      challenge_id: chlgId,
      status: "pending_approval",
    });

    await server.inject({ method: "GET", url: "/api/internal/challenge-email-resolutions" });

    expect(challengeEmailResolutions.get(res.resolution_id)!.status).toBe("expired");
  });

  it("searching resolution is expired when linked challenge is expired", async () => {
    const chlgId = uid("chlg");
    injectChallenge({ challenge_id: chlgId, status: "pending_user", expires_at: PAST });
    const res = injectResolution({
      resolution_id: uid("ceres"),
      challenge_id: chlgId,
      status: "searching",
    });

    await server.inject({ method: "GET", url: "/api/internal/challenge-email-resolutions" });

    expect(challengeEmailResolutions.get(res.resolution_id)!.status).toBe("expired");
  });
});
