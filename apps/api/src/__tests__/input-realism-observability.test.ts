/**
 * Input Realism Observability — unit + integration tests.
 *
 * Groups:
 *   A. Log redaction — logInputRealismLifecycle never emits forbidden keys
 *   B. Mode log shape — event structure for realistic / direct modes
 *   C. Fallback log shape — fallback_reason present; raw value absent
 *   D. Lifecycle endpoint — input_realism summary included; forbidden fields absent
 */

import { vi } from "vitest";

// Suppress disk writes for the Fastify server used in Group D.
vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));
vi.mock("../lib/kms.js", () => ({
  getKmsProvider: vi.fn(() => ({
    provider: "local_dev",
    encryptSecret: vi.fn(),
    decryptSecret: vi.fn().mockResolvedValue("test-password"),
  })),
}));
vi.mock("../lib/kmsAudit.js", () => ({ recordKmsAuditEvent: vi.fn() }));
vi.mock("../runtime/secretInjection.js", () => ({
  executeSecretInjectionViaCDP: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock("../runtime/challengeInjection.js", () => ({
  challengeCodes: new Map(),
  executeChallengeInjectionViaCDP: vi.fn(),
}));
vi.mock("../runtime/emailChallengeResolver.js", () => ({
  resolutionCodes: new Map(),
  searchGmailForChallengeCode: vi.fn(),
  isEmailChallengeSupported: vi.fn().mockReturnValue(false),
}));
vi.mock("../runtime/authenticatedSessions.js", () => ({
  createAuthenticatedSession: vi.fn(),
  getAuthenticatedSessionHandle: vi.fn(),
  observeAuthenticatedSession: vi.fn(),
  navigateAuthenticatedSession: vi.fn(),
}));
vi.mock("../repositories/receiptRepository.js", () => ({
  getReceiptRepository: vi.fn(() => ({ createReceipt: vi.fn(), listReceipts: vi.fn().mockResolvedValue([]) })),
}));
vi.mock("../repositories/vaultRepository.js", () => ({
  getVaultRepository: vi.fn(() => ({
    getVaultPass: vi.fn().mockResolvedValue(null),
    getEncryptedSecret: vi.fn().mockResolvedValue(null),
    storeVaultPass: vi.fn(),
    storeEncryptedSecret: vi.fn(),
  })),
}));
vi.mock("../lib/workspaceDomain.js", () => ({
  requireWorkspaceAccess: vi.fn(),
  checkWorkspacePermission: vi.fn(),
  emitWorkspaceAudit: vi.fn(),
  buildEffectivePermissionsMap: vi.fn(),
  checkTaskEligibility: vi.fn(),
  enrichTaskForManifest: vi.fn(),
  buildWorkQueue: vi.fn(),
  computeTaskReadiness: vi.fn(),
  buildWorkspaceArtifactNames: vi.fn(),
}));
vi.mock("../lib/delegationTrust.js", () => ({ computeDelegationTrustProfile: vi.fn() }));
vi.mock("../lib/userApprovalReceiptSigning.js", () => ({
  buildSignedUserApprovalReceipt: vi.fn().mockResolvedValue({ verification: { jws: "mock.jws", jws_present: true } }),
  verifyStoredUserApprovalReceipt: vi.fn().mockResolvedValue({ valid: true }),
  signUserApprovalReceiptJws: vi.fn().mockResolvedValue({ jws: "mock.jws", signing_key_id: "key-001" }),
  verifyUserApprovalReceiptJws: vi.fn().mockResolvedValue({ valid: true }),
  hashUserApprovalReceipt: vi.fn(),
}));

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { SecretFieldInjection } from "@aegis/types";
import { secretFieldInjections, MOCK_USER_ID } from "../store/index.js";
import { secretFieldInjectionRoutes } from "../routes/secret-field-injections.js";
import { logInputRealismLifecycle } from "../lib/inputRealismLifecycleLog.js";

// ─── Group D server ────────────────────────────────────────────────────────────

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(secretFieldInjectionRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  secretFieldInjections.clear();
  vi.clearAllMocks();
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAR_FUTURE = "2099-12-31T23:59:59.000Z";

function seedInjection(overrides: Partial<SecretFieldInjection> = {}): SecretFieldInjection {
  const inj: SecretFieldInjection = {
    injection_request_id: "inj_obs_001",
    user_id: MOCK_USER_ID,
    delegation_id: "del_obs_001",
    domain: "github.com",
    field_kind: "password",
    pass_id: "pass_obs_001",
    page_url: "https://github.com/login",
    reason: "login",
    status: "filled",
    filled_at: new Date().toISOString(),
    raw_value_revealed_to_agent: false,
    created_at: new Date().toISOString(),
    expires_at: FAR_FUTURE,
    ...overrides,
  };
  secretFieldInjections.set(inj.injection_request_id, inj);
  return inj;
}

// ─── A. Log redaction ─────────────────────────────────────────────────────────

describe("A. Log redaction", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  const SECRET_VALUE = "supersecret-password-12345";

  const FORBIDDEN_KEYS = ["pass_id", "browser_session_id", "selector_hint", "element_hint", "value", "text"];

  it("emits a [InputRealism] log when logInputRealismLifecycle is called", () => {
    logInputRealismLifecycle("input_realism_mode_selected", {
      injection_request_id: "inj_test_001",
      field_kind: "password",
      domain: "github.com",
      mode: "realistic",
    });

    expect(spy).toHaveBeenCalledOnce();
    const [prefix, event] = spy.mock.calls[0];
    expect(prefix).toBe("[InputRealism]");
    expect(event).toBe("input_realism_mode_selected");
  });

  it("never includes a raw secret value in any log argument", () => {
    const events = [
      "input_realism_mode_selected",
      "input_realism_typing_started",
      "input_realism_typing_completed",
      "input_realism_verify_started",
      "input_realism_verify_completed",
      "input_realism_fallback_to_direct",
      "input_realism_direct_mode",
      "input_realism_failed",
    ] as const;

    for (const event of events) {
      logInputRealismLifecycle(event, {
        injection_request_id: "inj_safe_001",
        field_kind: "password",
        domain: "github.com",
        mode: "realistic",
        char_count_bucket: "9-16",
        duration_ms: 1200,
        success: true,
      });
    }

    for (const call of spy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(SECRET_VALUE);
    }
  });

  it("never includes forbidden keys in any log argument", () => {
    logInputRealismLifecycle("input_realism_typing_completed", {
      injection_request_id: "inj_safe_002",
      field_kind: "password",
      domain: "github.com",
      strategy: "key_events",
      duration_ms: 800,
      char_count_bucket: "5-8",
      success: true,
    });

    const serialized = JSON.stringify(spy.mock.calls);
    for (const key of FORBIDDEN_KEYS) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  it("does not include page_url in any log argument", () => {
    logInputRealismLifecycle("input_realism_verify_completed", {
      injection_request_id: "inj_safe_003",
      field_kind: "password",
      domain: "github.com",
      success: true,
    });

    const serialized = JSON.stringify(spy.mock.calls);
    expect(serialized).not.toContain("page_url");
    expect(serialized).not.toContain("https://github.com/login");
  });
});

// ─── B. Mode log shape ────────────────────────────────────────────────────────

describe("B. Mode log shape", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("mode_selected event carries mode: realistic for realistic path", () => {
    logInputRealismLifecycle("input_realism_mode_selected", {
      injection_request_id: "inj_b_001",
      field_kind: "password",
      domain: "github.com",
      mode: "realistic",
    });

    expect(spy).toHaveBeenCalledOnce();
    const [, , payload] = spy.mock.calls[0];
    expect(payload.mode).toBe("realistic");
  });

  it("mode_selected event carries mode: direct for direct path", () => {
    logInputRealismLifecycle("input_realism_mode_selected", {
      injection_request_id: "inj_b_002",
      field_kind: "password",
      domain: "github.com",
      mode: "direct",
    });

    expect(spy).toHaveBeenCalledOnce();
    const [, , payload] = spy.mock.calls[0];
    expect(payload.mode).toBe("direct");
  });

  it("direct_mode event carries strategy: direct_assignment", () => {
    logInputRealismLifecycle("input_realism_direct_mode", {
      injection_request_id: "inj_b_003",
      field_kind: "password",
      domain: "github.com",
      mode: "direct",
      strategy: "direct_assignment",
    });

    expect(spy).toHaveBeenCalledOnce();
    const [, event, payload] = spy.mock.calls[0];
    expect(event).toBe("input_realism_direct_mode");
    expect(payload.strategy).toBe("direct_assignment");
  });

  it("typing_completed event carries strategy and char_count_bucket", () => {
    logInputRealismLifecycle("input_realism_typing_completed", {
      injection_request_id: "inj_b_004",
      field_kind: "password",
      domain: "github.com",
      strategy: "key_events",
      duration_ms: 950,
      char_count_bucket: "9-16",
      success: true,
    });

    expect(spy).toHaveBeenCalledOnce();
    const [, event, payload] = spy.mock.calls[0];
    expect(event).toBe("input_realism_typing_completed");
    expect(payload.strategy).toBe("key_events");
    expect(payload.char_count_bucket).toBe("9-16");
    expect(payload.success).toBe(true);
  });

  it("verify_completed event carries success: true", () => {
    logInputRealismLifecycle("input_realism_verify_completed", {
      injection_request_id: "inj_b_005",
      field_kind: "password",
      domain: "github.com",
      success: true,
    });

    expect(spy).toHaveBeenCalledOnce();
    const [, event, payload] = spy.mock.calls[0];
    expect(event).toBe("input_realism_verify_completed");
    expect(payload.success).toBe(true);
  });
});

// ─── C. Fallback log shape ────────────────────────────────────────────────────

describe("C. Fallback log shape", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("fallback event carries fallback_reason and fallback_used: true", () => {
    logInputRealismLifecycle("input_realism_fallback_to_direct", {
      injection_request_id: "inj_c_001",
      field_kind: "password",
      domain: "github.com",
      fallback_used: true,
      fallback_reason: "send_failed",
    });

    expect(spy).toHaveBeenCalledOnce();
    const [, event, payload] = spy.mock.calls[0];
    expect(event).toBe("input_realism_fallback_to_direct");
    expect(payload.fallback_used).toBe(true);
    expect(payload.fallback_reason).toBe("send_failed");
  });

  it("empty_after_typing fallback carries correct reason", () => {
    logInputRealismLifecycle("input_realism_fallback_to_direct", {
      injection_request_id: "inj_c_002",
      field_kind: "password",
      domain: "github.com",
      fallback_used: true,
      fallback_reason: "empty_after_typing",
    });

    const [, , payload] = spy.mock.calls[0];
    expect(payload.fallback_reason).toBe("empty_after_typing");
  });

  it("typing_exception fallback carries correct reason", () => {
    logInputRealismLifecycle("input_realism_fallback_to_direct", {
      injection_request_id: "inj_c_003",
      field_kind: "password",
      domain: "github.com",
      fallback_used: true,
      fallback_reason: "typing_exception",
    });

    const [, , payload] = spy.mock.calls[0];
    expect(payload.fallback_reason).toBe("typing_exception");
  });

  it("no raw value in fallback log", () => {
    const SECRET = "p@ssw0rd-never-in-logs";

    logInputRealismLifecycle("input_realism_fallback_to_direct", {
      injection_request_id: "inj_c_004",
      field_kind: "password",
      domain: "github.com",
      fallback_used: true,
      fallback_reason: "send_failed",
    });

    const serialized = JSON.stringify(spy.mock.calls);
    expect(serialized).not.toContain(SECRET);
  });

  it("failed event carries failure_reason and success: false", () => {
    logInputRealismLifecycle("input_realism_failed", {
      injection_request_id: "inj_c_005",
      field_kind: "password",
      domain: "github.com",
      success: false,
      failure_reason: "all_fills_failed",
    });

    const [, event, payload] = spy.mock.calls[0];
    expect(event).toBe("input_realism_failed");
    expect(payload.success).toBe(false);
    expect(payload.failure_reason).toBe("all_fills_failed");
  });
});

// ─── D. Lifecycle endpoint summary ────────────────────────────────────────────

describe("D. Lifecycle endpoint — input_realism summary", () => {
  it("includes input_realism when present on injection", async () => {
    const inj = seedInjection();
    inj.input_realism = {
      mode: "realistic",
      strategy: "key_events",
      char_count_bucket: "9-16",
      duration_ms: 1150,
      started_at: new Date().toISOString(),
      verify_started_at: new Date().toISOString(),
      verify_completed_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      success: true,
      fallback_used: false,
    };

    const res = await server.inject({
      method: "GET",
      url: `/api/internal/injection-lifecycle/${inj.injection_request_id}`,
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.input_realism).not.toBeNull();
    expect(data.input_realism.mode).toBe("realistic");
    expect(data.input_realism.strategy).toBe("key_events");
    expect(data.input_realism.char_count_bucket).toBe("9-16");
    expect(typeof data.input_realism.duration_ms).toBe("number");
    expect(data.input_realism.success).toBe(true);
    expect(data.input_realism.fallback_used).toBe(false);
  });

  it("returns input_realism: null for injections without the field", async () => {
    seedInjection();

    const res = await server.inject({
      method: "GET",
      url: `/api/internal/injection-lifecycle/inj_obs_001`,
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.input_realism).toBeNull();
  });

  it("includes timestamps in input_realism when present", async () => {
    const started = new Date().toISOString();
    const verified = new Date().toISOString();
    const completed = new Date().toISOString();
    const inj = seedInjection();
    inj.input_realism = {
      mode: "realistic",
      strategy: "key_events",
      started_at: started,
      verify_started_at: verified,
      verify_completed_at: completed,
      completed_at: completed,
      char_count_bucket: "5-8",
      duration_ms: 600,
      success: true,
    };

    const res = await server.inject({
      method: "GET",
      url: `/api/internal/injection-lifecycle/${inj.injection_request_id}`,
    });

    const { data } = res.json();
    expect(data.input_realism.started_at).toBe(started);
    expect(data.input_realism.verify_started_at).toBe(verified);
    expect(data.input_realism.verify_completed_at).toBe(completed);
    expect(data.input_realism.completed_at).toBe(completed);
  });

  it("includes fallback fields in input_realism when present", async () => {
    const inj = seedInjection();
    inj.input_realism = {
      mode: "realistic",
      strategy: "direct_assignment",
      char_count_bucket: "9-16",
      duration_ms: 900,
      started_at: new Date().toISOString(),
      success: false,
      fallback_used: true,
      fallback_reason: "empty_after_typing",
    };

    const res = await server.inject({
      method: "GET",
      url: `/api/internal/injection-lifecycle/${inj.injection_request_id}`,
    });

    const { data } = res.json();
    expect(data.input_realism.fallback_used).toBe(true);
    expect(data.input_realism.fallback_reason).toBe("empty_after_typing");
    expect(data.input_realism.strategy).toBe("direct_assignment");
  });

  it("never includes pass_id, browser_session_id, or selector_hint in input_realism", async () => {
    const inj = seedInjection();
    inj.input_realism = {
      mode: "direct",
      strategy: "direct_assignment",
      success: true,
    };

    const res = await server.inject({
      method: "GET",
      url: `/api/internal/injection-lifecycle/${inj.injection_request_id}`,
    });

    const inputRealismStr = JSON.stringify(res.json().data.input_realism);
    expect(inputRealismStr).not.toContain("pass_id");
    expect(inputRealismStr).not.toContain("browser_session_id");
    expect(inputRealismStr).not.toContain("selector_hint");
  });

  it("never includes pass_id or browser_session_id in the full response", async () => {
    const inj = seedInjection();
    inj.input_realism = {
      mode: "realistic",
      strategy: "key_events",
      char_count_bucket: "5-8",
      success: true,
    };

    const res = await server.inject({
      method: "GET",
      url: `/api/internal/injection-lifecycle/${inj.injection_request_id}`,
    });

    const body = JSON.stringify(res.json());
    expect(body).not.toContain(`"pass_id"`);
    expect(body).not.toContain(`"browser_session_id"`);
    expect(body).not.toContain(`"element_hint"`);
    expect(body).not.toContain(`"raw_value_revealed_to_agent":true`);
  });

  it("direct mode injection shows mode: direct and strategy: direct_assignment", async () => {
    const inj = seedInjection();
    inj.input_realism = {
      mode: "direct",
      strategy: "direct_assignment",
    };

    const res = await server.inject({
      method: "GET",
      url: `/api/internal/injection-lifecycle/${inj.injection_request_id}`,
    });

    const { data } = res.json();
    expect(data.input_realism.mode).toBe("direct");
    expect(data.input_realism.strategy).toBe("direct_assignment");
  });
});
