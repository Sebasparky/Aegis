import type {
  VerificationType,
  AssuranceLevel,
  VerifiedClaim,
  VerificationProviderSession,
  ExternalVerificationProviderDescriptor,
  ExternalVerificationProviderName,
} from "@aegis/types";

export interface ProviderClaimResult {
  claims: Array<Omit<VerifiedClaim, "claim_id" | "card_id">>;
  assurance_level: AssuranceLevel;
  expires_at?: string;
}

export interface VerificationProviderInput {
  email?: string;
}

export interface VerificationProvider {
  name: string;
  supported_types: VerificationType[];
  requires_code_step?: true;
  initiate(
    session: VerificationProviderSession,
    input?: VerificationProviderInput
  ): Promise<{
    provider_session_id?: string;
    redirect_url?: string;
  }>;
  complete(
    session: VerificationProviderSession,
    mockInput?: unknown
  ): Promise<ProviderClaimResult>;
}

// ─── Mock Email Provider ─────────────────────────────────────────────────────

const mockEmailProvider: VerificationProvider = {
  name: "mock_email",
  supported_types: ["email_ownership"],
  async initiate(_session) {
    return { provider_session_id: `mock_email_${Date.now()}` };
  },
  async complete(_session, mockInput) {
    const input = (mockInput ?? {}) as Record<string, string>;
    let email_domain = "example.com";
    if (typeof input.email_domain === "string" && input.email_domain) {
      email_domain = input.email_domain;
    } else if (typeof input.email === "string" && input.email.includes("@")) {
      email_domain = input.email.split("@")[1];
    }
    const expires_at = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    return {
      claims: [
        {
          claim_type: "email_ownership",
          claim_value: { kind: "email_ownership", email_domain },
          assurance_level: "provider_verified",
          verified_at: new Date().toISOString(),
          expires_at,
        },
      ],
      assurance_level: "provider_verified",
      expires_at,
    };
  },
};

// ─── Mock Student Provider ───────────────────────────────────────────────────

const mockStudentProvider: VerificationProvider = {
  name: "mock_student",
  supported_types: ["student_status"],
  async initiate(_session) {
    return { provider_session_id: `mock_student_${Date.now()}` };
  },
  async complete(_session, mockInput) {
    const input = (mockInput ?? {}) as Record<string, string>;
    const institution_name =
      typeof input.institution_name === "string" && input.institution_name
        ? input.institution_name
        : "University of Michigan";
    const enrollment_status =
      typeof input.enrollment_status === "string" && input.enrollment_status
        ? input.enrollment_status
        : "active";
    return {
      claims: [
        {
          claim_type: "student_status",
          claim_value: { kind: "student_status", institution_name, enrollment_status },
          assurance_level: "provider_verified",
          verified_at: new Date().toISOString(),
        },
      ],
      assurance_level: "provider_verified",
    };
  },
};

// ─── Mock Gov ID Provider ────────────────────────────────────────────────────
// Returns Tier 2 claim details only — country_code and id_type as document-type metadata.
// No raw ID number, no document number, no DOB, no legal name, no SSN, no biometric.

const mockGovIdProvider: VerificationProvider = {
  name: "mock_gov_id",
  supported_types: ["government_id"],
  async initiate(_session) {
    return { provider_session_id: `mock_gov_${Date.now()}` };
  },
  async complete(_session, mockInput) {
    const input = (mockInput ?? {}) as Record<string, string>;
    const country_code =
      typeof input.country_code === "string" && input.country_code
        ? input.country_code
        : "US";
    const id_type =
      typeof input.id_type === "string" && input.id_type ? input.id_type : "drivers_license";
    const expires_at = new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000).toISOString();
    return {
      claims: [
        {
          claim_type: "government_id",
          claim_value: { kind: "government_id", country_code, id_type },
          assurance_level: "document_verified",
          verified_at: new Date().toISOString(),
          expires_at,
        },
      ],
      assurance_level: "document_verified",
      expires_at,
    };
  },
};

// ─── Email OTP Provider ───────────────────────────────────────────────────────
// Real email delivery via Resend (or dev_console fallback).
// OTP generation, hashing, delivery, and validation are handled by the route layer.
// Listed after mock providers so findProviderForType("email_ownership") still returns mock_email.

const emailOtpProvider: VerificationProvider = {
  name: "email_otp",
  supported_types: ["email_ownership"],
  requires_code_step: true,
  async initiate(_session, _input) {
    return {};
  },
  async complete(_session, _mockInput) {
    throw new Error("email_otp: card issuance is handled by the submit-code route; complete() must not be called");
  },
};

// ─── Local Email Provider ─────────────────────────────────────────────────────
// Dev OTP-based email ownership verification. Does not send real email.
// OTP generation, hashing, and validation are handled by the route layer.
// local_email is listed after the mock providers so findProviderForType("email_ownership")
// still returns mock_email when no provider_name is specified (preserves existing tests).

const localEmailProvider: VerificationProvider = {
  name: "local_email",
  supported_types: ["email_ownership"],
  requires_code_step: true,
  async initiate(_session, _input) {
    return { provider_session_id: `local_email_${Date.now()}` };
  },
  async complete(_session, _mockInput) {
    throw new Error("local_email: card issuance is handled by the submit-code route; complete() must not be called");
  },
};

// ─── Registry ────────────────────────────────────────────────────────────────

export const PROVIDERS: VerificationProvider[] = [
  mockEmailProvider,
  mockStudentProvider,
  mockGovIdProvider,
  emailOtpProvider,
  localEmailProvider,
];

export function findProvider(
  name: string,
  type?: VerificationType
): VerificationProvider | undefined {
  return PROVIDERS.find(
    (p) => p.name === name && (type === undefined || p.supported_types.includes(type))
  );
}

export function findProviderForType(
  type: VerificationType
): VerificationProvider | undefined {
  return PROVIDERS.find((p) => p.supported_types.includes(type));
}

// ─── External Provider Descriptors ───────────────────────────────────────────
// Metadata-only descriptors for handoff-based external providers.
// These are not VerificationProvider instances — they describe external flows.

// ─── Mock provider descriptors (always available as fallbacks) ───────────────

const MOCK_SHEERID_STUDENT: ExternalVerificationProviderDescriptor = {
  provider_name: "mock_sheerid_student",
  display_name: "Student Eligibility Verification",
  supported_types: ["student_status"],
  provider_category: "affiliation",
  real_provider_family: "sheerid",
  handoff_mode: "mock_modal",
  privacy_summary: [
    "Antigen stores only your institution name and verified status.",
    "No academic records, transcripts, or grades are ever shared.",
    "Raw eligibility data is never exposed to agents or websites.",
  ],
  agent_disclosure_summary: [
    "Agents can prove you are a verified student.",
    "Agents can prove your institution name.",
    "Agents cannot access underlying eligibility data.",
  ],
};

const MOCK_SHEERID_MILITARY: ExternalVerificationProviderDescriptor = {
  provider_name: "mock_sheerid_military",
  display_name: "Military Status Verification",
  supported_types: ["military_status"],
  provider_category: "affiliation",
  real_provider_family: "sheerid",
  handoff_mode: "mock_modal",
  privacy_summary: [
    "Antigen stores only your verified military affiliation status.",
    "No service records, rank, or deployment history are shared.",
    "Raw eligibility data is never exposed to agents or websites.",
  ],
  agent_disclosure_summary: [
    "Agents can prove you have verified military affiliation.",
    "Agents cannot access service records or personal military data.",
  ],
};

const MOCK_STRIPE_IDENTITY: ExternalVerificationProviderDescriptor = {
  provider_name: "mock_stripe_identity",
  display_name: "Identity Verification",
  supported_types: ["government_id"],
  provider_category: "identity",
  real_provider_family: "stripe_identity",
  handoff_mode: "mock_modal",
  privacy_summary: [
    "Antigen stores only your verified identity status — no documents are retained.",
    "No document images, document numbers, DOB, or SSN are ever stored or shared.",
    "Raw documents are never revealed to agents or websites.",
  ],
  agent_disclosure_summary: [
    "Agents can prove your identity has been verified.",
    "Agents cannot access any document details, numbers, or images.",
  ],
};

// ─── Real provider descriptors (enabled by env vars) ─────────────────────────
// These replace their mock equivalents when the corresponding env vars are set.
// Antigen uses these providers to verify users for its own trust/account workflow,
// then issues a minimal signed VerificationCard. No raw provider data is retained.

const STRIPE_IDENTITY_DESCRIPTOR: ExternalVerificationProviderDescriptor = {
  provider_name: "stripe_identity",
  display_name: "Identity Verification",
  supported_types: ["government_id"],
  provider_category: "identity",
  real_provider_family: "stripe_identity",
  handoff_mode: "redirect",
  privacy_summary: [
    "Antigen stores only your verified identity status — no documents are retained.",
    "No document images, document numbers, DOB, or SSN are ever stored or shared.",
    "Raw documents are never revealed to agents or websites.",
  ],
  agent_disclosure_summary: [
    "Agents can prove your identity has been verified.",
    "Agents cannot access any document details, numbers, or images.",
  ],
};

const SHEERID_STUDENT_DESCRIPTOR: ExternalVerificationProviderDescriptor = {
  provider_name: "sheerid_student",
  display_name: "Student Eligibility Verification",
  supported_types: ["student_status"],
  provider_category: "affiliation",
  real_provider_family: "sheerid",
  handoff_mode: "redirect",
  privacy_summary: [
    "Antigen stores only your institution name and verified status.",
    "No academic records, transcripts, or grades are ever shared.",
    "Raw eligibility data is never exposed to agents or websites.",
  ],
  agent_disclosure_summary: [
    "Agents can prove you are a verified student.",
    "Agents can prove your institution name.",
    "Agents cannot access underlying eligibility data.",
  ],
};

const SHEERID_MILITARY_DESCRIPTOR: ExternalVerificationProviderDescriptor = {
  provider_name: "sheerid_military",
  display_name: "Military Status Verification",
  supported_types: ["military_status"],
  provider_category: "affiliation",
  real_provider_family: "sheerid",
  handoff_mode: "redirect",
  privacy_summary: [
    "Antigen stores only your verified military affiliation status.",
    "No service records, rank, or deployment history are shared.",
    "Raw eligibility data is never exposed to agents or websites.",
  ],
  agent_disclosure_summary: [
    "Agents can prove you have verified military affiliation.",
    "Agents cannot access service records or personal military data.",
  ],
};

/**
 * Returns one descriptor per capability type.
 * Prefers real providers when env vars are explicitly set; falls back to mocks.
 * Reads env at call time so tests can override process.env in beforeEach.
 */
export function listExternalProviderDescriptors(): ExternalVerificationProviderDescriptor[] {
  const stripeEnabled =
    process.env.STRIPE_IDENTITY_ENABLED === "true" && !!process.env.STRIPE_SECRET_KEY;
  const sheerIdBaseEnabled =
    process.env.SHEERID_ENABLED === "true" && !!process.env.SHEERID_API_TOKEN;

  return [
    // government_id: real Stripe OR mock fallback — never both
    stripeEnabled ? STRIPE_IDENTITY_DESCRIPTOR : MOCK_STRIPE_IDENTITY,
    // student_status
    sheerIdBaseEnabled && !!process.env.SHEERID_STUDENT_PROGRAM_ID
      ? SHEERID_STUDENT_DESCRIPTOR
      : MOCK_SHEERID_STUDENT,
    // military_status
    sheerIdBaseEnabled && !!process.env.SHEERID_MILITARY_PROGRAM_ID
      ? SHEERID_MILITARY_DESCRIPTOR
      : MOCK_SHEERID_MILITARY,
  ];
}

/** Kept for backward compatibility; searches the dynamic list. */
export const EXTERNAL_PROVIDER_DESCRIPTORS: ExternalVerificationProviderDescriptor[] = [
  MOCK_STRIPE_IDENTITY,
  MOCK_SHEERID_STUDENT,
  MOCK_SHEERID_MILITARY,
];

export function findExternalProviderDescriptor(
  providerName: string
): ExternalVerificationProviderDescriptor | undefined {
  return listExternalProviderDescriptors().find(
    (d) => d.provider_name === (providerName as ExternalVerificationProviderName)
  );
}
