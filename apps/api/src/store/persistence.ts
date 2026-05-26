import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import type { Collar, AgentTask, AgentDelegation, AgentConnector, AegisRoute, Skill, PublishedSkillVersion, InstalledSkill, RouteRun, RouteRunReceipt, AegisVaultPass, RoutePassBinding, DelegationPassport, ActionAuthorizationReceipt, WebsiteTrustAssertion, PaymentMethod, SpendingLimitStepUp, SecretFieldInjection, CredentialUseAuthorization, SecurityChallenge, ChallengeEmailResolution, AegisWorkspace, WorkspaceTask, WorkspaceArtifact, UserApprovalReceipt, WebsiteTrustProfile, WebsiteViolationReceipt, SensitiveGrant, PaymentCardFillAuthorization, PaymentCardFillRequest, PurchaseConfirmationAuthorization, VerificationCard, DisclosureReceipt, TrustSignalDisclosureRecord, PrivateProfileMemoryItem, ProfileMemoryRequest } from "@aegis/types";
import { buildSignedWebsiteTrustProfile, STANDARD_SAFETY_PROMISES } from "../lib/websiteTrustProfileSigning.js";
import {
  users,
  collars,
  passes,
  sessions,
  approvals,
  receipts,
  reputationEvents,
  runnerTasks,
  domainTrust,
  agentTasks,
  agentDelegations,
  agentConnectors,
  routes,
  skills,
  publishedSkillVersions,
  installedSkills,
  routeRuns,
  routeRunReceipts,
  aegisVaultPasses,
  routePassBindings,
  encryptedSecretVault,
  credentialSessions,
  credentialFillRequests,
  delegationPassports,
  actionAuthorizations,
  userApprovalReceipts,
  websiteTrustAssertions,
  paymentMethods,
  spendingLimitStepUps,
  secretFieldInjections,
  credentialUseAuthorizations,
  securityChallenges,
  challengeEmailResolutions,
  aegisWorkspaces,
  workspaceTasks,
  workspaceArtifacts,
  workspaceAuditEvents,
  websiteTrustProfiles,
  websiteViolationReceipts,
  sensitiveGrants,
  paymentCardFillAuthorizations,
  paymentCardFillRequests,
  purchaseConfirmationAuthorizations,
  verificationCards,
  disclosureReceipts,
  trustSignalDisclosureRecords,
  privateProfileMemory,
  profileMemoryRequests,
} from "./index.js";
import type { User, PassWithToken, ReputationEvent, DomainTrustRecord, CredentialUseSession, CredentialFillRequest, WorkspaceAuditEvent } from "./index.js";
import type { EncryptedSecretBlob } from "../lib/kms.js";
import { getKmsProvider } from "../lib/kms.js";

const __filename = fileURLToPath(import.meta.url);
const DATA_DIR = join(dirname(__filename), "../../.data");
const DATA_FILE = join(DATA_DIR, "aegis-store.json");

// ─── Seed Data ────────────────────────────────────────────────────────────────

export async function seedDefaultData(): Promise<void> {
  const NOW = new Date().toISOString();

  const MOCK_USER: User = {
    id: "user_001",
    email: "demo@aegis.local",
    display_name: "Demo User",
    aegis_id: "aid_user_001",
    created_at: NOW,
    updated_at: NOW,
  };

  const STARTER_COLLAR: Collar = {
    id: "collar_demo_starter",
    user_id: "user_001",
    name: "Research & Action Starter",
    description:
      "A general-purpose starter collar. Browse and research freely. Require approval before committing to anything.",
    purpose: "Safely delegate research and action tasks to an outside agent.",
    status: "active",
    allowed_actions: [
      "browse", "search", "read", "compare", "draft", "add_to_cart",
      "workspace_read", "workspace_task_list", "workspace_task_claim",
      "workspace_task_complete", "workspace_artifact_create",
      "workspace_artifact_list", "workspace_artifact_read",
    ],
    approval_required_actions: [
      "login",
      "purchase",
      "payment",
      "share_email",
      "share_phone",
      "submit_form",
      "post_publicly",
      "upload_file",
      "send_email",
      "create_account",
    ],
    blocked_actions: [
      "subscription",
      "government_id_upload",
      "identity_disclosure",
      "medical_data_disclosure",
      "financial_data_disclosure",
      "delete_account",
    ],
    spending_limits: {
      max_without_approval: 0,
      max_with_approval: 100,
      subscriptions_allowed: false,
    },
    counterparty_rules: {
      sensitive_actions_require_verified_business: false,
      block_known_prompt_injection_sites: true,
    },
    session_limits: {
      max_duration_minutes: 120,
      max_active_sessions: 3,
    },
    created_at: NOW,
    updated_at: NOW,
  };

  users.set(MOCK_USER.id, MOCK_USER);
  collars.set(STARTER_COLLAR.id, STARTER_COLLAR);

  if (!collars.has("collar_research_001")) {
    collars.set("collar_research_001", {
      id: "collar_research_001",
      user_id: "user_001",
      name: "Research Collar",
      description: "A collar for research tasks. Grants the same workspace permissions as the starter collar.",
      purpose: "Identify agents with research capability for collar-required workspace tasks.",
      status: "active",
      allowed_actions: [
        "browse", "search", "read", "compare", "draft",
        "workspace_read", "workspace_task_list", "workspace_task_claim",
        "workspace_task_complete", "workspace_artifact_create",
        "workspace_artifact_list", "workspace_artifact_read",
      ],
      approval_required_actions: [
        "login", "purchase", "payment", "share_email", "share_phone",
        "submit_form", "post_publicly", "upload_file", "send_email", "create_account",
      ],
      blocked_actions: [
        "subscription", "government_id_upload", "identity_disclosure",
        "medical_data_disclosure", "financial_data_disclosure", "delete_account",
      ],
      spending_limits: { max_without_approval: 0, max_with_approval: 50, subscriptions_allowed: false },
      counterparty_rules: { sensitive_actions_require_verified_business: false, block_known_prompt_injection_sites: true },
      session_limits: { max_duration_minutes: 120, max_active_sessions: 3 },
      created_at: "2026-05-11T00:00:00.000Z",
      updated_at: "2026-05-11T00:00:00.000Z",
    });
  }
  if (!collars.has("collar_review_001")) {
    collars.set("collar_review_001", {
      id: "collar_review_001",
      user_id: "user_001",
      name: "Review Collar",
      description: "A collar for review tasks. Grants the same workspace permissions as the research collar.",
      purpose: "Identify agents with review capability for collar-required workspace tasks.",
      status: "active",
      allowed_actions: [
        "browse", "search", "read", "compare", "draft",
        "workspace_read", "workspace_task_list", "workspace_task_claim",
        "workspace_task_complete", "workspace_artifact_create",
        "workspace_artifact_list", "workspace_artifact_read",
      ],
      approval_required_actions: [
        "login", "purchase", "payment", "travel_booking", "share_email", "share_phone",
        "submit_form", "post_publicly", "upload_file", "send_email", "create_account",
      ],
      blocked_actions: [
        "subscription", "government_id_upload", "identity_disclosure",
        "medical_data_disclosure", "financial_data_disclosure", "delete_account",
      ],
      spending_limits: { max_without_approval: 0, max_with_approval: 50, subscriptions_allowed: false },
      counterparty_rules: { sensitive_actions_require_verified_business: false, block_known_prompt_injection_sites: true },
      session_limits: { max_duration_minutes: 120, max_active_sessions: 3 },
      created_at: "2026-05-11T00:00:00.000Z",
      updated_at: "2026-05-11T00:00:00.000Z",
    });
  }

  // Seed passes for demo delegations so validatePassToken can resolve bearer tokens.
  // For demo tokens, id === token (demo shorthand; production uses distinct values).
  const DEMO_PASS_EXPIRY = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  if (!passes.has("pass_demo_001")) {
    passes.set("pass_demo_001", {
      id: "pass_demo_001", token: "pass_demo_001", user_id: "user_001",
      agent_name: "agent_demo_001", default_collar_id: "collar_research_001",
      status: "active", expires_at: DEMO_PASS_EXPIRY, created_at: "2026-04-30T12:00:00.000Z",
    });
  }
  if (!passes.has("pass_demo_002")) {
    passes.set("pass_demo_002", {
      id: "pass_demo_002", token: "pass_demo_002", user_id: "user_001",
      agent_name: "agent_demo_restricted", default_collar_id: "collar_review_001",
      status: "active", expires_at: DEMO_PASS_EXPIRY, created_at: "2026-04-30T12:00:01.000Z",
    });
  }

  if (!agentDelegations.has("delg_demo_001")) {
    agentDelegations.set("delg_demo_001", {
      id: "delg_demo_001", user_id: "user_001", user_aegis_id: "aid_user_001",
      agent_name: "agent_demo_001", agent_platform: "api", channel: "api",
      default_collar_id: "collar_research_001", status: "active",
      token_id: "pass_demo_001", skill_access_mode: "all", skill_access_skill_ids: [],
      created_at: "2026-04-30T12:00:00.000Z", updated_at: "2026-04-30T12:00:00.000Z",
    });
  }
  if (!agentDelegations.has("delg_demo_restricted")) {
    agentDelegations.set("delg_demo_restricted", {
      id: "delg_demo_restricted", user_id: "user_001", user_aegis_id: "aid_user_001",
      agent_name: "agent_demo_restricted", agent_platform: "api", channel: "api",
      default_collar_id: "collar_review_001", status: "active",
      token_id: "pass_demo_002", skill_access_mode: "only", skill_access_skill_ids: [],
      created_at: "2026-04-30T12:00:01.000Z", updated_at: "2026-04-30T12:00:01.000Z",
    });
  }

  // Shopping Collar — generic third-party agent delegation for ecommerce tasks.
  if (!collars.has("collar_shopping_001")) {
    collars.set("collar_shopping_001", {
      id: "collar_shopping_001",
      user_id: "user_001",
      name: "Shopping Agent Collar",
      description: "Scoped collar for agents that browse and purchase on behalf of users.",
      purpose: "Allow agents to search, compare, and request purchase approvals.",
      status: "active",
      allowed_actions: ["browse", "search", "read", "compare", "add_to_cart"] as any,
      approval_required_actions: ["purchase", "payment", "login", "submit_form"] as any,
      blocked_actions: [
        "identity_disclosure", "subscription", "delete_account",
        "financial_data_disclosure", "government_id_upload",
      ] as any,
      spending_limits: { max_without_approval: 0, max_with_approval: 250, subscriptions_allowed: false },
      counterparty_rules: { sensitive_actions_require_verified_business: false, block_known_prompt_injection_sites: true },
      session_limits: { max_duration_minutes: 120, max_active_sessions: 2 },
      created_at: "2026-05-19T00:00:00.000Z",
      updated_at: "2026-05-19T00:00:00.000Z",
    });
  }
  if (!passes.has("pass_demo_shopping_001")) {
    passes.set("pass_demo_shopping_001", {
      id: "pass_demo_shopping_001", token: "tok_demo_shopping_001", user_id: "user_001",
      agent_name: "demo_shopping_agent", default_collar_id: "collar_shopping_001",
      status: "active", expires_at: DEMO_PASS_EXPIRY, created_at: "2026-05-19T00:00:00.000Z",
    });
  }
  if (!agentDelegations.has("delg_demo_shopping_001")) {
    agentDelegations.set("delg_demo_shopping_001", {
      id: "delg_demo_shopping_001", user_id: "user_001", user_aegis_id: "aid_user_001",
      agent_name: "demo_shopping_agent", agent_platform: "api", channel: "api",
      default_collar_id: "collar_shopping_001", status: "active",
      token_id: "pass_demo_shopping_001", skill_access_mode: "all", skill_access_skill_ids: [],
      created_at: "2026-05-19T00:00:00.000Z", updated_at: "2026-05-19T00:00:00.000Z",
    });
  }

  if (!aegisWorkspaces.has("ws_coord_trial_001")) {
    aegisWorkspaces.set("ws_coord_trial_001", {
      workspace_id: "ws_coord_trial_001",
      owner_user_id: "user_001",
      name: "Coordination Trial Workspace",
      description: "Three-task coordination trial. collar_demo_starter agents handle research and review; any agent handles the open analysis task.",
      collar_id: "collar_demo_starter",
      participant_delegation_ids: ["delg_demo_001", "delg_demo_restricted"],
      status: "active",
      created_at: "2026-05-11T00:00:00.000Z",
      updated_at: "2026-05-11T00:00:00.000Z",
    });
  }
  if (!workspaceTasks.has("task_coord_001")) {
    workspaceTasks.set("task_coord_001", {
      task_id: "task_coord_001",
      workspace_id: "ws_coord_trial_001",
      title: "Research Antigen product pillars",
      description: "Research and document the five Antigen pillars: AntigenID, Delegation & Collars, Antigen Rails, Antigen Guard, and Audit Trail. Write 2-3 sentences each. Create a markdown artifact named `antigen-pillars-summary.md` linked to this task. Mark the task complete after creating the artifact.",
      status: "open",
      assignment_type: "collar",
      required_collar_id: "collar_research_001",
      task_kind: "research",
      task_mode: "direct",
      priority: "high",
      depends_on_task_ids: [],
      required_artifact_names: [],
      created_by_user_id: "user_001",
      created_at: "2026-05-11T00:00:00.000Z",
      updated_at: "2026-05-11T00:00:00.000Z",
    });
  }
  if (!workspaceTasks.has("task_coord_002")) {
    workspaceTasks.set("task_coord_002", {
      task_id: "task_coord_002",
      workspace_id: "ws_coord_trial_001",
      title: "Review and prioritize Antigen pillars",
      description: "Read the `antigen-pillars-summary.md` artifact. Identify the most important Antigen capability and write a 3-bullet argument for why it matters. Create a markdown artifact named `antigen-pillars-review.md` linked to this task. Mark the task complete after creating the artifact.",
      status: "open",
      assignment_type: "collar",
      required_collar_id: "collar_review_001",
      task_kind: "review",
      task_mode: "plan_first",
      priority: "normal",
      depends_on_task_ids: ["task_coord_001"],
      required_artifact_names: ["antigen-pillars-summary.md"],
      created_by_user_id: "user_001",
      created_at: "2026-05-11T00:01:00.000Z",
      updated_at: "2026-05-11T00:01:00.000Z",
    });
  }
  if (!workspaceTasks.has("task_coord_003")) {
    workspaceTasks.set("task_coord_003", {
      task_id: "task_coord_003",
      workspace_id: "ws_coord_trial_001",
      title: "Analyze workspace usage patterns",
      description: "Review the artifacts created in this workspace and produce a brief analysis of how agents used it. Create a markdown artifact named `workspace-usage-analysis.md` linked to this task. Mark the task complete after creating the artifact.",
      status: "open",
      assignment_type: "open",
      task_kind: "analysis",
      task_mode: "direct",
      priority: "low",
      depends_on_task_ids: [],
      required_artifact_names: [],
      created_by_user_id: "user_001",
      created_at: "2026-05-11T00:02:00.000Z",
      updated_at: "2026-05-11T00:02:00.000Z",
    });
  }

  ensureWebsiteTrustSeeds(NOW);
  await ensureWebsiteTrustProfileSeeds(NOW);

  // Seed demo vault pass metadata (also needed after resetStoreForDemo clears all maps)
  if (!aegisVaultPasses.has("pass_vault_demo_login_001")) {
    const DEMO_VAULT_PASS: AegisVaultPass = {
      pass_id: "pass_vault_demo_login_001",
      user_id: "user_001",
      label: "Demo Login Account",
      kind: "login_password",
      domain: "localhost",
      username: "demo_user",
      secret_ref: "devvault://demo-login-password",
      created_at: "2026-04-30T12:00:00.000Z",
      updated_at: "2026-04-30T12:00:00.000Z",
    };
    aegisVaultPasses.set("pass_vault_demo_login_001", DEMO_VAULT_PASS);
  }

  // Encrypt and store demo password via KMS
  if (!encryptedSecretVault.has("devvault://demo-login-password")) {
    try {
      const kms = getKmsProvider();
      const blob = await kms.encryptSecret("demo_pass", {
        user_id: "user_001",
        pass_id: "pass_vault_demo_login_001",
        domain: "localhost",
        purpose: "login_password",
      });
      encryptedSecretVault.set("devvault://demo-login-password", blob);
    } catch (err) {
      console.error("[persistence] Failed to encrypt demo password — KMS may not be configured:", err);
      // Server continues in degraded state — demo login will fail with SECRET_NOT_AVAILABLE
    }
  }

  await seedProfileMemory();
}

async function seedProfileMemory(): Promise<void> {
  const NOW = new Date().toISOString();
  const kms = getKmsProvider();

  const FIELDS: Array<{ id: string; kind: PrivateProfileMemoryItem["field_kind"]; value: string }> = [
    { id: "ppm_first_name_001",    kind: "first_name",             value: "Alex" },
    { id: "ppm_last_name_001",     kind: "last_name",              value: "Demo" },
    { id: "ppm_email_001",         kind: "email",                  value: "alex@aegisdemo.local" },
    { id: "ppm_phone_001",         kind: "phone",                  value: "15551234567" },
    { id: "ppm_addr_line1_001",    kind: "shipping_address_line1", value: "123 Main St" },
    { id: "ppm_city_001",          kind: "city",                   value: "Ann Arbor" },
    { id: "ppm_region_001",        kind: "region",                 value: "MI" },
    { id: "ppm_postal_code_001",   kind: "postal_code",            value: "48104" },
    { id: "ppm_country_001",       kind: "country",                value: "US" },
  ];

  for (const { id, kind, value } of FIELDS) {
    if (privateProfileMemory.has(id)) continue;
    try {
      const blob = await kms.encryptSecret(value, {
        user_id: "user_001",
        pass_id: id,
        domain: "aegisdemo.local",
        purpose: "profile_field",
      });
      encryptedSecretVault.set(id, blob);
      privateProfileMemory.set(id, {
        memory_id: id,
        user_id: "user_001",
        field_kind: kind,
        value_ref: `ppvault://${id}/value`,
        data_class: 2,
        sensitivity: "private",
        default_disclosure_mode: "fill_only",
        agent_visible_allowed: false,
        provenance: { source: "seeded", domain_at_creation: "aegisdemo.local" },
        created_at: NOW,
        updated_at: NOW,
        user_editable: true,
        uses: [],
      });
    } catch (err) {
      console.error(`[persistence] Failed to seed profile field ${id} — KMS may not be configured:`, err);
    }
  }
}

function ensureWebsiteTrustSeeds(now?: string): void {
  const NOW = now ?? new Date().toISOString();

  if (!domainTrust.has("localhost")) {
    domainTrust.set("localhost", {
      id: "wtr_demo_localhost",
      domain: "localhost",
      website_aegis_id: "web_aegis_demo_store",
      business_name: "AntigenDemo Store",
      domain_verified: true,
      business_verified: true,
      business_aegis_id: "web_aegis_demo_store",
      trust_label: "verified_demo_business",
      agent_policy_published: true,
      known_prompt_injection_reports: 0,
      known_dispute_count: 0,
      created_at: NOW,
      updated_at: NOW,
    });
  }

  if (!domainTrust.has("example-store.local")) {
    domainTrust.set("example-store.local", {
      id: "wtr_demo_example_store",
      domain: "example-store.local",
      website_aegis_id: "web_aegis_demo_store",
      business_name: "AntigenDemo Store",
      domain_verified: true,
      business_verified: true,
      business_aegis_id: "web_aegis_demo_store",
      trust_label: "verified_demo_business",
      agent_policy_published: true,
      known_prompt_injection_reports: 0,
      known_dispute_count: 0,
      created_at: NOW,
      updated_at: NOW,
    });
  }

  if (!domainTrust.has("bad-store.local")) {
    domainTrust.set("bad-store.local", {
      id: "wtr_flagged_bad_store",
      domain: "bad-store.local",
      website_aegis_id: "web_aegis_flagged_001",
      business_name: "Bad Store (Demo Flagged)",
      domain_verified: false,
      business_verified: false,
      trust_label: "flagged",
      agent_policy_published: false,
      known_prompt_injection_reports: 3,
      known_dispute_count: 2,
      created_at: NOW,
      updated_at: NOW,
    });
  }
}

async function ensureWebsiteTrustProfileSeeds(now?: string): Promise<void> {
  if (websiteTrustProfiles.has("wtp_demo_localhost_001")) return;

  const NOW = now ?? new Date().toISOString();

  const allCommitted = STANDARD_SAFETY_PROMISES.map((p) => ({ ...p, committed: true }));
  const noneCommitted = STANDARD_SAFETY_PROMISES.map((p) => ({ ...p, committed: false }));

  const verifiedFields: Omit<WebsiteTrustProfile, "profile_hash" | "profile_jws" | "jws_present"> = {
    profile_id: "wtp_demo_localhost_001",
    website_aegis_id: "web_aegis_demo_store",
    domain: "localhost",
    company_name: "AntigenDemo Store",
    verification_status: "verified",
    verified_at: NOW,
    profile_version: "1",
    status: "active",
    created_at: NOW,
    updated_at: NOW,
    agent_policy: {
      allowed_agent_actions: ["browse", "search", "add_to_cart", "login"],
      prohibited_agent_actions: ["account_deletion", "subscription_signup"],
      sensitive_actions_require_aegis_approval: true,
      credential_handling_policy:
        "Credentials handled exclusively via Antigen-controlled injection. No raw credentials accepted by page scripts.",
      payment_action_policy:
        "All payment actions require Antigen approval gate. No auto-payment without explicit user confirmation.",
      data_usage_policy:
        "Agent session data used only for task completion. Not stored or shared beyond the session.",
      prompt_injection_commitment:
        "Page content does not embed agent instruction overrides or hidden system-prompt injections.",
      agent_safe_interaction_commitment:
        "All sensitive actions expose machine-readable Antigen metadata for detection and governance.",
    },
    safety_promises: allCommitted,
    reputation_score: 100,
    last_reviewed_at: NOW,
    violation_count: 0,
    accountability_contact: "trust@aegisdemo.local",
    policy_url: "http://localhost:3000/.well-known/aegis-policy.json",
  };

  try {
    const signed = await buildSignedWebsiteTrustProfile(verifiedFields);
    websiteTrustProfiles.set(signed.profile_id, signed);
  } catch (err) {
    console.error("[persistence] Failed to seed localhost WebsiteTrustProfile:", err);
  }

  const unverifiedFields: Omit<WebsiteTrustProfile, "profile_hash" | "profile_jws" | "jws_present"> = {
    profile_id: "wtp_demo_example_store_001",
    website_aegis_id: "web_aegis_example_store",
    domain: "example-store.local",
    company_name: "Example Store (Unverified)",
    verification_status: "unverified",
    profile_version: "1",
    status: "active",
    created_at: NOW,
    updated_at: NOW,
    agent_policy: {
      allowed_agent_actions: ["browse", "search"],
      prohibited_agent_actions: [],
      sensitive_actions_require_aegis_approval: false,
      credential_handling_policy: "Not declared.",
      payment_action_policy: "Not declared.",
      data_usage_policy: "Not declared.",
      prompt_injection_commitment: "Not declared.",
      agent_safe_interaction_commitment: "Not declared.",
    },
    safety_promises: noneCommitted,
    violation_count: 0,
  };

  try {
    const signed = await buildSignedWebsiteTrustProfile(unverifiedFields);
    websiteTrustProfiles.set(signed.profile_id, signed);
  } catch (err) {
    console.error("[persistence] Failed to seed example-store WebsiteTrustProfile:", err);
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export function persistStore(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const data = {
      users: Array.from(users.entries()),
      collars: Array.from(collars.entries()),
      passes: Array.from(passes.entries()),
      sessions: Array.from(sessions.entries()),
      approvals: Array.from(approvals.entries()),
      receipts: Array.from(receipts.entries()),
      reputationEvents: Array.from(reputationEvents.entries()),
      runnerTasks: Array.from(runnerTasks.entries()),
      domainTrust: Array.from(domainTrust.entries()),
      agentTasks: Array.from(agentTasks.entries()),
      agentDelegations: Array.from(agentDelegations.entries()),
      agentConnectors: Array.from(agentConnectors.entries()),
      routes: Array.from(routes.entries()),
      skills: Array.from(skills.entries()),
      publishedSkillVersions: Array.from(publishedSkillVersions.entries()),
      installedSkills: Array.from(installedSkills.entries()),
      routeRuns: Array.from(routeRuns.entries()),
      routeRunReceipts: Array.from(routeRunReceipts.entries()),
      aegisVaultPasses: Array.from(aegisVaultPasses.entries()),
      routePassBindings: Array.from(routePassBindings.entries()),
      credentialSessions: Array.from(credentialSessions.entries()),
      credentialFillRequests: Array.from(credentialFillRequests.entries()),
      delegationPassports: Array.from(delegationPassports.entries()),
      actionAuthorizations: Array.from(actionAuthorizations.entries()),
      userApprovalReceipts: Array.from(userApprovalReceipts.entries()),
      websiteTrustAssertionEntries: Array.from(websiteTrustAssertions.entries()),
      paymentMethods: Array.from(paymentMethods.entries()),
      spendingLimitStepUps: Array.from(spendingLimitStepUps.entries()),
      secretFieldInjections: Array.from(secretFieldInjections.entries()),
      credentialUseAuthorizations: Array.from(credentialUseAuthorizations.entries()),
      securityChallenges: Array.from(securityChallenges.entries()),
      challengeEmailResolutions: Array.from(challengeEmailResolutions.entries()),
      aegisWorkspaces: Array.from(aegisWorkspaces.entries()),
      workspaceTasks: Array.from(workspaceTasks.entries()),
      workspaceArtifacts: Array.from(workspaceArtifacts.entries()),
      workspaceAuditEvents: Array.from(workspaceAuditEvents.entries()),
      websiteTrustProfiles: Array.from(websiteTrustProfiles.entries()),
      websiteViolationReceipts: Array.from(websiteViolationReceipts.entries()),
      sensitiveGrants: Array.from(sensitiveGrants.entries()),
      paymentCardFillAuthorizations: Array.from(paymentCardFillAuthorizations.entries()),
      paymentCardFillRequests: Array.from(paymentCardFillRequests.entries()),
      purchaseConfirmationAuthorizations: Array.from(purchaseConfirmationAuthorizations.entries()),
      // purchaseConfirmationHandoffs intentionally omitted — ephemeral audit records.
      verificationCards: Array.from(verificationCards.entries()),
      disclosureReceipts: Array.from(disclosureReceipts.entries()),
      trustSignalDisclosureRecords: Array.from(trustSignalDisclosureRecords.entries()),
      // verificationProviderSessions intentionally omitted — ephemeral; browser context gone on restart.
      privateProfileMemory: Array.from(privateProfileMemory.entries()),
      profileMemoryRequests: Array.from(profileMemoryRequests.entries()),
      // profileFieldFillRequests intentionally omitted — ephemeral (CDP context gone on restart).
      // Encrypted blobs only — plaintext is never persisted.
      encryptedSecretVaultEntries: Array.from(encryptedSecretVault.entries()),
      // devSecretVaultEntries intentionally omitted — plaintext no longer persisted.
      // Old aegis-store.json files may contain devSecretVaultEntries; those are silently ignored on load.
    };
    writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[persistence] Failed to persist store:", err);
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function schedulePersist(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    persistStore();
  }, 300);
}

export async function loadStore(): Promise<void> {
  if (!existsSync(DATA_FILE)) {
    console.log("[persistence] No data file found — seeding default data.");
    await seedDefaultData();
    return;
  }

  try {
    const raw = readFileSync(DATA_FILE, "utf-8");
    const data = JSON.parse(raw);

    for (const [k, v] of (data.users ?? [])) users.set(k, v as User);
    for (const [k, v] of (data.collars ?? [])) collars.set(k, v as Collar);
    for (const [k, v] of (data.passes ?? [])) passes.set(k, v as PassWithToken);
    for (const [k, v] of (data.sessions ?? [])) {
      const s = v as any;
      // Browser contexts cannot survive restart — mark lingering sessions as error
      if (s.status === "active" || s.status === "waiting_for_approval") {
        s.status = "error";
      }
      sessions.set(k, s);
    }
    for (const [k, v] of (data.approvals ?? [])) approvals.set(k, v as any);
    for (const [k, v] of (data.receipts ?? [])) receipts.set(k, v as any);
    for (const [k, v] of (data.reputationEvents ?? [])) reputationEvents.set(k, v as ReputationEvent);
    for (const [k, v] of (data.runnerTasks ?? [])) runnerTasks.set(k, v as any);
    for (const [k, v] of (data.domainTrust ?? [])) domainTrust.set(k, v as DomainTrustRecord);
    for (const [k, v] of (data.agentTasks ?? [])) agentTasks.set(k, v as AgentTask);
    for (const [k, v] of (data.agentDelegations ?? [])) agentDelegations.set(k, v as AgentDelegation);
    for (const [k, v] of (data.agentConnectors ?? [])) agentConnectors.set(k, v as AgentConnector);
    for (const [k, v] of (data.routes ?? [])) routes.set(k, v as AegisRoute);
    for (const [k, v] of (data.skills ?? [])) skills.set(k, v as Skill);
    for (const [k, v] of (data.publishedSkillVersions ?? [])) publishedSkillVersions.set(k, v as PublishedSkillVersion);
    // Backward compat: skills persisted before listing_status was added default to 'active'.
    for (const [k, s] of skills.entries()) {
      if (!s.listing_status) { s.listing_status = 'active'; skills.set(k, s); }
    }
    for (const [k, v] of (data.installedSkills ?? [])) installedSkills.set(k, v as InstalledSkill);
    for (const [k, v] of (data.routeRuns ?? [])) routeRuns.set(k, v as RouteRun);
    for (const [k, v] of (data.routeRunReceipts ?? [])) routeRunReceipts.set(k, v as RouteRunReceipt);
    for (const [k, v] of (data.aegisVaultPasses ?? [])) aegisVaultPasses.set(k, v as AegisVaultPass);
    for (const [k, v] of (data.routePassBindings ?? [])) routePassBindings.set(k, v as RoutePassBinding);
    for (const [k, v] of (data.credentialSessions ?? [])) credentialSessions.set(k, v as CredentialUseSession);
    for (const [k, v] of (data.credentialFillRequests ?? [])) credentialFillRequests.set(k, v as CredentialFillRequest);
    for (const [k, v] of (data.delegationPassports ?? [])) delegationPassports.set(k, v as DelegationPassport);
    for (const [k, v] of (data.actionAuthorizations ?? [])) actionAuthorizations.set(k, v as ActionAuthorizationReceipt);
    for (const [k, v] of (data.userApprovalReceipts ?? [])) userApprovalReceipts.set(k, v as UserApprovalReceipt);
    for (const [k, v] of (data.websiteTrustAssertionEntries ?? [])) websiteTrustAssertions.set(k, v as WebsiteTrustAssertion);
    for (const [k, v] of (data.websiteTrustProfiles ?? [])) websiteTrustProfiles.set(k, v as WebsiteTrustProfile);
    for (const [k, v] of (data.websiteViolationReceipts ?? [])) websiteViolationReceipts.set(k, v as WebsiteViolationReceipt);
    for (const [k, v] of (data.paymentMethods ?? [])) paymentMethods.set(k, v as PaymentMethod);
    for (const [k, v] of (data.spendingLimitStepUps ?? [])) spendingLimitStepUps.set(k, v as SpendingLimitStepUp);

    for (const [k, v] of (data.aegisWorkspaces ?? [])) aegisWorkspaces.set(k, v as AegisWorkspace);
    for (const [k, v] of (data.workspaceTasks ?? [])) workspaceTasks.set(k, v as WorkspaceTask);
    for (const [k, v] of (data.workspaceArtifacts ?? [])) workspaceArtifacts.set(k, v as WorkspaceArtifact);
    for (const [k, v] of (data.workspaceAuditEvents ?? [])) workspaceAuditEvents.set(k, v as WorkspaceAuditEvent);

    for (const [k, v] of (data.verificationCards ?? [])) verificationCards.set(k, v as VerificationCard);
    for (const [k, v] of (data.disclosureReceipts ?? [])) disclosureReceipts.set(k, v as DisclosureReceipt);
    for (const [k, v] of (data.trustSignalDisclosureRecords ?? [])) trustSignalDisclosureRecords.set(k, v as TrustSignalDisclosureRecord);
    for (const [k, v] of (data.privateProfileMemory ?? [])) privateProfileMemory.set(k, v as PrivateProfileMemoryItem);
    // profileFieldFillRequests: not persisted — ephemeral by design (CDP context gone on restart).

    // Profile memory requests — pending_user requests are expired on restart (CDP context may be gone).
    for (const [k, v] of (data.profileMemoryRequests ?? [])) {
      const r = v as ProfileMemoryRequest;
      if (r.status === "pending_user") r.status = "expired";
      profileMemoryRequests.set(k, r);
    }
    // verificationProviderSessions: not persisted — ephemeral by design.

    // Injection requests cannot survive restart — CDP browser context is gone.
    for (const [k, v] of (data.secretFieldInjections ?? [])) {
      const inj = v as SecretFieldInjection;
      if (["pending_approval", "approved", "executing"].includes(inj.status)) {
        inj.status = "expired";
      }
      secretFieldInjections.set(k, inj);
    }

    // Credential-use authorizations cannot survive restart — they are session-scoped.
    for (const [k, v] of (data.credentialUseAuthorizations ?? [])) {
      const auth = v as CredentialUseAuthorization;
      if (auth.status === "pending_approval" || auth.status === "approved") {
        auth.status = "expired";
      }
      // Migrate pre-fulfillment records that lack the new required fields
      if (!auth.use_counts) auth.use_counts = { username: 0, password: 0 };
      if (!auth.max_uses_per_field) auth.max_uses_per_field = { username: 1, password: 1 };
      if (!auth.used_field_kinds) auth.used_field_kinds = [];
      if (auth.persistence_allowed === undefined) (auth as any).persistence_allowed = false;
      if (auth.browser_storage_allowed === undefined) (auth as any).browser_storage_allowed = false;
      if (auth.website_save_allowed === undefined) (auth as any).website_save_allowed = false;
      credentialUseAuthorizations.set(k, auth);
    }

    // Security challenge metadata — cannot survive restart (browser context + codes are gone).
    for (const [k, v] of (data.securityChallenges ?? [])) {
      const ch = v as SecurityChallenge;
      if (ch.status === "pending_user" || ch.status === "code_submitted") {
        ch.status = "expired";
      }
      securityChallenges.set(k, ch);
    }

    // Sensitive grants are session-bound — active grants are expired on restart because the
    // linked CredentialUseAuthorization or SecurityChallenge is also expired after restart.
    for (const [k, v] of (data.sensitiveGrants ?? [])) {
      const grant = v as SensitiveGrant;
      if (grant.status === "active") {
        grant.status = "expired";
      }
      sensitiveGrants.set(k, grant);
    }

    // Email resolution requests — pending/searching states cannot resume after restart
    // (Gmail search cannot be re-triggered automatically; resolutionCodes are memory-only and gone).
    for (const [k, v] of (data.challengeEmailResolutions ?? [])) {
      const res = v as ChallengeEmailResolution;
      if (res.status === "pending_approval" || res.status === "searching") {
        res.status = "expired";
        res.updated_at = new Date().toISOString();
      }
      challengeEmailResolutions.set(k, res);
    }

    // Payment card fill authorizations cannot survive restart — CDP browser context is gone.
    for (const [k, v] of (data.paymentCardFillAuthorizations ?? [])) {
      const auth = v as PaymentCardFillAuthorization;
      if (auth.status === "pending_approval" || auth.status === "approved") {
        auth.status = "expired";
      }
      paymentCardFillAuthorizations.set(k, auth);
    }

    // Payment card fill requests — same expiry logic.
    for (const [k, v] of (data.paymentCardFillRequests ?? [])) {
      const req = v as PaymentCardFillRequest;
      if (["pending_approval", "approved", "executing"].includes(req.status)) {
        req.status = "expired";
      }
      paymentCardFillRequests.set(k, req);
    }

    // Purchase confirmation authorizations cannot survive restart — CDP browser context is gone.
    for (const [k, v] of (data.purchaseConfirmationAuthorizations ?? [])) {
      const auth = v as PurchaseConfirmationAuthorization;
      if (auth.status === "pending_approval" || auth.status === "approved") {
        auth.status = "expired";
      }
      purchaseConfirmationAuthorizations.set(k, auth);
    }

    // Load encrypted vault blobs (ciphertext only — never plaintext).
    // Old devSecretVaultEntries from pre-KMS store files are silently ignored.
    for (const [k, v] of (data.encryptedSecretVaultEntries ?? [])) {
      encryptedSecretVault.set(k, v as EncryptedSecretBlob);
    }

    // Self-healing: if the demo pass metadata was loaded but its encrypted secret is missing
    // (e.g., after npm run seed:demo which doesn't write encryptedSecretVaultEntries),
    // encrypt it now so the demo works without manual intervention.
    const demoPass = aegisVaultPasses.get("pass_vault_demo_login_001");
    if (demoPass && !encryptedSecretVault.has(demoPass.secret_ref)) {
      console.log("[persistence] Self-healing: demo pass secret missing — encrypting now.");
      try {
        const kms = getKmsProvider();
        const blob = await kms.encryptSecret("demo_pass", {
          user_id: demoPass.user_id,
          pass_id: demoPass.pass_id,
          domain: demoPass.domain,
          purpose: "login_password",
        });
        encryptedSecretVault.set(demoPass.secret_ref, blob);
        schedulePersist();
      } catch (err) {
        console.error("[persistence] Self-healing failed — KMS may not be configured:", err);
      }
    }

    ensureWebsiteTrustSeeds();
    await ensureWebsiteTrustProfileSeeds();

    const errorCount = Array.from(sessions.values()).filter(
      (s) => (s as any).status === "error"
    ).length;
    console.log(
      `[persistence] Loaded store from ${DATA_FILE} — ${sessions.size} sessions (${errorCount} marked error on restart)`
    );
  } catch (err) {
    console.error("[persistence] Failed to load store — seeding defaults:", err);
    await seedDefaultData();
  }
}

export async function resetStoreForDemo(): Promise<void> {
  users.clear();
  collars.clear();
  passes.clear();
  sessions.clear();
  approvals.clear();
  receipts.clear();
  reputationEvents.clear();
  runnerTasks.clear();
  domainTrust.clear();
  agentTasks.clear();
  agentDelegations.clear();
  routes.clear();
  skills.clear();
  publishedSkillVersions.clear();
  installedSkills.clear();
  routeRuns.clear();
  routeRunReceipts.clear();
  aegisVaultPasses.clear();
  routePassBindings.clear();
  credentialSessions.clear();
  credentialFillRequests.clear();
  encryptedSecretVault.clear();
  delegationPassports.clear();
  actionAuthorizations.clear();
  userApprovalReceipts.clear();
  websiteTrustAssertions.clear();
  paymentMethods.clear();
  spendingLimitStepUps.clear();
  secretFieldInjections.clear();
  credentialUseAuthorizations.clear();
  securityChallenges.clear();
  challengeEmailResolutions.clear();
  aegisWorkspaces.clear();
  workspaceTasks.clear();
  workspaceArtifacts.clear();
  workspaceAuditEvents.clear();
  websiteTrustProfiles.clear();
  websiteViolationReceipts.clear();
  sensitiveGrants.clear();
  privateProfileMemory.clear();

  try {
    if (existsSync(DATA_FILE)) unlinkSync(DATA_FILE);
  } catch {}

  await seedDefaultData();
}
