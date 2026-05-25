import { vi } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { verificationCards, verificationProviderSessions, disclosureReceipts } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import { verificationRoutes, sessionOtpRecords } from "../routes/verifications.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let server: FastifyInstance;

async function createSession(
  verification_type: string,
  opts: { provider_name?: string; mock_input?: object } = {}
) {
  const res = await server.inject({
    method: "POST",
    url: "/api/verifications/sessions",
    payload: { verification_type, ...opts },
  });
  return { res, data: JSON.parse(res.body) };
}

async function completeSession(sessionId: string, mock_input?: object) {
  const res = await server.inject({
    method: "POST",
    url: `/api/verifications/sessions/${sessionId}/complete`,
    payload: mock_input !== undefined ? { mock_input } : {},
  });
  return { res, data: JSON.parse(res.body) };
}

// Fields that must never appear as JSON keys in any response
const FORBIDDEN_KEY_PATTERN = (field: string) => new RegExp(`"${field}"\\s*:`);

const FORBIDDEN_FIELDS = [
  "ssn",
  "dob",
  "legal_name",
  "address",
  "document_number",
  "biometric",
  "provider_payload",
  "raw_document",
];

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(verificationRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  verificationCards.clear();
  verificationProviderSessions.clear();
  disclosureReceipts.clear();
  sessionOtpRecords.clear();
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/verifications/types", () => {
  it("returns the three mock providers with their supported types", async () => {
    const res = await server.inject({ method: "GET", url: "/api/verifications/types" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    const providers = body.data.providers as Array<{ name: string; supported_types: string[] }>;
    const names = providers.map((p) => p.name);
    expect(names).toContain("mock_email");
    expect(names).toContain("mock_student");
    expect(names).toContain("mock_gov_id");
    const emailProvider = providers.find((p) => p.name === "mock_email");
    expect(emailProvider?.supported_types).toContain("email_ownership");
    const govProvider = providers.find((p) => p.name === "mock_gov_id");
    expect(govProvider?.supported_types).toContain("government_id");
  });
});

describe("POST /api/verifications/sessions", () => {
  it("creates an email session with status initiated", async () => {
    const { res, data } = await createSession("email_ownership");
    expect(res.statusCode).toBe(201);
    expect(data.ok).toBe(true);
    expect(data.data.session_id).toMatch(/^vps_/);
    expect(data.data.verification_type).toBe("email_ownership");
    expect(data.data.provider_name).toBe("mock_email");
    expect(data.data.status).toBe("initiated");
    expect(data.data.expires_at).toBeDefined();
    expect(verificationProviderSessions.size).toBe(1);
  });

  it("returns 400 for an unknown verification type", async () => {
    const { res, data } = await createSession("unicorn_check");
    expect(res.statusCode).toBe(400);
    expect(data.error.code).toBe("UNKNOWN_VERIFICATION_TYPE");
  });

  it("returns 400 for an unknown provider_name", async () => {
    const { res, data } = await createSession("email_ownership", {
      provider_name: "nonexistent_provider",
    });
    expect(res.statusCode).toBe(400);
    expect(data.error.code).toBe("UNKNOWN_PROVIDER");
  });

  it("session creation response does not include provider_session_id", async () => {
    const { res } = await createSession("email_ownership");
    expect(res.body).not.toMatch(FORBIDDEN_KEY_PATTERN("provider_session_id"));
  });
});

describe("GET /api/verifications/sessions/:sessionId", () => {
  it("returns safe session status without provider_session_id", async () => {
    const { data: created } = await createSession("email_ownership");
    const sessionId = created.data.session_id;

    const res = await server.inject({
      method: "GET",
      url: `/api/verifications/sessions/${sessionId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.session_id).toBe(sessionId);
    expect(body.data.status).toBe("initiated");
    expect(res.body).not.toMatch(FORBIDDEN_KEY_PATTERN("provider_session_id"));
  });

  it("returns 404 for unknown session", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/verifications/sessions/vps_does_not_exist",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/verifications/sessions/:sessionId/complete — email", () => {
  it("issues a signed VerificationCard with email_ownership claim", async () => {
    const { data: created } = await createSession("email_ownership", {
      mock_input: { email: "student@umich.edu" },
    });
    const { res, data } = await completeSession(created.data.session_id);

    expect(res.statusCode).toBe(201);
    expect(data.ok).toBe(true);
    const card = data.data.card;
    expect(card.card_id).toMatch(/^vc_/);
    expect(card.claims).toHaveLength(1);
    expect(card.claims[0].claim_type).toBe("email_ownership");
    expect(card.claims[0].claim_value.email_domain).toBe("umich.edu");
    expect(card.revocation_status).toBe("active");
    expect(verificationCards.size).toBe(1);
  });

  it("session status transitions to completed after complete", async () => {
    const { data: created } = await createSession("email_ownership");
    const sessionId = created.data.session_id;
    await completeSession(sessionId);
    const session = verificationProviderSessions.get(sessionId);
    expect(session?.status).toBe("completed");
  });
});

describe("POST /api/verifications/sessions/:sessionId/complete — student", () => {
  it("issues a student_status card with default institution", async () => {
    const { data: created } = await createSession("student_status");
    const { data } = await completeSession(created.data.session_id);

    expect(data.ok).toBe(true);
    const card = data.data.card;
    expect(card.claims[0].claim_type).toBe("student_status");
    expect(card.claims[0].claim_value.institution_name).toBe("University of Michigan");
    expect(card.claims[0].claim_value.enrollment_status).toBe("active");
    expect(card.claims[0].assurance_level).toBe("provider_verified");
  });

  it("uses institution_name from mock_input when provided", async () => {
    const { data: created } = await createSession("student_status", {
      mock_input: { institution_name: "MIT", enrollment_status: "graduated" },
    });
    const { data } = await completeSession(created.data.session_id);
    expect(data.data.card.claims[0].claim_value.institution_name).toBe("MIT");
    expect(data.data.card.claims[0].claim_value.enrollment_status).toBe("graduated");
  });
});

describe("POST /api/verifications/sessions/:sessionId/complete — gov_id", () => {
  it("issues a document_verified card with Tier 2 country_code and id_type only", async () => {
    const { data: created } = await createSession("government_id");
    const { res, data } = await completeSession(created.data.session_id);

    expect(res.statusCode).toBe(201);
    const card = data.data.card;
    expect(card.claims[0].claim_type).toBe("government_id");
    expect(card.claims[0].assurance_level).toBe("document_verified");
    expect(card.claims[0].claim_value.country_code).toBe("US");
    expect(card.claims[0].claim_value.id_type).toBe("drivers_license");
  });

  it("card detail for gov_id contains no raw evidence fields", async () => {
    const { data: created } = await createSession("government_id");
    const { res } = await completeSession(created.data.session_id);

    for (const field of FORBIDDEN_FIELDS) {
      expect(res.body).not.toMatch(FORBIDDEN_KEY_PATTERN(field));
    }
    // Also check for the sensitive gov ID field names explicitly
    expect(res.body).not.toMatch(FORBIDDEN_KEY_PATTERN("document_number"));
    expect(res.body).not.toMatch(FORBIDDEN_KEY_PATTERN("legal_name"));
    expect(res.body).not.toMatch(FORBIDDEN_KEY_PATTERN("dob"));
    expect(res.body).not.toMatch(FORBIDDEN_KEY_PATTERN("ssn"));
  });
});

describe("GET /api/verifications/cards", () => {
  it("returns card summaries without provider_reference_id", async () => {
    const { data: s1 } = await createSession("email_ownership");
    const { data: s2 } = await createSession("student_status");
    await completeSession(s1.data.session_id);
    await completeSession(s2.data.session_id);

    const res = await server.inject({ method: "GET", url: "/api/verifications/cards" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.cards).toHaveLength(2);

    // Summary fields present
    const summary = body.data.cards[0];
    expect(summary.card_id).toBeDefined();
    expect(summary.claim_types).toBeDefined();
    expect(summary.revocation_status).toBeDefined();

    // Sensitive fields absent
    expect(res.body).not.toMatch(FORBIDDEN_KEY_PATTERN("provider_reference_id"));
    expect(res.body).not.toMatch(FORBIDDEN_KEY_PATTERN("provider_session_id"));
  });
});

describe("GET /api/verifications/cards/:cardId", () => {
  it("returns card detail without provider_reference_id", async () => {
    const { data: created } = await createSession("email_ownership");
    const { data: completed } = await completeSession(created.data.session_id);
    const cardId = completed.data.card.card_id;

    const res = await server.inject({
      method: "GET",
      url: `/api/verifications/cards/${cardId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.card.card_id).toBe(cardId);
    expect(body.data.card.claims[0].claim_id).toMatch(/^vc_claim_/);
    expect(res.body).not.toMatch(FORBIDDEN_KEY_PATTERN("provider_reference_id"));
    expect(res.body).not.toMatch(FORBIDDEN_KEY_PATTERN("provider_session_id"));
  });

  it("returns 404 for unknown cardId", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/verifications/cards/vc_does_not_exist",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/verifications/cards/:cardId/verify", () => {
  it("returns hash_valid: true for a freshly issued card", async () => {
    const { data: created } = await createSession("email_ownership");
    const { data: completed } = await completeSession(created.data.session_id);
    const cardId = completed.data.card.card_id;

    const res = await server.inject({
      method: "GET",
      url: `/api/verifications/cards/${cardId}/verify`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.hash_valid).toBe(true);
    expect(body.data.expired).toBe(false);
    expect(body.data.revoked).toBe(false);
  });
});

describe("POST /api/verifications/cards/:cardId/revoke", () => {
  it("marks card revoked and hash remains valid", async () => {
    const { data: created } = await createSession("email_ownership");
    const { data: completed } = await completeSession(created.data.session_id);
    const cardId = completed.data.card.card_id;

    const revokeRes = await server.inject({
      method: "POST",
      url: `/api/verifications/cards/${cardId}/revoke`,
    });
    expect(revokeRes.statusCode).toBe(200);
    const revokeBody = JSON.parse(revokeRes.body);
    expect(revokeBody.data.card.revocation_status).toBe("revoked");

    // Hash must still be valid after revocation (revocation_status excluded from hash)
    const verifyRes = await server.inject({
      method: "GET",
      url: `/api/verifications/cards/${cardId}/verify`,
    });
    const verifyBody = JSON.parse(verifyRes.body);
    expect(verifyBody.data.hash_valid).toBe(true);
    expect(verifyBody.data.revoked).toBe(true);
  });
});

describe("Error cases", () => {
  it("returns 400 SESSION_EXPIRED when completing a session past its expiry", async () => {
    const { data: created } = await createSession("email_ownership");
    const sessionId = created.data.session_id;

    // Backdate the session's expires_at
    const session = verificationProviderSessions.get(sessionId)!;
    session.expires_at = new Date(Date.now() - 1000).toISOString();

    const { res, data } = await completeSession(sessionId);
    expect(res.statusCode).toBe(400);
    expect(data.error.code).toBe("SESSION_EXPIRED");
  });

  it("returns 409 SESSION_ALREADY_TERMINAL when completing a completed session", async () => {
    const { data: created } = await createSession("email_ownership");
    const sessionId = created.data.session_id;
    await completeSession(sessionId);

    const { res, data } = await completeSession(sessionId);
    expect(res.statusCode).toBe(409);
    expect(data.error.code).toBe("SESSION_ALREADY_TERMINAL");
  });
});

describe("Privacy invariants", () => {
  it("no forbidden raw field names appear as JSON keys in any route response", async () => {
    const { data: s } = await createSession("government_id");
    const sessionId = s.data.session_id;

    const responses: string[] = [];

    // Collect all route responses
    responses.push(
      (await server.inject({ method: "GET", url: "/api/verifications/types" })).body
    );
    responses.push(
      (await server.inject({ method: "GET", url: `/api/verifications/sessions/${sessionId}` })).body
    );
    const { res: completeRes, data: completed } = await completeSession(sessionId);
    responses.push(completeRes.body);
    const cardId = completed.data.card.card_id;
    responses.push(
      (await server.inject({ method: "GET", url: "/api/verifications/cards" })).body
    );
    responses.push(
      (await server.inject({ method: "GET", url: `/api/verifications/cards/${cardId}` })).body
    );
    responses.push(
      (await server.inject({ method: "GET", url: `/api/verifications/cards/${cardId}/verify` }))
        .body
    );
    responses.push(
      (
        await server.inject({ method: "POST", url: `/api/verifications/cards/${cardId}/revoke` })
      ).body
    );

    for (const raw of responses) {
      for (const field of FORBIDDEN_FIELDS) {
        expect(raw, `"${field}" must not appear as a JSON key`).not.toMatch(
          FORBIDDEN_KEY_PATTERN(field)
        );
      }
      expect(raw).not.toMatch(FORBIDDEN_KEY_PATTERN("provider_reference_id"));
      expect(raw).not.toMatch(FORBIDDEN_KEY_PATTERN("provider_session_id"));
    }
  });
});

describe("Persistence invariants", () => {
  it("schedulePersist is NOT called after session creation", async () => {
    await createSession("email_ownership");
    expect(schedulePersist).not.toHaveBeenCalled();
  });

  it("schedulePersist IS called after complete", async () => {
    const { data: created } = await createSession("email_ownership");
    expect(schedulePersist).not.toHaveBeenCalled();
    await completeSession(created.data.session_id);
    expect(schedulePersist).toHaveBeenCalled();
  });

  it("verificationCards are stored after complete", async () => {
    expect(verificationCards.size).toBe(0);
    const { data: created } = await createSession("student_status");
    await completeSession(created.data.session_id);
    expect(verificationCards.size).toBe(1);
  });

  it("disclosureReceipts remain untouched after all verification operations", async () => {
    const { data: created } = await createSession("email_ownership");
    await completeSession(created.data.session_id);
    // Revoke the card too
    const cards = Array.from(verificationCards.values());
    await server.inject({
      method: "POST",
      url: `/api/verifications/cards/${cards[0].card_id}/revoke`,
    });
    expect(disclosureReceipts.size).toBe(0);
  });
});

// ─── local_email provider tests ───────────────────────────────────────────────

async function createEmailSession(email: string) {
  const res = await server.inject({
    method: "POST",
    url: "/api/verifications/sessions",
    payload: { verification_type: "email_ownership", provider_name: "local_email", email },
  });
  return { res, data: JSON.parse(res.body) };
}

async function submitCode(sessionId: string, code: string) {
  const res = await server.inject({
    method: "POST",
    url: `/api/verifications/sessions/${sessionId}/submit-code`,
    payload: { code },
  });
  return { res, data: JSON.parse(res.body) };
}

function captureOtp(sessionId: string): string | undefined {
  // Reads from mock.calls that were captured BEFORE this call — spy must be set up first.
  const consoleSpy = vi.mocked(console.log);
  const match = consoleSpy.mock.calls
    .flat()
    .find((arg) => typeof arg === "string" && arg.includes(`session=${sessionId}`));
  return typeof match === "string" ? match.match(/otp=(\d{6})/)?.[1] : undefined;
}

describe("POST /api/verifications/sessions — local_email provider", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns 201 with status in_progress and requires_code_step: true for a valid email", async () => {
    const { res, data } = await createEmailSession("user@umich.edu");
    expect(res.statusCode).toBe(201);
    expect(data.ok).toBe(true);
    expect(data.data.status).toBe("in_progress");
    expect(data.data.requires_code_step).toBe(true);
    expect(data.data.provider_name).toBe("local_email");
  });

  it("returns 400 EMAIL_REQUIRED when email is missing", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/verifications/sessions",
      payload: { verification_type: "email_ownership", provider_name: "local_email" },
    });
    const data = JSON.parse(res.body);
    expect(res.statusCode).toBe(400);
    expect(data.error.code).toBe("EMAIL_REQUIRED");
  });

  it("returns 400 EMAIL_REQUIRED when email has no @ symbol", async () => {
    const { res, data } = await createEmailSession("notanemail");
    expect(res.statusCode).toBe(400);
    expect(data.error.code).toBe("EMAIL_REQUIRED");
  });

  it("returns 400 EMAIL_INVALID when domain has no dot", async () => {
    const { res, data } = await createEmailSession("user@localhost");
    expect(res.statusCode).toBe(400);
    expect(data.error.code).toBe("EMAIL_INVALID");
  });

  it("does not return provider_session_id in the response", async () => {
    const { res } = await createEmailSession("user@umich.edu");
    expect(res.body).not.toMatch(FORBIDDEN_KEY_PATTERN("provider_session_id"));
  });

  it("does not include the OTP or raw email in the response body", async () => {
    const { res } = await createEmailSession("user@umich.edu");
    expect(res.body).not.toMatch(/"otp"\s*:/);
    expect(res.body).not.toMatch(/"code"\s*:/);
    expect(res.body).not.toMatch(/user@umich\.edu/); // full email never returned
  });

  it("logs the OTP to the console in dev mode", async () => {
    const { data } = await createEmailSession("user@umich.edu");
    const sessionId = data.data.session_id;
    const consoleSpy = vi.mocked(console.log);
    const logged = consoleSpy.mock.calls.flat().some(
      (arg) =>
        typeof arg === "string" &&
        arg.includes("[local_email OTP]") &&
        arg.includes(`session=${sessionId}`),
    );
    expect(logged).toBe(true);
  });

  it("stores only the domain suffix, not the full email", async () => {
    const { data } = await createEmailSession("someuser@example.org");
    const sessionId = data.data.session_id;
    // The OTP record should exist (hash stored)
    expect(sessionOtpRecords.has(sessionId)).toBe(true);
    // The stored hash should be 64 hex chars (SHA-256), not a 6-digit number
    const record = sessionOtpRecords.get(sessionId)!;
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.hash).not.toMatch(/^\d{6}$/);
  });
});

describe("POST /api/verifications/sessions/:sessionId/submit-code", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns 404 for an unknown session", async () => {
    const { res, data } = await submitCode("vps_unknown", "123456");
    expect(res.statusCode).toBe(404);
    expect(data.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("returns 400 SESSION_EXPIRED when session is past expiry", async () => {
    const { data: created } = await createEmailSession("user@umich.edu");
    const sessionId = created.data.session_id;
    const session = verificationProviderSessions.get(sessionId)!;
    session.expires_at = new Date(Date.now() - 1000).toISOString();

    const { res, data } = await submitCode(sessionId, "123456");
    expect(res.statusCode).toBe(400);
    expect(data.error.code).toBe("SESSION_EXPIRED");
  });

  it("returns 409 SESSION_NOT_AWAITING_CODE when session is not in_progress", async () => {
    const { data: created } = await createEmailSession("user@umich.edu");
    const sessionId = created.data.session_id;
    const session = verificationProviderSessions.get(sessionId)!;
    session.status = "completed";

    const { res, data } = await submitCode(sessionId, "123456");
    expect(res.statusCode).toBe(409);
    expect(data.error.code).toBe("SESSION_NOT_AWAITING_CODE");
  });

  it("returns 400 CODE_NOT_SUPPORTED when called on a mock_email session", async () => {
    const { data: created } = await createSession("email_ownership"); // uses mock_email
    const sessionId = created.data.session_id;
    const { res, data } = await submitCode(sessionId, "123456");
    expect(res.statusCode).toBe(400);
    expect(data.error.code).toBe("CODE_NOT_SUPPORTED");
  });

  it("returns 400 OTP_EXPIRED when the OTP record has passed its expiry", async () => {
    const { data: created } = await createEmailSession("user@umich.edu");
    const sessionId = created.data.session_id;

    const record = sessionOtpRecords.get(sessionId)!;
    record.expires_at = new Date(Date.now() - 1000).toISOString();

    const { res, data } = await submitCode(sessionId, "123456");
    expect(res.statusCode).toBe(400);
    expect(data.error.code).toBe("OTP_EXPIRED");
    expect(sessionOtpRecords.has(sessionId)).toBe(false); // cleaned up
  });

  it("returns 400 INVALID_CODE on wrong OTP with attempts_remaining", async () => {
    const { data: created } = await createEmailSession("user@umich.edu");
    const { res, data } = await submitCode(created.data.session_id, "000000");
    expect(res.statusCode).toBe(400);
    expect(data.error.code).toBe("INVALID_CODE");
    expect(data.error.attempts_remaining).toBe(4);
  });

  it("returns 429 TOO_MANY_ATTEMPTS after 5 consecutive wrong codes", async () => {
    const { data: created } = await createEmailSession("user@umich.edu");
    const sessionId = created.data.session_id;
    for (let i = 0; i < 5; i++) {
      await submitCode(sessionId, "000000");
    }
    const { res, data } = await submitCode(sessionId, "000000");
    expect(res.statusCode).toBe(429);
    expect(data.error.code).toBe("TOO_MANY_ATTEMPTS");
  });

  it("issues a signed card with email_domain claim on correct OTP", async () => {
    const { data: created } = await createEmailSession("student@umich.edu");
    const sessionId = created.data.session_id;

    const otp = captureOtp(sessionId);
    expect(otp).toBeDefined();

    const { res, data } = await submitCode(sessionId, otp!);
    expect(res.statusCode).toBe(201);
    expect(data.ok).toBe(true);
    const card = data.data.card;
    expect(card.claims).toHaveLength(1);
    expect(card.claims[0].claim_type).toBe("email_ownership");
    expect(card.claims[0].claim_value.email_domain).toBe("umich.edu");
    expect(card.claims[0].assurance_level).toBe("provider_verified");
  });

  it("card claim does not contain the full email address or username prefix", async () => {
    const { data: created } = await createEmailSession("student@umich.edu");
    const sessionId = created.data.session_id;
    const otp = captureOtp(sessionId);

    const { res } = await submitCode(sessionId, otp!);
    expect(res.body).not.toContain("student@umich.edu");
    expect(res.body).not.toContain('"student"'); // username prefix must not appear
  });

  it("session status becomes completed after correct OTP", async () => {
    const { data: created } = await createEmailSession("user@umich.edu");
    const sessionId = created.data.session_id;
    const otp = captureOtp(sessionId);

    await submitCode(sessionId, otp!);
    const session = verificationProviderSessions.get(sessionId)!;
    expect(session.status).toBe("completed");
  });

  it("OTP record is deleted after successful submission", async () => {
    const { data: created } = await createEmailSession("user@umich.edu");
    const sessionId = created.data.session_id;
    const otp = captureOtp(sessionId);

    expect(sessionOtpRecords.has(sessionId)).toBe(true);
    await submitCode(sessionId, otp!);
    expect(sessionOtpRecords.has(sessionId)).toBe(false);
  });

  it("schedulePersist is called after successful OTP submission", async () => {
    const { data: created } = await createEmailSession("user@umich.edu");
    const sessionId = created.data.session_id;
    const otp = captureOtp(sessionId);

    expect(schedulePersist).not.toHaveBeenCalled();
    await submitCode(sessionId, otp!);
    expect(schedulePersist).toHaveBeenCalled();
  });

  it("schedulePersist is NOT called after a wrong OTP submission", async () => {
    const { data: created } = await createEmailSession("user@umich.edu");
    await submitCode(created.data.session_id, "000000");
    expect(schedulePersist).not.toHaveBeenCalled();
  });

  it("card response does not include forbidden fields", async () => {
    const { data: created } = await createEmailSession("user@test.com");
    const sessionId = created.data.session_id;
    const otp = captureOtp(sessionId);

    const { res } = await submitCode(sessionId, otp!);
    for (const field of [...FORBIDDEN_FIELDS, "provider_reference_id", "provider_session_id", "otp", "code"]) {
      expect(res.body, `"${field}" must not appear as a JSON key`).not.toMatch(
        FORBIDDEN_KEY_PATTERN(field),
      );
    }
  });
});

describe("POST /complete guard for local_email provider", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns 400 CODE_STEP_REQUIRED when calling /complete on a local_email session", async () => {
    const { data: created } = await createEmailSession("user@umich.edu");
    const { res, data } = await completeSession(created.data.session_id);
    expect(res.statusCode).toBe(400);
    expect(data.error.code).toBe("CODE_STEP_REQUIRED");
  });

  it("mock_email /complete still works unchanged", async () => {
    const { data: created } = await createSession("email_ownership", {
      mock_input: { email: "user@umich.edu" },
    });
    const { res, data } = await completeSession(created.data.session_id);
    expect(res.statusCode).toBe(201);
    expect(data.data.card.claims[0].claim_type).toBe("email_ownership");
  });
});
