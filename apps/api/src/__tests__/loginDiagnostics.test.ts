import { describe, it, expect, beforeEach } from "vitest";
import { classifyLoginOutcome, storeDiagnostic, loginDiagnosticsStore } from "../lib/loginDiagnostics.js";

beforeEach(() => {
  loginDiagnosticsStore.clear();
});

// ─── classifyLoginOutcome — known patterns ────────────────────────────────────

describe("classifyLoginOutcome — invalid_credentials", () => {
  it.each([
    ["Incorrect username or password."],
    ["incorrect password"],
    ["Invalid credentials"],
    ["Wrong password. Please try again."],
    ["Authentication failed. Check your email or password."],
    ["Sign in failed"],
  ])('classifies "%s" as invalid_credentials', (signal) => {
    const result = classifyLoginOutcome([signal]);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("invalid_credentials");
    expect(result!.raw_secret_revealed_to_agent).toBe(false);
  });

  it("includes matched pattern in signals_detected", () => {
    const result = classifyLoginOutcome(["Incorrect username or password"]);
    expect(result!.signals_detected).toContain("incorrect username or password");
  });
});

describe("classifyLoginOutcome — manual_challenge_required", () => {
  it.each([
    ["Two-factor authentication required"],
    ["Please enter your 2FA code"],
    ["Enter the verification code we sent to your email"],
    ["Confirm it's you — enter the code from your authenticator app"],
    ["You have a passkey registered for this account"],
    ["Use your security key to continue"],
    ["We need to verify your identity"],
  ])('classifies "%s" as manual_challenge_required', (signal) => {
    const result = classifyLoginOutcome([signal]);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("manual_challenge_required");
    expect(result!.raw_secret_revealed_to_agent).toBe(false);
  });
});

describe("classifyLoginOutcome — captcha_required", () => {
  it.each([
    ["Please complete the CAPTCHA to continue"],
    ["I'm not a robot"],
    ["Prove you're human"],
    ["Cloudflare · Check your browser"],
    ["Complete the security check"],
  ])('classifies "%s" as captcha_required', (signal) => {
    const result = classifyLoginOutcome([signal]);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("captcha_required");
    expect(result!.raw_secret_revealed_to_agent).toBe(false);
  });
});

describe("classifyLoginOutcome — rate_limited", () => {
  it.each([
    ["Too many attempts. Please wait a few minutes."],
    ["Too many requests — slow down"],
    ["Your account has been locked due to too many failed login attempts"],
    ["Rate limit exceeded. Try again later."],
    ["Temporarily blocked"],
    ["Wait before trying again"],
  ])('classifies "%s" as rate_limited', (signal) => {
    const result = classifyLoginOutcome([signal]);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("rate_limited");
    expect(result!.raw_secret_revealed_to_agent).toBe(false);
  });
});

// ─── classifyLoginOutcome — null / success cases ──────────────────────────────

describe("classifyLoginOutcome — returns null for non-failure pages", () => {
  it("returns null for empty signals", () => {
    expect(classifyLoginOutcome([])).toBeNull();
  });

  it("returns null for whitespace-only signals", () => {
    expect(classifyLoginOutcome(["   ", ""])).toBeNull();
  });

  it("returns null when page looks like a dashboard (success)", () => {
    const result = classifyLoginOutcome(["Welcome to your dashboard", "Home feed", "Notifications"]);
    expect(result).toBeNull();
  });

  it("returns null when page has both login and success signals (navigated away)", () => {
    const result = classifyLoginOutcome(["Sign in · GitHub", "Welcome, you are now logged in"]);
    expect(result).toBeNull();
  });
});

// ─── classifyLoginOutcome — unknown_failure ───────────────────────────────────

describe("classifyLoginOutcome — unknown_failure fallback", () => {
  it("classifies a login page with unrecognized error text as unknown_failure", () => {
    const result = classifyLoginOutcome(["Sign in to continue", "Something went wrong. Please try again."]);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("unknown_failure");
    expect(result!.raw_secret_revealed_to_agent).toBe(false);
  });
});

// ─── Security invariants ──────────────────────────────────────────────────────

describe("result safety — no credentials, cookies, or secret refs", () => {
  const FORBIDDEN_KEYS = ["password", "cookie", "session_storage", "secret_ref", "raw_value", "kms"];

  it("invalid_credentials result contains no forbidden keys", () => {
    const result = classifyLoginOutcome(["Incorrect username or password"]);
    const body = JSON.stringify(result);
    for (const key of FORBIDDEN_KEYS) {
      expect(body).not.toContain(`"${key}":`);
    }
  });

  it("manual_challenge_required result contains no forbidden keys", () => {
    const result = classifyLoginOutcome(["Two-factor authentication required"]);
    const body = JSON.stringify(result);
    for (const key of FORBIDDEN_KEYS) {
      expect(body).not.toContain(`"${key}":`);
    }
  });

  it("raw_secret_revealed_to_agent is always the literal false — never truthy", () => {
    const codes = [
      ["Incorrect username or password"],
      ["Two-factor authentication required"],
      ["captcha required"],
      ["too many attempts"],
      ["Sign in", "Something went wrong"],
    ];
    for (const signals of codes) {
      const result = classifyLoginOutcome(signals);
      if (result) {
        expect(result.raw_secret_revealed_to_agent).toBe(false);
        expect(result.raw_secret_revealed_to_agent).not.toBe(true);
      }
    }
  });
});

// ─── storeDiagnostic ─────────────────────────────────────────────────────────

describe("storeDiagnostic", () => {
  it("persists to loginDiagnosticsStore", () => {
    storeDiagnostic({
      user_id: "user_001",
      browser_session_id: "tbs_001",
      delegation_id: "del_001",
      domain: "github.com",
      pass_label: "GitHub · testuser",
      related_pass_id: "vp_001",
      outcome: "invalid_credentials",
      user_message: "Test message",
      recommended_action: "Update your password.",
      signals_detected: ["incorrect username or password"],
      raw_secret_revealed_to_agent: false,
    });
    expect(loginDiagnosticsStore.size).toBe(1);
    const stored = Array.from(loginDiagnosticsStore.values())[0];
    expect(stored.outcome).toBe("invalid_credentials");
    expect(stored.diagnostic_id).toMatch(/^ldiag_/);
    expect(stored.detected_at).toBeTruthy();
    expect(stored.raw_secret_revealed_to_agent).toBe(false);
  });

  it("evicts oldest entry when store exceeds 50", () => {
    for (let i = 0; i < 51; i++) {
      storeDiagnostic({
        user_id: "user_001",
        browser_session_id: `tbs_${i}`,
        domain: "example.com",
        outcome: "unknown_failure",
        user_message: "msg",
        recommended_action: "retry",
        signals_detected: [],
        raw_secret_revealed_to_agent: false,
      });
    }
    expect(loginDiagnosticsStore.size).toBe(50);
  });
});
