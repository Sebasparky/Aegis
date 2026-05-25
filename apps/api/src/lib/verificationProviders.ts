import type {
  VerificationType,
  AssuranceLevel,
  VerifiedClaim,
  VerificationProviderSession,
} from "@aegis/types";

export interface ProviderClaimResult {
  claims: Array<Omit<VerifiedClaim, "claim_id" | "card_id">>;
  assurance_level: AssuranceLevel;
  expires_at?: string;
}

export interface VerificationProvider {
  name: string;
  supported_types: VerificationType[];
  initiate(session: VerificationProviderSession): Promise<{
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

// ─── Registry ────────────────────────────────────────────────────────────────

export const PROVIDERS: VerificationProvider[] = [
  mockEmailProvider,
  mockStudentProvider,
  mockGovIdProvider,
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
