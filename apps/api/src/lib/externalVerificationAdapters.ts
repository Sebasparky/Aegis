import type {
  AssuranceLevel,
  ExternalVerificationProviderName,
  VerifiedClaimValue,
  VerificationType,
} from "@aegis/types";

// ─── Adapter contract ─────────────────────────────────────────────────────────

export interface StartExternalVerificationArgs {
  session_id: string;
  user_id: string;
  verification_type: VerificationType;
  return_url: string;
}

export interface StartExternalVerificationResult {
  provider_reference_id: string;
  handoff_url: string;
}

export type SyncExternalVerificationResult =
  | {
      status: "verified";
      claim_type: VerificationType;
      claim_value: VerifiedClaimValue;
      assurance_level: AssuranceLevel;
    }
  | { status: "pending" }
  | { status: "requires_input" }
  | { status: "failed"; failure_reason: string };

export interface ExternalVerificationAdapter {
  start(args: StartExternalVerificationArgs): Promise<StartExternalVerificationResult>;
  sync(provider_reference_id: string): Promise<SyncExternalVerificationResult>;
}

// ─── Mock adapter ─────────────────────────────────────────────────────────────
// Wraps the same instant-complete behavior used by the /mock-complete route.

export class MockAdapter implements ExternalVerificationAdapter {
  constructor(private readonly providerName: ExternalVerificationProviderName) {}

  async start(args: StartExternalVerificationArgs): Promise<StartExternalVerificationResult> {
    return {
      provider_reference_id: `mock_ref_${Date.now()}`,
      handoff_url: `mock://${args.session_id}`,
    };
  }

  async sync(_provider_reference_id: string): Promise<SyncExternalVerificationResult> {
    if (this.providerName === "mock_sheerid_student") {
      return {
        status: "verified",
        claim_type: "student_status",
        claim_value: {
          kind: "student_status",
          institution_name: "University of Michigan",
          enrollment_status: "active",
          status: "verified_student",
          verification_method: "provider_handoff",
          provider: "mock_sheerid_student",
          institution_domain: "umich.edu",
        },
        assurance_level: "provider_verified",
      };
    }
    if (this.providerName === "mock_sheerid_military") {
      return {
        status: "verified",
        claim_type: "military_status",
        claim_value: {
          kind: "military_status",
          status: "verified_military_affiliation",
          verification_method: "provider_handoff",
          provider: "mock_sheerid_military",
          affiliation: "military",
        },
        assurance_level: "provider_verified",
      };
    }
    // mock_stripe_identity
    return {
      status: "verified",
      claim_type: "government_id",
      claim_value: {
        kind: "government_id",
        status: "identity_verified",
        verification_method: "provider_handoff",
        provider: "mock_stripe_identity",
        identity_assurance_level: "mock_document_selfie",
      },
      assurance_level: "document_verified",
    };
  }
}

// ─── Stripe Identity adapter ──────────────────────────────────────────────────
// Antigen uses Stripe Identity to verify users for its own trust/account workflow,
// then issues a minimal signed VerificationCard. No raw Stripe payload is retained.

export class StripeIdentityAdapter implements ExternalVerificationAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stripePromise: Promise<any> | null = null;

  constructor(private readonly secretKey: string) {}

  // Uses dynamic import so vitest's vi.mock("stripe", ...) can intercept it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getStripe(): Promise<any> {
    if (!this.stripePromise) {
      this.stripePromise = import("stripe").then(({ default: Stripe }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new (Stripe as any)(this.secretKey);
      });
    }
    return this.stripePromise;
  }

  async start(args: StartExternalVerificationArgs): Promise<StartExternalVerificationResult> {
    const stripe = await this.getStripe();
    let session: { id: string; url: string | null };
    try {
      session = await stripe.identity.verificationSessions.create({
        type: "document",
        client_reference_id: args.session_id,
        metadata: {
          antigen_session_id: args.session_id,
          user_id: args.user_id,
          verification_type: args.verification_type,
        },
        return_url: args.return_url,
      });
    } catch (err) {
      throw new Error(
        `Stripe verification session creation failed: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }

    if (!session.url) {
      throw new Error("Stripe did not return a verification URL for this session.");
    }

    return {
      provider_reference_id: session.id,
      handoff_url: session.url,
    };
  }

  async sync(provider_reference_id: string): Promise<SyncExternalVerificationResult> {
    const stripe = await this.getStripe();
    let session: { status: string; last_error?: { reason?: string } | null };
    try {
      session = await stripe.identity.verificationSessions.retrieve(provider_reference_id);
    } catch (err) {
      throw new Error(
        `Stripe verification session retrieval failed: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }

    switch (session.status) {
      case "verified":
        return {
          status: "verified",
          claim_type: "government_id",
          claim_value: {
            kind: "government_id",
            status: "identity_verified",
            verification_method: "provider_handoff",
            provider: "stripe_identity",
            identity_assurance_level: "document_verified",
          },
          assurance_level: "document_verified",
        };
      case "processing":
        return { status: "pending" };
      case "requires_input":
        return { status: "requires_input" };
      case "canceled":
        return { status: "failed", failure_reason: "Verification was cancelled." };
      default:
        return { status: "pending" };
    }
  }
}

// ─── SheerID adapter (scaffold) ───────────────────────────────────────────────
// Full SheerID integration is a future increment. The scaffold provides clear
// error messages and a stable interface for when program IDs become available.

export class SheerIDAdapter implements ExternalVerificationAdapter {
  async start(_args: StartExternalVerificationArgs): Promise<StartExternalVerificationResult> {
    throw new Error(
      "SHEERID_INTEGRATION_PENDING: SheerID adapter is not yet implemented. " +
        "Set SHEERID_API_TOKEN and the relevant SHEERID_*_PROGRAM_ID env vars " +
        "and implement this adapter in a future increment."
    );
  }

  async sync(_provider_reference_id: string): Promise<SyncExternalVerificationResult> {
    throw new Error(
      "SHEERID_INTEGRATION_PENDING: SheerID adapter is not yet implemented."
    );
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function getAdapter(
  providerName: ExternalVerificationProviderName
): ExternalVerificationAdapter {
  if (providerName === "stripe_identity") {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not configured.");
    return new StripeIdentityAdapter(key);
  }
  if (providerName === "sheerid_student" || providerName === "sheerid_military") {
    return new SheerIDAdapter();
  }
  // All mock_* providers
  return new MockAdapter(providerName);
}
