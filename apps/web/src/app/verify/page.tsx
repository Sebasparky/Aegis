"use client";

import { useState, useEffect } from "react";
import {
  listVerificationCards,
  listVerificationTypes,
  getVerificationCard,
  verifyVerificationCard,
  revokeVerificationCard,
  createVerificationSession,
  completeVerificationSession,
  createEmailVerificationSession,
  submitVerificationCode,
  createExternalVerificationSession,
  mockCompleteExternalSession,
  syncExternalVerificationSession,
} from "@/lib/api";
import type {
  VerificationCardSummary,
  VerificationCardDetail,
  ExternalVerificationHandoffView,
  ExternalVerificationProviderDescriptor,
} from "@/lib/api";
import type { VerificationType } from "@aegis/types";

// ─── Static capability metadata ──────────────────────────────────────────────

type CapabilityDef = {
  type: VerificationType;
  title: string;
  description: string;
  agentCanProve: string;
  agentNeverReceives: string;
  useCases: string[];
  assuranceLabel: string;
};

const CAPABILITIES: CapabilityDef[] = [
  {
    type: "email_ownership",
    title: "Email Ownership",
    description:
      "Let agents prove you control an email domain or address for account recovery, signup checks, and lightweight identity.",
    agentCanProve: "Signed email_ownership claim with verified domain",
    agentNeverReceives: "Email inbox content, messages, or recovery codes",
    useCases: ["Account recovery flows", "Signup eligibility", "Email-verified identity"],
    assuranceLabel: "Provider verified",
  },
  {
    type: "student_status",
    title: "Student Status",
    description:
      "Let agents prove you are a student for discounts, student-only services, and academic workflows.",
    agentCanProve: "Signed student_status claim with institution and enrollment",
    agentNeverReceives: "Student ID card, transcript, GPA, or full identity document",
    useCases: ["Student discounts", "Academic eligibility", "Student-only workflows"],
    assuranceLabel: "Provider verified",
  },
  {
    type: "government_id",
    title: "Government ID",
    description:
      "Let agents prove a provider-backed identity check exists without exposing your ID image or document number.",
    agentCanProve: "Signed government_id claim with country and ID type",
    agentNeverReceives: "ID image, document number, SSN, DOB, legal name, or address",
    useCases: ["Age verification", "Identity-gated services", "KYC-adjacent flows"],
    assuranceLabel: "Document verified",
  },
  {
    type: "phone_ownership",
    title: "Phone Ownership",
    description:
      "Let agents prove you control a phone number for signup or account recovery flows.",
    agentCanProve: "Signed phone_ownership claim with country code",
    agentNeverReceives: "Phone number, SMS messages, or call logs",
    useCases: ["Phone-verified signup", "Account recovery", "Two-factor eligibility"],
    assuranceLabel: "Provider verified",
  },
  {
    type: "military_status",
    title: "Military / Veteran",
    description:
      "Let agents prove eligibility for military or veteran benefits through a provider-backed claim.",
    agentCanProve: "Signed military_status claim with branch",
    agentNeverReceives: "Service records, discharge papers, or personal military data",
    useCases: ["Military discounts", "Veteran eligibility", "Defense sector access"],
    assuranceLabel: "Provider verified",
  },
  {
    type: "business_org_control",
    title: "Business / Org Control",
    description:
      "Let agents prove you control or represent a business or organization.",
    agentCanProve: "Signed business_control claim with business name",
    agentNeverReceives: "Business registration docs, EIN, or financial records",
    useCases: ["B2B onboarding", "Business account creation", "Org-verified workflows"],
    assuranceLabel: "Provider verified",
  },
  {
    type: "domain_ownership",
    title: "Domain Ownership",
    description:
      "Let agents prove you control a web domain through DNS or site verification.",
    agentCanProve: "Signed domain_ownership claim with verified domain",
    agentNeverReceives: "DNS zone data, hosting credentials, or server access",
    useCases: ["Developer identity", "Domain-verified signup", "Website ownership proofs"],
    assuranceLabel: "Provider verified",
  },
  {
    type: "employment_status",
    title: "Employment Status",
    description:
      "Let agents prove employment or professional eligibility through a provider-backed claim.",
    agentCanProve: "Signed employment_status claim",
    agentNeverReceives: "Salary, employment contract, performance reviews, or HR data",
    useCases: ["Professional eligibility", "Employee discounts", "Workplace benefit access"],
    assuranceLabel: "Provider verified",
  },
];

// ─── Repeatable types ─────────────────────────────────────────────────────────

const REPEATABLE_VERIFICATION_TYPES: VerificationType[] = [
  "email_ownership",
  "phone_ownership",
  "student_status",
  "employment_status",
  "domain_ownership",
  "business_org_control",
];

// ─── Verification group ───────────────────────────────────────────────────────

type VerificationGroup = {
  type: VerificationType;
  def: CapabilityDef;
  activeCards: VerificationCardSummary[];
  revokedCards: VerificationCardSummary[];
  expiredCards: VerificationCardSummary[];
  bestActiveCard?: VerificationCardSummary;
  latestRevokedCard?: VerificationCardSummary;
  latestExpiredCard?: VerificationCardSummary;
  mockProvider?: string;
  realProvider?: string;
  externalProvider?: ExternalVerificationProviderDescriptor;
  state: "active" | "revoked" | "expired" | "not_verified" | "coming_soon";
  repeatable: boolean;
};

function isExpired(card: VerificationCardSummary): boolean {
  if (!card.expires_at) return false;
  return Date.now() > new Date(card.expires_at).getTime();
}

function byIssuedDesc(a: VerificationCardSummary, b: VerificationCardSummary) {
  return new Date(b.issued_at).getTime() - new Date(a.issued_at).getTime();
}

function buildVerificationGroups(
  cards: VerificationCardSummary[],
  providers: { name: string; supported_types: VerificationType[] }[],
  externalProviders: ExternalVerificationProviderDescriptor[],
): VerificationGroup[] {
  return CAPABILITIES.map((def) => {
    const forType = cards.filter((c) => c.claim_types.includes(def.type));

    const activeCards = forType
      .filter((c) => c.revocation_status === "active" && !isExpired(c))
      .sort(byIssuedDesc);
    const expiredCards = forType
      .filter((c) => c.revocation_status === "active" && isExpired(c))
      .sort(byIssuedDesc);
    const revokedCards = forType
      .filter((c) => c.revocation_status === "revoked")
      .sort(byIssuedDesc);

    const bestActiveCard = activeCards[0];
    const latestRevokedCard = revokedCards[0];
    const latestExpiredCard = expiredCards[0];

    const mockProviderEntry = providers.find(
      (p) => p.name.startsWith("mock_") && p.supported_types.includes(def.type),
    );
    const mockProvider = mockProviderEntry?.name;

    const realProviderEntry = providers.find(
      (p) => !p.name.startsWith("mock_") && p.supported_types.includes(def.type),
    );
    const realProvider = realProviderEntry?.name;

    const externalProvider = externalProviders.find((p) =>
      p.supported_types.includes(def.type),
    );

    let state: VerificationGroup["state"];
    if (activeCards.length > 0) state = "active";
    else if (expiredCards.length > 0) state = "expired";
    else if (revokedCards.length > 0) state = "revoked";
    else if (mockProvider || realProvider || !!externalProvider) state = "not_verified";
    else state = "coming_soon";

    const repeatable = REPEATABLE_VERIFICATION_TYPES.includes(def.type);

    return {
      type: def.type,
      def,
      activeCards,
      revokedCards,
      expiredCards,
      bestActiveCard,
      latestRevokedCard,
      latestExpiredCard,
      mockProvider,
      realProvider,
      externalProvider,
      state,
      repeatable,
    };
  });
}

function groupCountLabel(group: VerificationGroup): string {
  const n = group.activeCards.length;
  const labels: Partial<Record<VerificationType, [string, string]>> = {
    email_ownership: ["verified email", "verified emails"],
    phone_ownership: ["verified phone", "verified phones"],
    student_status: ["student verification", "student verifications"],
    employment_status: ["employment verification", "employment verifications"],
    domain_ownership: ["verified domain", "verified domains"],
    business_org_control: ["org verification", "org verifications"],
    government_id: ["government ID", "government IDs"],
    military_status: ["military verification", "military verifications"],
  };
  const pair = labels[group.type] ?? ["verification", "verifications"];
  return `${n} ${n === 1 ? pair[0] : pair[1]}`;
}

function addAnotherLabel(type: VerificationType): string {
  const labels: Partial<Record<VerificationType, string>> = {
    email_ownership: "Add another email",
    phone_ownership: "Add another phone",
    student_status: "Add another student verification",
    employment_status: "Add another employer",
    domain_ownership: "Add another domain",
    business_org_control: "Add another org",
  };
  return labels[type] ?? "Add another";
}

// ─── OTP flow state ───────────────────────────────────────────────────────────

type OtpFlowState =
  | { phase: "idle" }
  | { phase: "email_input"; type: VerificationType; providerName: string }
  | { phase: "otp_input"; sessionId: string; deliveryMode?: "email" | "dev_console" };

// ─── External handoff flow state ──────────────────────────────────────────────

type HandoffFlow =
  | { phase: "idle" }
  | { phase: "active"; sessionId: string; handoff: ExternalVerificationHandoffView };

// ─── Handoff CTA labels ───────────────────────────────────────────────────────

const HANDOFF_CTA: Partial<Record<VerificationType, string>> = {
  student_status: "Verify student status",
  military_status: "Verify military status",
  government_id: "Verify identity",
};

// ─── Other types ─────────────────────────────────────────────────────────────

type Tab = "all" | "verified" | "available" | "revoked";

type VerifyResult = {
  hash_valid: boolean;
  signature_valid: boolean;
  expired: boolean;
  revoked: boolean;
  jws_present: boolean;
  error?: string;
};

type MockForm = {
  email_domain?: string;
  institution_name?: string;
  enrollment_status?: string;
  country_code?: string;
  id_type?: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assuranceBadgeClass(level?: string) {
  if (level === "document_verified") return "a-status a-status--blue";
  if (level === "provider_verified") return "a-status a-status--green";
  return "a-status a-status--graphite";
}

function buildMockInput(type: VerificationType, form: MockForm): Record<string, string> {
  if (type === "email_ownership") {
    const raw = form.email_domain ?? "example.com";
    const email_domain = raw.includes("@") ? (raw.split("@")[1] ?? raw) : raw;
    return { email_domain };
  }
  if (type === "student_status")
    return {
      institution_name: form.institution_name ?? "University of Michigan",
      enrollment_status: form.enrollment_status ?? "active",
    };
  if (type === "government_id")
    return {
      country_code: form.country_code ?? "US",
      id_type: form.id_type ?? "drivers_license",
    };
  return {};
}

function fmt(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatBox({ label, value, color }: { label: string; value: number; color: string }) {
  const colorMap: Record<string, string> = {
    green: "oklch(0.42 0.09 150)",
    blue: "oklch(0.42 0.09 240)",
    red: "oklch(0.45 0.13 25)",
    graphite: "var(--ink-2)",
  };
  return (
    <div
      style={{
        textAlign: "center",
        padding: "12px 16px",
        background: "rgba(255,255,255,0.5)",
        border: "1px solid var(--hairline)",
        borderRadius: "var(--r-2)",
        minWidth: 80,
      }}
    >
      <div
        style={{
          fontSize: 28,
          fontWeight: 600,
          color: colorMap[color] ?? "var(--ink-1)",
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 3, whiteSpace: "nowrap" }}>
        {label}
      </div>
    </div>
  );
}

function normalizeClaimValue(key: string, value: string): string {
  if (key === "email_domain" && value.includes("@")) return value.split("@")[1] ?? value;
  return value;
}

function ClaimValueDisplay({ value }: { value: Record<string, string> }) {
  const entries = Object.entries(value).filter(([k]) => k !== "kind");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: "flex", gap: 8, fontSize: 12 }}>
          <span style={{ color: "var(--ink-4)", minWidth: 120, textTransform: "capitalize" }}>
            {k.replace(/_/g, " ")}
          </span>
          <span style={{ color: "var(--ink-1)", fontWeight: 500 }}>{normalizeClaimValue(k, String(v))}</span>
        </div>
      ))}
    </div>
  );
}

function VerifyResultBadge({ result }: { result: VerifyResult }) {
  const ok = result.hash_valid && result.signature_valid;
  return (
    <div
      style={{
        marginTop: 10,
        padding: "10px 12px",
        background: ok ? "var(--green-soft)" : "var(--amber-soft)",
        border: `1px solid ${ok ? "var(--green-ring)" : "oklch(0.86 0.07 75)"}`,
        borderRadius: "var(--r-1)",
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4, color: "var(--ink-1)" }}>
        Signature verification
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <span>{result.hash_valid ? "✓ Hash valid" : "✗ Hash invalid"}</span>
        <span>
          {result.jws_present
            ? result.signature_valid
              ? "✓ Signature valid"
              : "✗ Signature invalid"
            : "— No JWS (unsigned)"}
        </span>
        {result.expired && <span style={{ color: "var(--amber)" }}>Expired</span>}
        {result.error && <span style={{ color: "var(--red)" }}>{result.error}</span>}
      </div>
    </div>
  );
}

function CardDetailPanel({
  detail,
  loading,
}: {
  detail: VerificationCardDetail | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div style={{ padding: "16px 0", color: "var(--ink-3)", fontSize: 13 }}>
        Loading details…
      </div>
    );
  }
  if (!detail) return null;

  return (
    <div
      style={{
        marginTop: 12,
        padding: 14,
        background: "var(--bg-2)",
        border: "1px solid var(--hairline)",
        borderRadius: "var(--r-1)",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {detail.claims.map((claim) => (
          <div key={claim.claim_id}>
            <div
              style={{
                fontWeight: 600,
                marginBottom: 6,
                color: "var(--ink-2)",
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {claim.claim_type.replace(/_/g, " ")}
            </div>
            <ClaimValueDisplay value={claim.claim_value} />
            <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <span className={assuranceBadgeClass(claim.assurance_level)} style={{ fontSize: 10 }}>
                {claim.assurance_level?.replace(/_/g, " ")}
              </span>
              <span style={{ color: "var(--ink-4)" }}>Verified {fmt(claim.verified_at)}</span>
              {claim.expires_at && (
                <span style={{ color: "var(--ink-4)" }}>Expires {fmt(claim.expires_at)}</span>
              )}
            </div>
          </div>
        ))}

        <div>
          <div
            style={{
              fontWeight: 600,
              marginBottom: 6,
              color: "var(--ink-2)",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Privacy guarantees
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ color: "oklch(0.42 0.09 150)" }}>✓ Raw document not revealed to agent</span>
            <span style={{ color: "oklch(0.42 0.09 150)" }}>✓ Raw document not revealed to website</span>
            <span style={{ color: "oklch(0.42 0.09 150)" }}>✓ Provider result only</span>
            <span style={{ color: "var(--ink-4)" }}>ⓘ Not a guarantee of identity</span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: "var(--ink-4)" }}>
          <span>
            ID: <span style={{ fontFamily: "monospace" }}>{detail.card_id}</span>
          </span>
          <span>Disclosure: {detail.disclosure_policy.replace(/_/g, " ")}</span>
          <span>Issued: {fmt(detail.issued_at)}</span>
        </div>
      </div>
    </div>
  );
}

function MockVerifyForm({
  type,
  form,
  onChange,
  onSubmit,
  onCancel,
  submitting,
  error,
  isReverify,
}: {
  type: VerificationType;
  form: MockForm;
  onChange: (f: MockForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitting: boolean;
  error: string | null;
  isReverify?: boolean;
}) {
  const inputStyle = {
    width: "100%",
    padding: "7px 10px",
    border: "1px solid var(--hairline)",
    borderRadius: "var(--r-1)",
    fontSize: 13,
    background: "var(--paper)",
    color: "var(--ink-1)",
    boxSizing: "border-box" as const,
  };
  const labelStyle = { fontSize: 11, color: "var(--ink-3)", marginBottom: 4, display: "block" };
  const cap = CAPABILITIES.find((c) => c.type === type);

  return (
    <div
      style={{
        marginTop: 14,
        padding: 16,
        background: "var(--bg-2)",
        border: "1px solid var(--hairline)",
        borderRadius: "var(--r-1)",
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12, color: "var(--ink-1)" }}>
        {isReverify ? "Re-verify" : "Mock verify"} — {cap?.title}
      </div>

      {type === "email_ownership" && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Email domain</label>
          <input
            style={inputStyle}
            placeholder="example.com"
            value={form.email_domain ?? ""}
            onChange={(e) => onChange({ ...form, email_domain: e.target.value })}
          />
        </div>
      )}

      {type === "student_status" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>Institution name</label>
            <input
              style={inputStyle}
              value={form.institution_name ?? "University of Michigan"}
              onChange={(e) => onChange({ ...form, institution_name: e.target.value })}
            />
          </div>
          <div>
            <label style={labelStyle}>Enrollment status</label>
            <select
              style={{ ...inputStyle, height: 34 }}
              value={form.enrollment_status ?? "active"}
              onChange={(e) => onChange({ ...form, enrollment_status: e.target.value })}
            >
              <option value="active">Active</option>
              <option value="part_time">Part-time</option>
              <option value="graduated">Graduated</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>
      )}

      {type === "government_id" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
          <div
            style={{
              padding: "8px 10px",
              background: "var(--amber-soft)",
              borderRadius: "var(--r-1)",
              fontSize: 12,
              color: "oklch(0.45 0.12 75)",
              marginBottom: 4,
            }}
          >
            This mock does not upload or store an ID document.
          </div>
          <div>
            <label style={labelStyle}>Country code</label>
            <input
              style={inputStyle}
              value={form.country_code ?? "US"}
              onChange={(e) => onChange({ ...form, country_code: e.target.value })}
            />
          </div>
          <div>
            <label style={labelStyle}>ID type</label>
            <select
              style={{ ...inputStyle, height: 34 }}
              value={form.id_type ?? "drivers_license"}
              onChange={(e) => onChange({ ...form, id_type: e.target.value })}
            >
              <option value="drivers_license">Driver&apos;s license</option>
              <option value="passport">Passport</option>
              <option value="national_id">National ID</option>
            </select>
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginBottom: 10, color: "var(--red)", fontSize: 12 }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="a-btn a-btn--primary"
          style={{ fontSize: 12 }}
          onClick={onSubmit}
          disabled={submitting}
        >
          {submitting ? "Verifying…" : isReverify ? "Re-verify" : "Mock verify"}
        </button>
        <button
          className="a-btn a-btn--ghost"
          style={{ fontSize: 12 }}
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── EmailOtpModal ────────────────────────────────────────────────────────────

function EmailOtpModal({
  phase,
  emailInput,
  otpInput,
  onEmailChange,
  onOtpChange,
  onSubmitEmail,
  onSubmitOtp,
  onCancel,
  submitting,
  error,
  deliveryMode,
}: {
  phase: "email_input" | "otp_input";
  emailInput: string;
  otpInput: string;
  onEmailChange: (v: string) => void;
  onOtpChange: (v: string) => void;
  onSubmitEmail: () => void;
  onSubmitOtp: () => void;
  onCancel: () => void;
  submitting: boolean;
  error: string | null;
  deliveryMode?: "email" | "dev_console";
}) {
  const inputStyle = {
    width: "100%",
    padding: "7px 10px",
    border: "1px solid var(--hairline)",
    borderRadius: "var(--r-1)",
    fontSize: 13,
    background: "var(--paper)",
    color: "var(--ink-1)",
    boxSizing: "border-box" as const,
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          background: "var(--paper)",
          border: "1px solid var(--hairline)",
          borderRadius: "var(--r-2)",
          padding: 24,
          width: "100%",
          maxWidth: 420,
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        }}
      >
        {phase === "email_input" ? (
          <>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6, color: "var(--ink-1)" }}>
              Verify email ownership
            </div>
            <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 16px", lineHeight: 1.5 }}>
              Enter your email address. A 6-digit one-time code will be sent for verification.
            </p>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: "var(--ink-3)", display: "block", marginBottom: 4 }}>
                Email address
              </label>
              <input
                type="email"
                style={inputStyle}
                placeholder="you@example.com"
                value={emailInput}
                onChange={(e) => onEmailChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !submitting) onSubmitEmail(); }}
                autoFocus
              />
            </div>
            {error && (
              <div style={{ marginBottom: 10, color: "var(--red)", fontSize: 12 }}>{error}</div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="a-btn a-btn--primary"
                style={{ fontSize: 13 }}
                onClick={onSubmitEmail}
                disabled={submitting || !emailInput.trim()}
              >
                {submitting ? "Sending…" : "Send code"}
              </button>
              <button
                className="a-btn a-btn--ghost"
                style={{ fontSize: 13 }}
                onClick={onCancel}
                disabled={submitting}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6, color: "var(--ink-1)" }}>
              Enter verification code
            </div>
            <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 16px", lineHeight: 1.5 }}>
              {deliveryMode === "email"
                ? "Check your email for a 6-digit code."
                : "Development mode: the code was printed in the API console."}
            </p>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, color: "var(--ink-3)", display: "block", marginBottom: 4 }}>
                6-digit code
              </label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                style={{
                  ...inputStyle,
                  fontSize: 22,
                  fontFamily: "monospace",
                  letterSpacing: "0.25em",
                  textAlign: "center",
                }}
                placeholder="000000"
                value={otpInput}
                onChange={(e) => onOtpChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => { if (e.key === "Enter" && !submitting) onSubmitOtp(); }}
                autoFocus
              />
            </div>
            {error && (
              <div style={{ marginBottom: 10, color: "var(--red)", fontSize: 12 }}>{error}</div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="a-btn a-btn--primary"
                style={{ fontSize: 13 }}
                onClick={onSubmitOtp}
                disabled={submitting || otpInput.length !== 6}
              >
                {submitting ? "Verifying…" : "Verify"}
              </button>
              <button
                className="a-btn a-btn--ghost"
                style={{ fontSize: 13 }}
                onClick={onCancel}
                disabled={submitting}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── GroupCard (Current Verifications — one per active VerificationType) ──────

function GroupCard({
  group,
  expandedCardId,
  cardDetails,
  loadingDetailId,
  revokingId,
  verifyingId,
  verifyResults,
  groupExpanded,
  mockVerifying,
  mockForm,
  submitting,
  submitError,
  onVerifyCard,
  onRevokeCard,
  onToggleCardDetail,
  onStartMock,
  onStartReal,
  onStartHandoff,
  onChangeMockForm,
  onSubmitMock,
  onCancelMock,
  onToggleGroupExpanded,
}: {
  group: VerificationGroup;
  expandedCardId: string | null;
  cardDetails: Record<string, VerificationCardDetail>;
  loadingDetailId: string | null;
  revokingId: string | null;
  verifyingId: string | null;
  verifyResults: Record<string, VerifyResult>;
  groupExpanded: boolean;
  mockVerifying: boolean;
  mockForm: MockForm;
  submitting: boolean;
  submitError: string | null;
  onVerifyCard: (cardId: string) => void;
  onRevokeCard: (cardId: string) => void;
  onToggleCardDetail: (cardId: string) => void;
  onStartMock: () => void;
  onStartReal: () => void;
  onStartHandoff: () => void;
  onChangeMockForm: (f: MockForm) => void;
  onSubmitMock: () => void;
  onCancelMock: () => void;
  onToggleGroupExpanded: () => void;
}) {
  const { def, activeCards, bestActiveCard, repeatable, mockProvider, realProvider, externalProvider } = group;
  const isSingle = activeCards.length === 1;

  return (
    <div
      className="a-card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 0,
        borderTop: "3px solid oklch(0.62 0.09 150)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, color: "var(--ink-1)", marginBottom: 6 }}>
            {def.title}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="a-status a-status--green">
              <span className="a-status__dot" />
              Active
            </span>
            <span
              style={{
                fontSize: 11,
                padding: "2px 8px",
                background: "oklch(0.93 0.01 150)",
                borderRadius: 999,
                color: "oklch(0.38 0.08 150)",
                fontWeight: 500,
              }}
            >
              {groupCountLabel(group)}
            </span>
            {bestActiveCard?.assurance_level && (
              <span
                className={assuranceBadgeClass(bestActiveCard.assurance_level)}
                style={{ fontSize: 10 }}
              >
                {bestActiveCard.assurance_level.replace(/_/g, " ")}
              </span>
            )}
            {bestActiveCard?.jws_present && (
              <span className="a-status a-status--graphite" style={{ fontSize: 10 }}>
                Signed
              </span>
            )}
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--ink-4)", textAlign: "right", flexShrink: 0 }}>
          {fmt(bestActiveCard?.issued_at)}
        </div>
      </div>

      {/* Body */}
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 8 }}>
        <span style={{ color: "oklch(0.42 0.09 150)", fontWeight: 500 }}>Agents can prove: </span>
        {def.agentCanProve}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-4)", marginBottom: 12 }}>
        Never shared: {def.agentNeverReceives}
      </div>

      {/* Single-card: verify result + detail panel */}
      {isSingle && bestActiveCard && (
        <>
          {verifyResults[bestActiveCard.card_id] && (
            <VerifyResultBadge result={verifyResults[bestActiveCard.card_id]} />
          )}
          {expandedCardId === bestActiveCard.card_id && (
            <CardDetailPanel
              detail={cardDetails[bestActiveCard.card_id] ?? null}
              loading={loadingDetailId === bestActiveCard.card_id}
            />
          )}
        </>
      )}

      {/* Multi-card: expanded list */}
      {!isSingle && groupExpanded && (
        <div
          style={{
            marginBottom: 10,
            paddingTop: 10,
            borderTop: "1px solid var(--hairline)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {activeCards.map((card) => (
            <div
              key={card.card_id}
              style={{
                padding: "8px 10px",
                background: "var(--bg-2)",
                borderRadius: "var(--r-1)",
                border: "1px solid var(--hairline)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="a-status a-status--green" style={{ fontSize: 10 }}>
                    <span className="a-status__dot" />
                    Active
                  </span>
                  {card.assurance_level && (
                    <span
                      className={assuranceBadgeClass(card.assurance_level)}
                      style={{ fontSize: 10 }}
                    >
                      {card.assurance_level.replace(/_/g, " ")}
                    </span>
                  )}
                  <span style={{ fontSize: 11, color: "var(--ink-4)" }}>{fmt(card.issued_at)}</span>
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button
                    className="a-btn a-btn--ghost"
                    style={{ fontSize: 10 }}
                    onClick={() => onToggleCardDetail(card.card_id)}
                    disabled={loadingDetailId === card.card_id}
                  >
                    {expandedCardId === card.card_id ? "Hide" : "Details"}
                  </button>
                  <button
                    className="a-btn a-btn--danger"
                    style={{ fontSize: 10 }}
                    onClick={() => onRevokeCard(card.card_id)}
                    disabled={revokingId === card.card_id}
                  >
                    {revokingId === card.card_id ? "Revoking…" : "Revoke"}
                  </button>
                </div>
              </div>
              {expandedCardId === card.card_id && (
                <CardDetailPanel
                  detail={cardDetails[card.card_id] ?? null}
                  loading={loadingDetailId === card.card_id}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add another form */}
      {mockVerifying && (
        <MockVerifyForm
          type={def.type}
          form={mockForm}
          onChange={onChangeMockForm}
          onSubmit={onSubmitMock}
          onCancel={onCancelMock}
          submitting={submitting}
          error={submitError}
          isReverify={false}
        />
      )}

      {/* Actions */}
      {!mockVerifying && (
        <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
          {isSingle && bestActiveCard && (
            <>
              <button
                className="a-btn a-btn--ghost"
                style={{ fontSize: 11 }}
                onClick={() => onVerifyCard(bestActiveCard.card_id)}
                disabled={verifyingId === bestActiveCard.card_id}
              >
                {verifyingId === bestActiveCard.card_id ? "Verifying…" : "Verify signature"}
              </button>
              <button
                className="a-btn a-btn--ghost"
                style={{ fontSize: 11 }}
                onClick={() => onToggleCardDetail(bestActiveCard.card_id)}
                disabled={loadingDetailId === bestActiveCard.card_id}
              >
                {expandedCardId === bestActiveCard.card_id ? "Hide details" : "View details"}
              </button>
              <button
                className="a-btn a-btn--danger"
                style={{ fontSize: 11 }}
                onClick={() => onRevokeCard(bestActiveCard.card_id)}
                disabled={revokingId === bestActiveCard.card_id}
              >
                {revokingId === bestActiveCard.card_id ? "Revoking…" : "Revoke"}
              </button>
            </>
          )}
          {!isSingle && (
            <button
              className="a-btn a-btn--ghost"
              style={{ fontSize: 11 }}
              onClick={onToggleGroupExpanded}
            >
              {groupExpanded ? "Collapse" : `View all ${activeCards.length}`}
            </button>
          )}
          {repeatable && (externalProvider || mockProvider || realProvider) && !mockVerifying && (
            <button
              className="a-btn a-btn--ghost"
              style={{ fontSize: 11 }}
              onClick={externalProvider ? onStartHandoff : realProvider ? onStartReal : onStartMock}
            >
              {addAnotherLabel(group.type)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── CapabilityCard (Available Capabilities — non-active types only) ──────────

function CapabilityCard({
  group,
  mockVerifying,
  mockForm,
  onStartMock,
  onStartReal,
  onStartHandoff,
  onChangeMockForm,
  onSubmitMock,
  onCancelMock,
  submitting,
  submitError,
  externalProvider,
}: {
  group: VerificationGroup;
  mockVerifying: boolean;
  mockForm: MockForm;
  onStartMock: () => void;
  onStartReal: () => void;
  onStartHandoff: () => void;
  onChangeMockForm: (f: MockForm) => void;
  onSubmitMock: () => void;
  onCancelMock: () => void;
  submitting: boolean;
  submitError: string | null;
  externalProvider?: ExternalVerificationProviderDescriptor;
}) {
  const { def, state, mockProvider, realProvider } = group;
  const canReverify = (state === "revoked" || state === "expired") && (!!mockProvider || !!realProvider || !!externalProvider);

  const statusBadge =
    state === "expired" ? (
      <span className="a-status a-status--amber">
        <span className="a-status__dot" />
        Expired
      </span>
    ) : state === "revoked" ? (
      <span className="a-status a-status--red">
        <span className="a-status__dot" />
        Revoked
      </span>
    ) : state === "not_verified" ? (
      <span className="a-status a-status--graphite">Not verified</span>
    ) : (
      <span className="a-status a-status--amber">Coming soon</span>
    );

  return (
    <div
      className="a-card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        borderTop:
          state === "revoked" || state === "expired"
            ? "3px solid oklch(0.62 0.14 25)"
            : undefined,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: "var(--ink-1)" }}>{def.title}</div>
        {statusBadge}
      </div>

      <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
        {def.description}
      </p>

      <div style={{ fontSize: 12 }}>
        <span style={{ color: "oklch(0.42 0.09 150)", fontWeight: 500 }}>Agents can prove: </span>
        <span style={{ color: "var(--ink-2)" }}>{def.agentCanProve}</span>
      </div>

      <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
        Never shared: {def.agentNeverReceives}
      </div>

      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {def.useCases.map((u) => (
          <span
            key={u}
            style={{
              fontSize: 10,
              padding: "2px 7px",
              background: "oklch(0.95 0.002 250)",
              borderRadius: 999,
              color: "var(--ink-3)",
            }}
          >
            {u}
          </span>
        ))}
      </div>

      <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
        Assurance: {def.assuranceLabel}
        {realProvider && !externalProvider && (
          <span style={{ marginLeft: 8, color: "oklch(0.42 0.09 150)", fontStyle: "italic" }}>
            · local dev provider
          </span>
        )}
      </div>

      {mockVerifying && (
        <MockVerifyForm
          type={def.type}
          form={mockForm}
          onChange={onChangeMockForm}
          onSubmit={onSubmitMock}
          onCancel={onCancelMock}
          submitting={submitting}
          error={submitError}
          isReverify={canReverify}
        />
      )}

      {!mockVerifying && (
        <div style={{ display: "flex", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
          {canReverify && (
            <button
              className="a-btn a-btn--primary"
              style={{ fontSize: 11 }}
              onClick={externalProvider ? onStartHandoff : realProvider ? onStartReal : onStartMock}
            >
              Re-verify
            </button>
          )}
          {(state === "revoked" || state === "expired") && !canReverify && (
            <button className="a-btn a-btn--ghost" disabled style={{ fontSize: 11, opacity: 0.5 }}>
              Coming soon
            </button>
          )}
          {state === "not_verified" && externalProvider && (
            <button className="a-btn a-btn--primary" style={{ fontSize: 12 }} onClick={onStartHandoff}>
              {HANDOFF_CTA[def.type] ?? "Verify"}
            </button>
          )}
          {state === "not_verified" && !externalProvider && realProvider && (
            <button className="a-btn a-btn--primary" style={{ fontSize: 11 }} onClick={onStartReal}>
              Verify email
            </button>
          )}
          {state === "not_verified" && !externalProvider && !realProvider && mockProvider && (
            <button className="a-btn a-btn--primary" style={{ fontSize: 11 }} onClick={onStartMock}>
              Mock verify
            </button>
          )}
          {state === "coming_soon" && (
            <button className="a-btn a-btn--ghost" disabled style={{ fontSize: 11, opacity: 0.5 }}>
              Coming soon
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── RevokedHistoryRow (Revoked tab — all revoked/expired cards per type) ─────

function RevokedHistoryRow({
  group,
  expandedCardId,
  cardDetails,
  loadingDetailId,
  onToggleCardDetail,
}: {
  group: VerificationGroup;
  expandedCardId: string | null;
  cardDetails: Record<string, VerificationCardDetail>;
  loadingDetailId: string | null;
  onToggleCardDetail: (cardId: string) => void;
}) {
  const allCards = [...group.revokedCards, ...group.expiredCards].sort(byIssuedDesc);
  if (allCards.length === 0) return null;

  return (
    <div
      className="a-card"
      style={{ display: "flex", flexDirection: "column", gap: 0, opacity: 0.85 }}
    >
      <div style={{ fontWeight: 600, fontSize: 14, color: "var(--ink-1)", marginBottom: 10 }}>
        {group.def.title}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {allCards.map((card) => {
          const isRevoked = card.revocation_status === "revoked";
          return (
            <div
              key={card.card_id}
              style={{
                padding: "10px 12px",
                background: "var(--bg-2)",
                border: "1px solid var(--hairline)",
                borderRadius: "var(--r-1)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  {isRevoked ? (
                    <span className="a-status a-status--red">
                      <span className="a-status__dot" />
                      Revoked
                    </span>
                  ) : (
                    <span className="a-status a-status--amber">
                      <span className="a-status__dot" />
                      Expired
                    </span>
                  )}
                  {card.assurance_level && (
                    <span
                      className={assuranceBadgeClass(card.assurance_level)}
                      style={{ fontSize: 10 }}
                    >
                      {card.assurance_level.replace(/_/g, " ")}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-4)", flexShrink: 0 }}>
                  Issued {fmt(card.issued_at)}
                </div>
              </div>

              {expandedCardId === card.card_id && (
                <CardDetailPanel
                  detail={cardDetails[card.card_id] ?? null}
                  loading={loadingDetailId === card.card_id}
                />
              )}

              <button
                className="a-btn a-btn--ghost"
                style={{ fontSize: 11 }}
                onClick={() => onToggleCardDetail(card.card_id)}
                disabled={loadingDetailId === card.card_id}
              >
                {expandedCardId === card.card_id ? "Hide details" : "View details"}
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 10 }}>
        Never shared: {group.def.agentNeverReceives}
      </div>
    </div>
  );
}

// ─── ExternalProviderHandoffModal ─────────────────────────────────────────────

type HandoffModalPhase =
  | "intro"
  | "connecting"
  | "checking"
  | "completed"
  | "failed"
  | "awaiting_return"
  | "provider_pending"
  | "requires_input";

function ProviderIconBadge({ providerName }: { providerName: string }) {
  const isIdentity = providerName.includes("stripe") || providerName.includes("gov");
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        border: "1px solid var(--hairline)",
        background: "var(--bg-2)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {isIdentity ? (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
          <rect x="1" y="4" width="16" height="11" rx="2" stroke="var(--ink-3)" strokeWidth="1.4" fill="none"/>
          <circle cx="5.5" cy="9.5" r="2" stroke="var(--ink-3)" strokeWidth="1.2" fill="none"/>
          <line x1="9" y1="8" x2="15" y2="8" stroke="var(--ink-3)" strokeWidth="1.2" strokeLinecap="round"/>
          <line x1="9" y1="11" x2="13" y2="11" stroke="var(--ink-3)" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
          <path d="M9 2L15 5v4c0 3.5-2.5 6-6 7C3 15 1 12.5 1 9V5l8-3z" stroke="var(--ink-3)" strokeWidth="1.4" fill="none" strokeLinejoin="round"/>
          <path d="M6 9l2 2 4-4" stroke="var(--ink-3)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )}
    </div>
  );
}

function ExternalProviderHandoffModal({
  handoff,
  onComplete,
  onCancel,
}: {
  handoff: ExternalVerificationHandoffView;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<HandoffModalPhase>("intro");
  const [error, setError] = useState<string | null>(null);

  const runMockFlow = async () => {
    setPhase("connecting");
    await new Promise((r) => setTimeout(r, 800));
    setPhase("checking");
    try {
      await new Promise((r) => setTimeout(r, 1200));
      await mockCompleteExternalSession(handoff.session_id);
      setPhase("completed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed.");
      setPhase("failed");
    }
  };

  const runRedirectFlow = () => {
    if (handoff.handoff_url) {
      window.open(handoff.handoff_url, "_blank", "noopener,noreferrer");
    }
    setPhase("awaiting_return");
  };

  const handleSyncAfterReturn = async () => {
    setPhase("checking");
    try {
      const result = await syncExternalVerificationSession(handoff.session_id);
      if (result.status === "card_issued") {
        setPhase("completed");
        onComplete();
      } else if (result.status === "pending" || result.status === "provider_pending") {
        setPhase("provider_pending");
      } else if (result.status === "requires_input") {
        setPhase("requires_input");
      } else {
        setError(result.failure_reason ?? "Verification failed.");
        setPhase("failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed.");
      setPhase("failed");
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={(e) => {
        const blocked = phase === "connecting" || phase === "checking" || phase === "awaiting_return";
        if (e.target === e.currentTarget && !blocked) onCancel();
      }}
    >
      <div
        style={{
          background: "var(--paper)",
          borderRadius: "var(--r-3)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06)",
          width: "100%",
          maxWidth: 440,
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "18px 22px 14px",
            borderBottom: "1px solid var(--hairline)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <ProviderIconBadge providerName={handoff.provider_name} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-1)", lineHeight: 1.2 }}>
              {handoff.title}
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 2 }}>
              {handoff.provider_display_name}
            </div>
          </div>
          {(phase === "intro" || phase === "failed" || phase === "provider_pending" || phase === "requires_input") && (
            <button
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--ink-4)",
                fontSize: 20,
                padding: "0 2px",
                lineHeight: 1,
              }}
              onClick={onCancel}
              aria-label="Close"
            >
              ×
            </button>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: "20px 22px" }}>
          {phase === "intro" && (
            <>
              <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "0 0 18px", lineHeight: 1.6 }}>
                {handoff.description}
              </p>

              {/* Privacy guarantees */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-4)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
                  Privacy guarantees
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {handoff.privacy_guarantees.map((g, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <span style={{ color: "oklch(0.48 0.09 150)", fontSize: 11, flexShrink: 0, marginTop: 1 }}>✓</span>
                      <span style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.5 }}>{g}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* What agents can prove */}
              <div style={{ borderLeft: "2px solid oklch(0.82 0.04 240)", paddingLeft: 12, marginBottom: 20 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-4)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>
                  Agents can prove
                </div>
                {handoff.agent_can_prove.map((a, i) => (
                  <div key={i} style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.5, marginBottom: i < handoff.agent_can_prove.length - 1 ? 3 : 0 }}>
                    → {a}
                  </div>
                ))}
              </div>

              <button
                className="a-btn a-btn--primary"
                style={{ width: "100%", fontSize: 13, padding: "9px 0", justifyContent: "center" }}
                onClick={handoff.handoff_mode === "redirect" ? runRedirectFlow : runMockFlow}
              >
                {handoff.handoff_mode === "redirect"
                  ? `Continue to ${handoff.provider_display_name}`
                  : "Continue"}
              </button>
              {handoff.handoff_mode === "mock_modal" && (
                <div style={{ textAlign: "center", marginTop: 10, fontSize: 10, color: "var(--ink-5, var(--ink-4))" }}>
                  Local development simulation
                </div>
              )}
            </>
          )}

          {phase === "awaiting_return" && (
            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: "oklch(0.94 0.04 240)",
                  border: "2px solid oklch(0.80 0.08 240)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 14px",
                }}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
                  <path d="M10 4v6l3 3" stroke="oklch(0.45 0.10 240)" strokeWidth="2" strokeLinecap="round"/>
                  <circle cx="10" cy="10" r="7.5" stroke="oklch(0.55 0.08 240)" strokeWidth="1.4" fill="none"/>
                </svg>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-1)", marginBottom: 8 }}>
                Complete verification in the opened tab
              </div>
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "0 0 20px", lineHeight: 1.6 }}>
                Finish your identity check with {handoff.provider_display_name}, then return here.
              </p>
              <button
                className="a-btn a-btn--primary"
                style={{ width: "100%", fontSize: 13, padding: "9px 0", justifyContent: "center", marginBottom: 10 }}
                onClick={handleSyncAfterReturn}
              >
                I completed verification
              </button>
              <button
                className="a-btn a-btn--ghost"
                style={{ width: "100%", fontSize: 12, padding: "7px 0", justifyContent: "center" }}
                onClick={() => {
                  if (handoff.handoff_url) window.open(handoff.handoff_url, "_blank", "noopener,noreferrer");
                }}
              >
                Reopen verification tab
              </button>
            </div>
          )}

          {phase === "provider_pending" && (
            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: "oklch(0.96 0.03 60)",
                  border: "2px solid oklch(0.85 0.07 60)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 14px",
                }}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <circle cx="9" cy="9" r="6.5" stroke="oklch(0.55 0.10 60)" strokeWidth="1.4" fill="none"/>
                  <path d="M9 5v4l2.5 2.5" stroke="oklch(0.45 0.10 60)" strokeWidth="1.6" strokeLinecap="round"/>
                </svg>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-1)", marginBottom: 8 }}>
                Verification in progress
              </div>
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "0 0 20px", lineHeight: 1.6 }}>
                {handoff.provider_display_name} is still processing your submission. Check back in a few minutes.
              </p>
              <button
                className="a-btn a-btn--primary"
                style={{ width: "100%", fontSize: 13, padding: "9px 0", justifyContent: "center", marginBottom: 10 }}
                onClick={handleSyncAfterReturn}
              >
                Check again
              </button>
              <button className="a-btn a-btn--ghost" style={{ width: "100%", fontSize: 12, padding: "7px 0", justifyContent: "center" }} onClick={onCancel}>
                Close
              </button>
            </div>
          )}

          {phase === "requires_input" && (
            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: "oklch(0.95 0.04 25)",
                  border: "2px solid oklch(0.85 0.08 25)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 14px",
                }}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <path d="M9 5v5" stroke="oklch(0.45 0.12 25)" strokeWidth="2" strokeLinecap="round"/>
                  <circle cx="9" cy="13" r="1" fill="oklch(0.45 0.12 25)"/>
                </svg>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-1)", marginBottom: 8 }}>
                Additional information required
              </div>
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "0 0 20px", lineHeight: 1.6 }}>
                {handoff.provider_display_name} needs more from you. Return to the verification tab to complete the process.
              </p>
              <button
                className="a-btn a-btn--primary"
                style={{ width: "100%", fontSize: 13, padding: "9px 0", justifyContent: "center", marginBottom: 10 }}
                onClick={() => {
                  if (handoff.handoff_url) window.open(handoff.handoff_url, "_blank", "noopener,noreferrer");
                  setPhase("awaiting_return");
                }}
              >
                Reopen verification tab
              </button>
              <button className="a-btn a-btn--ghost" style={{ width: "100%", fontSize: 12, padding: "7px 0", justifyContent: "center" }} onClick={onCancel}>
                Cancel
              </button>
            </div>
          )}

          {(phase === "connecting" || phase === "checking") && (
            <div style={{ padding: "16px 0" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 20 }}>
                {[
                  { label: "Secure handoff", done: true, active: phase === "connecting" },
                  { label: "Provider check", done: phase === "checking", active: phase === "checking" },
                  { label: "Signed card issued", done: false, active: false },
                ].map((step, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        border: step.done
                          ? "2px solid oklch(0.48 0.09 150)"
                          : step.active
                          ? "2px solid oklch(0.60 0.08 240)"
                          : "2px solid var(--hairline)",
                        background: step.done ? "oklch(0.48 0.09 150)" : "transparent",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        transition: "all 0.25s",
                      }}
                    >
                      {step.done && (
                        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden>
                          <path d="M1.5 4.5l2 2 4-4" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                      {step.active && !step.done && (
                        <div
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: "oklch(0.60 0.08 240)",
                            animation: "pulse 1s ease-in-out infinite",
                          }}
                        />
                      )}
                    </div>
                    <span
                      style={{
                        fontSize: 13,
                        color: step.done
                          ? "oklch(0.42 0.09 150)"
                          : step.active
                          ? "var(--ink-1)"
                          : "var(--ink-4)",
                        fontWeight: step.active ? 500 : 400,
                        transition: "color 0.25s",
                      }}
                    >
                      {step.label}
                    </span>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                {phase === "connecting" ? "Establishing secure connection…" : "Verifying your eligibility…"}
              </p>
            </div>
          )}

          {phase === "completed" && (
            <div style={{ textAlign: "center" }}>
              {/* Verified seal */}
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: "50%",
                  background: "oklch(0.93 0.05 150)",
                  border: "2px solid oklch(0.78 0.09 150)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 14px",
                }}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
                  <path d="M4 10l4 4 8-8" stroke="oklch(0.35 0.09 150)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-1)", marginBottom: 6 }}>
                Verification card issued
              </div>
              <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 18px", lineHeight: 1.6 }}>
                Your signed card was added to your wallet.
              </p>

              {/* Agents can now prove */}
              <div style={{ borderLeft: "2px solid oklch(0.78 0.09 150)", paddingLeft: 12, marginBottom: 20, textAlign: "left" }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "oklch(0.42 0.09 150)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>
                  Agents can now prove
                </div>
                {handoff.agent_can_prove.map((a, i) => (
                  <div key={i} style={{ fontSize: 12, color: "oklch(0.38 0.07 150)", lineHeight: 1.5, marginBottom: 3 }}>
                    → {a}
                  </div>
                ))}
              </div>

              <button
                className="a-btn a-btn--primary"
                style={{ width: "100%", fontSize: 13, padding: "9px 0", justifyContent: "center" }}
                onClick={onComplete}
              >
                Done
              </button>
            </div>
          )}

          {phase === "failed" && (
            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: "oklch(0.95 0.04 25)",
                  border: "2px solid oklch(0.85 0.08 25)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 14px",
                }}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <path d="M9 5v5" stroke="oklch(0.45 0.12 25)" strokeWidth="2" strokeLinecap="round"/>
                  <circle cx="9" cy="13" r="1" fill="oklch(0.45 0.12 25)"/>
                </svg>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-1)", marginBottom: 6 }}>
                Verification failed
              </div>
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "0 0 16px", lineHeight: 1.5 }}>
                {error ?? "An error occurred during verification."}
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                <button className="a-btn a-btn--ghost" style={{ fontSize: 12 }} onClick={onCancel}>
                  Cancel
                </button>
                <button
                  className="a-btn a-btn--primary"
                  style={{ fontSize: 12 }}
                  onClick={() => {
                    setPhase("intro");
                    setError(null);
                  }}
                >
                  Try again
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function VerifyPage() {
  const [cards, setCards] = useState<VerificationCardSummary[]>([]);
  const [providers, setProviders] = useState<
    { name: string; supported_types: VerificationType[] }[]
  >([]);
  const [externalProviders, setExternalProviders] = useState<ExternalVerificationProviderDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult>>({});
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [cardDetails, setCardDetails] = useState<Record<string, VerificationCardDetail>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("all");
  const [mockVerifyingType, setMockVerifyingType] = useState<VerificationType | null>(null);
  const [mockForm, setMockForm] = useState<MockForm>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [expandedGroupType, setExpandedGroupType] = useState<VerificationType | null>(null);
  const [otpFlow, setOtpFlow] = useState<OtpFlowState>({ phase: "idle" });
  const [handoffFlow, setHandoffFlow] = useState<HandoffFlow>({ phase: "idle" });
  const [emailInput, setEmailInput] = useState("");
  const [otpInput, setOtpInput] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listVerificationCards(), listVerificationTypes()])
      .then(([cardsData, typesData]) => {
        setCards(cardsData.cards);
        setProviders(typesData.providers);
        setExternalProviders(typesData.external_providers ?? []);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const refreshCards = async () => {
    const data = await listVerificationCards();
    setCards(data.cards);
  };

  const handleVerify = async (cardId: string) => {
    setVerifying(cardId);
    try {
      const result = await verifyVerificationCard(cardId);
      setVerifyResults((prev) => ({ ...prev, [cardId]: result }));
    } catch {
      // user can retry
    } finally {
      setVerifying(null);
    }
  };

  const handleRevoke = async (cardId: string) => {
    if (!confirm("Revoke this verification card? This cannot be undone.")) return;
    setRevoking(cardId);
    try {
      const result = await revokeVerificationCard(cardId);
      setCards((prev) => prev.map((c) => (c.card_id === cardId ? result.card : c)));
    } catch {
      // silently fail
    } finally {
      setRevoking(null);
    }
  };

  const handleToggleDetail = async (cardId: string) => {
    if (expandedCard === cardId) {
      setExpandedCard(null);
      return;
    }
    setExpandedCard(cardId);
    if (!cardDetails[cardId]) {
      setLoadingDetail(cardId);
      try {
        const result = await getVerificationCard(cardId);
        setCardDetails((prev) => ({ ...prev, [cardId]: result.card }));
      } catch {
        // silently fail
      } finally {
        setLoadingDetail(null);
      }
    }
  };

  const handleSubmitMock = async (type: VerificationType, providerName: string) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const mockInput = buildMockInput(type, mockForm);
      const sessionData = await createVerificationSession({
        verification_type: type,
        provider_name: providerName,
        mock_input: mockInput,
      });
      await completeVerificationSession(sessionData.session_id, { mock_input: mockInput });
      setMockVerifyingType(null);
      setMockForm({});
      await refreshCards();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartRealVerify = (type: VerificationType, providerName: string) => {
    setOtpFlow({ phase: "email_input", type, providerName });
    setEmailInput("");
    setOtpError(null);
  };

  const handleStartHandoff = async (verificationType: VerificationType, providerName: string) => {
    try {
      const result = await createExternalVerificationSession({
        verification_type: verificationType,
        provider_name: providerName,
      });
      setHandoffFlow({ phase: "active", sessionId: result.session_id, handoff: result.handoff });
    } catch (e) {
      console.error("Failed to start handoff:", e);
    }
  };

  const handleSubmitEmail = async () => {
    if (otpFlow.phase !== "email_input") return;
    setSubmitting(true);
    setOtpError(null);
    try {
      const providerName = otpFlow.providerName as "email_otp" | "local_email";
      const session = await createEmailVerificationSession({
        verification_type: otpFlow.type as "email_ownership",
        provider_name: providerName,
        email: emailInput,
      });
      setOtpFlow({
        phase: "otp_input",
        sessionId: session.session_id,
        deliveryMode: session.delivery_mode,
      });
      setOtpInput("");
    } catch (e) {
      setOtpError(e instanceof Error ? e.message : "Failed to start verification.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitOtp = async () => {
    if (otpFlow.phase !== "otp_input") return;
    setSubmitting(true);
    setOtpError(null);
    try {
      await submitVerificationCode(otpFlow.sessionId, otpInput);
      setOtpFlow({ phase: "idle" });
      setOtpInput("");
      setEmailInput("");
      await refreshCards();
    } catch (e) {
      setOtpError(e instanceof Error ? e.message : "Invalid code — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Derived groups ────────────────────────────────────────────────────────
  const groups = buildVerificationGroups(cards, providers, externalProviders);
  const activeGroups = groups.filter((g) => g.activeCards.length > 0);
  const availableGroups = groups.filter((g) => g.activeCards.length === 0);
  const revokedGroups = groups.filter(
    (g) => g.revokedCards.length > 0 || g.expiredCards.length > 0,
  );
  const hasMockProviders = providers.some((p) => p.name.startsWith("mock_"));

  // Stats
  const activeCount = groups.reduce((s, g) => s + g.activeCards.length, 0);
  const revokedCount = groups.reduce(
    (s, g) => s + g.revokedCards.length + g.expiredCards.length,
    0,
  );
  const signedCount = cards.filter((c) => c.jws_present).length;

  const TABS: { id: Tab; label: string }[] = [
    { id: "all", label: "All" },
    { id: "verified", label: `Verified (${activeGroups.length})` },
    { id: "available", label: "Available" },
    { id: "revoked", label: `Revoked (${revokedCount})` },
  ];

  if (loading) {
    return (
      <div className="page">
        <div style={{ padding: 32, color: "var(--ink-3)", fontSize: 14 }}>
          Loading identity capabilities…
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      {handoffFlow.phase === "active" && (
        <ExternalProviderHandoffModal
          handoff={handoffFlow.handoff}
          onComplete={async () => {
            setHandoffFlow({ phase: "idle" });
            await refreshCards();
          }}
          onCancel={() => setHandoffFlow({ phase: "idle" })}
        />
      )}

      {otpFlow.phase !== "idle" && (
        <EmailOtpModal
          phase={otpFlow.phase === "email_input" ? "email_input" : "otp_input"}
          emailInput={emailInput}
          otpInput={otpInput}
          onEmailChange={setEmailInput}
          onOtpChange={setOtpInput}
          onSubmitEmail={handleSubmitEmail}
          onSubmitOtp={handleSubmitOtp}
          onCancel={() => {
            setOtpFlow({ phase: "idle" });
            setEmailInput("");
            setOtpInput("");
            setOtpError(null);
          }}
          submitting={submitting}
          error={otpError}
          deliveryMode={otpFlow.phase === "otp_input" ? otpFlow.deliveryMode : undefined}
        />
      )}

      {/* ── Hero ── */}
      <div
        className="a-card"
        style={{
          background:
            "linear-gradient(135deg, oklch(0.97 0.01 240) 0%, oklch(0.99 0.005 80) 100%)",
          borderTop: "3px solid oklch(0.62 0.09 240)",
        }}
      >
        <div style={{ marginBottom: 20 }}>
          <div className="a-eyebrow" style={{ marginBottom: 6 }}>
            IDENTITY CAPABILITY DASHBOARD
          </div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: "var(--ink-1)",
              margin: "0 0 6px",
              lineHeight: 1.2,
            }}
          >
            What your agents can prove
          </h1>
          <p style={{ fontSize: 13, color: "var(--ink-3)", margin: 0, maxWidth: 540 }}>
            Choose what your agents can prove on your behalf. Aegis stores signed claims, not
            raw documents.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <StatBox label="Active credentials" value={activeCount} color="green" />
          <StatBox label="Available capabilities" value={CAPABILITIES.length} color="blue" />
          <StatBox label="Signed cards" value={signedCount} color="graphite" />
          <StatBox label="Revoked / expired" value={revokedCount} color="red" />
        </div>
      </div>

      {/* ── Privacy banner ── */}
      <div
        style={{
          padding: "12px 16px",
          background: "var(--green-soft)",
          border: "1px solid var(--green-ring)",
          borderRadius: "var(--r-2)",
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
        }}
      >
        <span style={{ fontSize: 16, flexShrink: 0 }}>🔒</span>
        <div>
          <div
            style={{ fontWeight: 600, fontSize: 12, color: "oklch(0.35 0.08 150)", marginBottom: 2 }}
          >
            Privacy guarantee
          </div>
          <p style={{ fontSize: 12, color: "oklch(0.40 0.07 150)", margin: 0, lineHeight: 1.5 }}>
            Agents receive signed claims or trust signals — not raw IDs, documents, SSNs,
            birthdates, or provider payloads. Raw evidence is never stored or disclosed to any
            agent or website.
          </p>
        </div>
      </div>

      {/* ── Dev mock banner ── */}
      {hasMockProviders && (
        <div
          style={{
            padding: "10px 14px",
            background: "var(--amber-soft)",
            border: "1px solid oklch(0.86 0.07 75)",
            borderRadius: "var(--r-1)",
            fontSize: 12,
            color: "oklch(0.45 0.12 75)",
          }}
        >
          <strong>Local development only:</strong> Mock providers and local OTP email
          verification are active. Email OTP codes are printed to the API console — no real
          email is sent yet. All cards are signed locally and work the same as real cards
          structurally.
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="ag-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`ag-tab${activeTab === t.id ? " ag-tab--active" : ""}`}
            onClick={() => {
              setActiveTab(t.id);
              setExpandedGroupType(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Current Verifications (all / verified tabs) ── */}
      {(activeTab === "all" || activeTab === "verified") && (
        <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div className="a-eyebrow" style={{ marginBottom: 2 }}>
              CURRENT VERIFICATIONS
            </div>
            <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
              Active signed claims your agents can reference when acting on your behalf.
            </p>
          </div>

          {activeGroups.length === 0 ? (
            <div
              style={{
                padding: "32px 24px",
                textAlign: "center",
                background: "var(--paper)",
                border: "1px solid var(--hairline)",
                borderRadius: "var(--r-2)",
                color: "var(--ink-3)",
              }}
            >
              <div style={{ fontSize: 28, marginBottom: 8 }}>🪪</div>
              <div
                style={{ fontWeight: 600, fontSize: 14, color: "var(--ink-2)", marginBottom: 4 }}
              >
                No active verifications yet
              </div>
              <p style={{ fontSize: 12, margin: 0 }}>
                Choose a capability below to issue your first signed claim.
              </p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {activeGroups.map((group) => (
                <GroupCard
                  key={group.type}
                  group={group}
                  expandedCardId={expandedCard}
                  cardDetails={cardDetails}
                  loadingDetailId={loadingDetail}
                  revokingId={revoking}
                  verifyingId={verifying}
                  verifyResults={verifyResults}
                  groupExpanded={expandedGroupType === group.type}
                  mockVerifying={mockVerifyingType === group.type}
                  mockForm={mockVerifyingType === group.type ? mockForm : {}}
                  submitting={submitting && mockVerifyingType === group.type}
                  submitError={mockVerifyingType === group.type ? submitError : null}
                  onVerifyCard={handleVerify}
                  onRevokeCard={handleRevoke}
                  onToggleCardDetail={handleToggleDetail}
                  onStartMock={() => {
                    setMockVerifyingType(group.type);
                    setMockForm({});
                    setSubmitError(null);
                  }}
                  onStartReal={() => {
                    if (group.realProvider) handleStartRealVerify(group.type, group.realProvider);
                  }}
                  onStartHandoff={() => {
                    if (group.externalProvider)
                      handleStartHandoff(group.type, group.externalProvider.provider_name);
                  }}
                  onChangeMockForm={setMockForm}
                  onSubmitMock={() => {
                    if (group.mockProvider) handleSubmitMock(group.type, group.mockProvider);
                  }}
                  onCancelMock={() => {
                    setMockVerifyingType(null);
                    setMockForm({});
                    setSubmitError(null);
                  }}
                  onToggleGroupExpanded={() =>
                    setExpandedGroupType((prev) => (prev === group.type ? null : group.type))
                  }
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Revoked history (revoked tab) ── */}
      {activeTab === "revoked" && (
        <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div className="a-eyebrow" style={{ marginBottom: 2 }}>
              REVOKED HISTORY
            </div>
            <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
              Cards you have revoked or that have expired. Use Re-verify in Available Capabilities
              to issue a fresh claim.
            </p>
          </div>

          {revokedGroups.length === 0 ? (
            <div
              style={{ padding: "24px", textAlign: "center", color: "var(--ink-4)", fontSize: 13 }}
            >
              No revoked or expired cards.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {revokedGroups.map((group) => (
                <RevokedHistoryRow
                  key={group.type}
                  group={group}
                  expandedCardId={expandedCard}
                  cardDetails={cardDetails}
                  loadingDetailId={loadingDetail}
                  onToggleCardDetail={handleToggleDetail}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Available Capabilities (all / available tabs) ── */}
      {(activeTab === "all" || activeTab === "available") && (
        <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div className="a-eyebrow" style={{ marginBottom: 2 }}>
              AVAILABLE CAPABILITIES
            </div>
            <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
              {activeTab === "available"
                ? "Capabilities you can add. Mock providers let you test the full flow locally."
                : "Capabilities you can add to your credential wallet."}
            </p>
          </div>

          {availableGroups.length === 0 ? (
            <div style={{ padding: "20px 0", color: "var(--ink-4)", fontSize: 13 }}>
              All capabilities are active.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                gap: 14,
              }}
            >
              {availableGroups.map((group) => {
                const isMockVerifyingThis = mockVerifyingType === group.type;
                return (
                  <CapabilityCard
                    key={group.type}
                    group={group}
                    mockVerifying={isMockVerifyingThis}
                    mockForm={isMockVerifyingThis ? mockForm : {}}
                    externalProvider={group.externalProvider}
                    onStartHandoff={() => {
                      if (group.externalProvider)
                        handleStartHandoff(group.type, group.externalProvider.provider_name);
                    }}
                    onStartMock={() => {
                      setMockVerifyingType(group.type);
                      setMockForm({});
                      setSubmitError(null);
                    }}
                    onStartReal={() => {
                      if (group.realProvider) handleStartRealVerify(group.type, group.realProvider);
                    }}
                    onChangeMockForm={setMockForm}
                    onSubmitMock={() => {
                      if (group.mockProvider) handleSubmitMock(group.type, group.mockProvider);
                    }}
                    onCancelMock={() => {
                      setMockVerifyingType(null);
                      setMockForm({});
                      setSubmitError(null);
                    }}
                    submitting={submitting && isMockVerifyingThis}
                    submitError={isMockVerifyingThis ? submitError : null}
                  />
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
