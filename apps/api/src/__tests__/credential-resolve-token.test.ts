import { vi } from "vitest";

// Suppress disk writes in all tests.
vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

// Mock KMS so tests don't require real env keys.
vi.mock("../lib/kms.js", () => ({
  getKmsProvider: vi.fn(() => ({
    provider: "local_dev",
    encryptSecret: vi.fn().mockResolvedValue({
      provider: "local_dev",
      version: 1,
      algorithm: "aes-256-gcm",
      nonce_b64: "mock-nonce",
      ciphertext_b64: "mock-cipher",
      tag_b64: "mock-tag",
      aad_b64: "mock-aad",
      created_at: new Date().toISOString(),
    }),
    decryptSecret: vi.fn().mockResolvedValue("test-password-123"),
  })),
}));

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  aegisVaultPasses,
  credentialSessions,
  credentialFillRequests,
  encryptedSecretVault,
  MOCK_USER_ID,
  newId,
  type CredentialUseSession,
  type CredentialFillRequest,
} from "../store/index.js";
import { credentialSessionRoutes } from "../routes/credential-sessions.js";

// ─── Server ───────────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(credentialSessionRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  credentialSessions.clear();
  credentialFillRequests.clear();
  aegisVaultPasses.clear();
  encryptedSecretVault.clear();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// ─── Seed helpers ─────────────────────────────────────────────────────────────

const PASS_ID = "vp_test_001";
const SESSION_ID = "credsess_test_001";
const DOMAIN = "localhost";
const FAR_FUTURE = "2099-12-31T23:59:59.000Z";

function seedVaultPass() {
  const mockBlob = {
    provider: "local_dev",
    version: 1,
    algorithm: "aes-256-gcm",
    nonce_b64: "mock",
    ciphertext_b64: "mock",
    tag_b64: "mock",
    aad_b64: "mock",
    created_at: new Date().toISOString(),
  } as any;

  aegisVaultPasses.set(PASS_ID, {
    pass_id: PASS_ID,
    user_id: MOCK_USER_ID,
    label: "Test Credential",
    kind: "login_password",
    domain: DOMAIN,
    username: "testuser",
    secret_ref: "devvault://test-001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  encryptedSecretVault.set("devvault://test-001", mockBlob);
}

function seedActiveSession(overrides: Partial<CredentialUseSession> = {}): CredentialUseSession {
  const session: CredentialUseSession = {
    session_id: SESSION_ID,
    user_id: MOCK_USER_ID,
    pass_id: PASS_ID,
    domain: DOMAIN,
    status: "active",
    allowed_fields: ["username", "password"],
    fields_filled: [],
    approved_at: new Date().toISOString(),
    expires_at: FAR_FUTURE,
    url_match: { hostname: DOMAIN },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  credentialSessions.set(SESSION_ID, session);
  return session;
}

function seedPendingFillRequest(overrides: Partial<CredentialFillRequest> = {}): CredentialFillRequest {
  const fillReq: CredentialFillRequest = {
    request_id: "filreq_test_001",
    session_id: SESSION_ID,
    field: "password",
    domain: DOMAIN,
    status: "pending",
    created_at: new Date().toISOString(),
    resolve_token: "valid-resolve-token-abcdef1234567890abcdef1234567890abcdef12",
    resolve_token_used: false,
    ...overrides,
  };
  credentialFillRequests.set(fillReq.request_id, fillReq);
  return fillReq;
}

const EXT_SECRET = "test-extension-secret-value";
const VALID_EXT_HEADERS = { "x-aegis-extension-secret": EXT_SECRET };

// ─── Layer 1: Extension secret on polling endpoint ────────────────────────────

describe("GET /api/credential-fill-requests — Layer 1 extension secret", () => {
  beforeEach(() => {
    seedVaultPass();
    seedActiveSession();
    seedPendingFillRequest();
    vi.stubEnv("AEGIS_EXTENSION_SECRET", EXT_SECRET);
  });

  it("returns 401 when extension secret header is missing", async () => {
    const res = await server.inject({ method: "GET", url: "/api/credential-fill-requests?domain=localhost&status=pending" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("EXTENSION_AUTH_REQUIRED");
  });

  it("returns 401 when extension secret header is wrong", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/credential-fill-requests?domain=localhost&status=pending",
      headers: { "x-aegis-extension-secret": "wrong-secret" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("EXTENSION_AUTH_REQUIRED");
  });

  it("returns 200 with fill requests when valid extension secret is provided", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/credential-fill-requests?domain=localhost&status=pending",
      headers: VALID_EXT_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  it("includes resolve_token in polling response for unconsumed fill requests", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/credential-fill-requests?domain=localhost&status=pending",
      headers: VALID_EXT_HEADERS,
    });
    const fill = res.json().data[0];
    expect(fill.resolve_token).toBe("valid-resolve-token-abcdef1234567890abcdef1234567890abcdef12");
  });

  it("omits resolve_token from polling response when token is already consumed", async () => {
    seedPendingFillRequest({ status: "running", resolve_token: undefined, resolve_token_used: true });
    const res = await server.inject({
      method: "GET",
      url: "/api/credential-fill-requests?domain=localhost",
      headers: VALID_EXT_HEADERS,
    });
    // running fill requests are filtered out by the status=pending filter; test without status filter
    const fills = res.json().data;
    expect(fills.every((f: any) => f.resolve_token === undefined)).toBe(true);
  });

  it("allows polling when AEGIS_EXTENSION_SECRET is not configured (backward compat)", async () => {
    vi.unstubAllEnvs(); // remove the secret
    seedVaultPass();
    seedActiveSession();
    seedPendingFillRequest();
    const res = await server.inject({ method: "GET", url: "/api/credential-fill-requests?domain=localhost&status=pending" });
    expect(res.statusCode).toBe(200);
  });
});

// ─── Layer 1: Extension secret on resolve-value endpoint ─────────────────────

describe("POST /api/credential-fill-requests/:id/resolve-value — Layer 1 extension secret", () => {
  beforeEach(() => {
    seedVaultPass();
    seedActiveSession();
    seedPendingFillRequest();
    vi.stubEnv("AEGIS_EXTENSION_SECRET", EXT_SECRET);
  });

  it("returns 401 when extension secret header is missing", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers: { "x-aegis-resolve-token": "valid-resolve-token-abcdef1234567890abcdef1234567890abcdef12" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("EXTENSION_AUTH_REQUIRED");
  });

  it("returns 401 when extension secret is wrong", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers: {
        "x-aegis-extension-secret": "wrong-secret",
        "x-aegis-resolve-token": "valid-resolve-token-abcdef1234567890abcdef1234567890abcdef12",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("EXTENSION_AUTH_REQUIRED");
  });
});

// ─── Layer 2: One-time resolve token ─────────────────────────────────────────

describe("POST /api/credential-fill-requests/:id/resolve-value — Layer 2 resolve token", () => {
  beforeEach(() => {
    seedVaultPass();
    seedActiveSession();
    seedPendingFillRequest();
    vi.stubEnv("AEGIS_EXTENSION_SECRET", EXT_SECRET);
  });

  it("returns 401 when resolve token header is missing", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers: VALID_EXT_HEADERS,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("RESOLVE_TOKEN_REQUIRED");
  });

  it("returns 403 when fill request has no resolve token (session not approved)", async () => {
    seedPendingFillRequest({ resolve_token: undefined });
    const res = await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers: { ...VALID_EXT_HEADERS, "x-aegis-resolve-token": "any-token" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("NO_RESOLVE_TOKEN");
  });

  it("returns 403 when resolve token is wrong", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers: { ...VALID_EXT_HEADERS, "x-aegis-resolve-token": "wrong-token" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("INVALID_RESOLVE_TOKEN");
  });

  it("returns 200 and credential value with valid extension secret + valid resolve token", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers: {
        ...VALID_EXT_HEADERS,
        "x-aegis-resolve-token": "valid-resolve-token-abcdef1234567890abcdef1234567890abcdef12",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().data.field).toBe("password");
    expect(res.json().data.redacted).toBe(true);
    expect(res.json().data.value).toBe("test-password-123");
  });

  it("returns 409 RESOLVE_TOKEN_CONSUMED on second call with same request_id", async () => {
    const headers = {
      ...VALID_EXT_HEADERS,
      "x-aegis-resolve-token": "valid-resolve-token-abcdef1234567890abcdef1234567890abcdef12",
    };
    const first = await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers,
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("RESOLVE_TOKEN_CONSUMED");
  });

  it("marks fill request as consumed (token nullified) after successful resolution", async () => {
    await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers: {
        ...VALID_EXT_HEADERS,
        "x-aegis-resolve-token": "valid-resolve-token-abcdef1234567890abcdef1234567890abcdef12",
      },
    });
    const stored = credentialFillRequests.get("filreq_test_001")!;
    expect(stored.resolve_token_used).toBe(true);
    expect(stored.resolve_token).toBeUndefined();
    expect(stored.status).toBe("running");
  });

  it("returns 400 INVALID_STATE for completed fill requests", async () => {
    seedPendingFillRequest({ status: "completed" });
    const res = await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers: {
        ...VALID_EXT_HEADERS,
        "x-aegis-resolve-token": "valid-resolve-token-abcdef1234567890abcdef1234567890abcdef12",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_STATE");
  });

  it("returns 400 SESSION_EXPIRED for expired sessions", async () => {
    seedActiveSession({ expires_at: "2020-01-01T00:00:00.000Z" });
    const res = await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers: {
        ...VALID_EXT_HEADERS,
        "x-aegis-resolve-token": "valid-resolve-token-abcdef1234567890abcdef1234567890abcdef12",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("SESSION_EXPIRED");
  });
});

// ─── Token generation ─────────────────────────────────────────────────────────

describe("resolve_token generation", () => {
  beforeEach(() => {
    seedVaultPass();
    vi.stubEnv("AEGIS_EXTENSION_SECRET", EXT_SECRET);
  });

  it("generates resolve_token immediately when fill is created on an already-active session", async () => {
    seedActiveSession();
    const res = await server.inject({
      method: "POST",
      url: `/api/credential-sessions/${SESSION_ID}/fill`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ field: "password" }),
    });
    expect(res.statusCode).toBe(201);
    // Token is internal — not returned to agent in fill response
    expect(res.json().data.resolve_token).toBeUndefined();

    // But it is stored on the fill request
    const requestId = res.json().data.request_id;
    const stored = credentialFillRequests.get(requestId)!;
    expect(stored.resolve_token).toBeDefined();
    expect(typeof stored.resolve_token).toBe("string");
    expect(stored.resolve_token!.length).toBe(64); // 32 bytes as hex
    expect(stored.resolve_token_used).toBeFalsy();
  });

  it("generates resolve_token for pre-existing pending fills when session is approved", async () => {
    // Create session in pending_approval state
    const pendingSession: CredentialUseSession = {
      session_id: SESSION_ID,
      user_id: MOCK_USER_ID,
      pass_id: PASS_ID,
      domain: DOMAIN,
      status: "pending_approval",
      allowed_fields: ["password"],
      fields_filled: [],
      url_match: { hostname: DOMAIN },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    credentialSessions.set(SESSION_ID, pendingSession);

    // Create fill request without token (session not yet approved)
    const fillReq: CredentialFillRequest = {
      request_id: "filreq_test_001",
      session_id: SESSION_ID,
      field: "password",
      domain: DOMAIN,
      status: "pending",
      created_at: new Date().toISOString(),
      // No resolve_token yet
    };
    credentialFillRequests.set("filreq_test_001", fillReq);

    expect(credentialFillRequests.get("filreq_test_001")?.resolve_token).toBeUndefined();

    // Approve the session
    const approvalRes = await server.inject({
      method: "POST",
      url: `/api/credential-sessions/${SESSION_ID}/approve`,
    });
    expect(approvalRes.statusCode).toBe(200);

    // Token should now be generated on the fill request
    const updated = credentialFillRequests.get("filreq_test_001")!;
    expect(updated.resolve_token).toBeDefined();
    expect(typeof updated.resolve_token).toBe("string");
    expect(updated.resolve_token!.length).toBe(64);
  });

  it("resolve_token is not included in the fill creation response (not exposed to agent)", async () => {
    seedActiveSession();
    const res = await server.inject({
      method: "POST",
      url: `/api/credential-sessions/${SESSION_ID}/fill`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ field: "username" }),
    });
    const body = res.json();
    expect(body.data.resolve_token).toBeUndefined();
    // Verify no token appears anywhere in the response body
    expect(JSON.stringify(body)).not.toContain("resolve_token");
  });
});

// ─── safeTokenEquals edge cases ───────────────────────────────────────────────

describe("safeTokenEquals behavior via API", () => {
  beforeEach(() => {
    seedVaultPass();
    seedActiveSession();
    vi.stubEnv("AEGIS_EXTENSION_SECRET", EXT_SECRET);
  });

  it("handles length-mismatched tokens without throwing (Layer 1 wrong secret)", async () => {
    // short token vs 40-char secret — different lengths; safeTokenEquals must not throw
    const res = await server.inject({
      method: "GET",
      url: "/api/credential-fill-requests?domain=localhost&status=pending",
      headers: { "x-aegis-extension-secret": "short" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("handles length-mismatched tokens without throwing (Layer 2 wrong resolve token)", async () => {
    seedPendingFillRequest();
    const res = await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers: { ...VALID_EXT_HEADERS, "x-aegis-resolve-token": "short" },
    });
    // Different length from stored 64-char token — should return 403, not 500
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("INVALID_RESOLVE_TOKEN");
  });

  it("handles empty resolve token header without throwing", async () => {
    seedPendingFillRequest();
    const res = await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers: { ...VALID_EXT_HEADERS, "x-aegis-resolve-token": "" },
    });
    // Empty string — treated as missing
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("RESOLVE_TOKEN_REQUIRED");
  });
});

// ─── KMS audit events ─────────────────────────────────────────────────────────

describe("KMS audit events on resolve-value", () => {
  beforeEach(() => {
    seedVaultPass();
    seedActiveSession();
    seedPendingFillRequest();
    vi.stubEnv("AEGIS_EXTENSION_SECRET", EXT_SECRET);
  });

  it("records a KMS audit event on successful password resolution", async () => {
    const { recordKmsAuditEvent } = await import("../lib/kmsAudit.js");
    const spy = vi.spyOn({ recordKmsAuditEvent }, "recordKmsAuditEvent");

    // Use a fresh mock to spy via the module's own reference
    const kmsAuditMod = await import("../lib/kmsAudit.js");
    const auditSpy = vi.spyOn(kmsAuditMod, "recordKmsAuditEvent");

    await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers: {
        ...VALID_EXT_HEADERS,
        "x-aegis-resolve-token": "valid-resolve-token-abcdef1234567890abcdef1234567890abcdef12",
      },
    });

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "resolve_secret_for_runtime",
        pass_id: PASS_ID,
        domain: DOMAIN,
        success: true,
      })
    );
    auditSpy.mockRestore();
    spy.mockRestore();
  });
});

// ─── Response shape — no raw secret in receipts/responses ────────────────────

describe("Response shape — secret values confined to resolve-value only", () => {
  beforeEach(() => {
    seedVaultPass();
    seedActiveSession();
    seedPendingFillRequest();
    vi.stubEnv("AEGIS_EXTENSION_SECRET", EXT_SECRET);
  });

  it("polling response never contains raw credential values", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/credential-fill-requests?domain=localhost&status=pending",
      headers: VALID_EXT_HEADERS,
    });
    const body = JSON.stringify(res.json());
    // Should contain token (Layer 2) but not any decrypted password value
    expect(body).not.toContain("test-password-123");
    expect(body).not.toContain("devvault://");
    expect(body).not.toContain("secret_ref");
  });

  it("session view response never contains raw credential values", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/credential-sessions/${SESSION_ID}`,
    });
    const body = JSON.stringify(res.json());
    expect(body).not.toContain("test-password-123");
    expect(body).not.toContain("devvault://");
  });

  it("resolve-value response does not include resolve_token or secret_ref", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/credential-fill-requests/filreq_test_001/resolve-value",
      headers: {
        ...VALID_EXT_HEADERS,
        "x-aegis-resolve-token": "valid-resolve-token-abcdef1234567890abcdef1234567890abcdef12",
      },
    });
    const body = JSON.stringify(res.json());
    expect(body).not.toContain("resolve_token");
    expect(body).not.toContain("devvault://");
    expect(body).not.toContain("secret_ref");
  });
});
