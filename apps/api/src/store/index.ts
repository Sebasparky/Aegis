import { randomUUID } from "crypto";
import type {
  Collar,
  AegisPass,
  ProtectedSession,
  ApprovalRequest,
  Receipt,
  RunnerTask,
  AgentTask,
  AgentDelegation,
  AegisRoute,
  Skill,
  InstalledSkill,
} from "@aegis/types";

// In-memory Maps are the runtime source of truth.
// persistence.ts handles loading from and saving to disk.

export interface User {
  id: string;
  email: string;
  display_name: string;
  aegis_id: string;
  created_at: string;
  updated_at: string;
}

export interface ReputationEvent {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  category?: string;
  severity: string;
  session_id?: string;
  receipt_id?: string;
  domain?: string;
  weight: number;
  created_at: string;
}

export interface DomainTrustRecord {
  id: string;
  domain: string;
  domain_verified: boolean;
  business_verified: boolean;
  business_aegis_id?: string;
  trust_label: string;
  known_prompt_injection_reports: number;
  known_dispute_count: number;
  // Website AegisID fields added in v0
  website_aegis_id?: string;
  business_name?: string;
  agent_policy_published?: boolean;
  created_at: string;
  updated_at: string;
}

// Pass tokens are stored in plaintext for MVP convenience.
// Production must store only the hashed token and never return it after creation.
export interface PassWithToken extends AegisPass {
  token: string;
  revoked_at?: string;
  last_used_at?: string;
}

// ─── Store Maps ───────────────────────────────────────────────────────────────
// Maps are initialized empty; loadStore() in persistence.ts seeds or restores data on startup.

export const users = new Map<string, User>();

export const collars = new Map<string, Collar>();

export const passes = new Map<string, PassWithToken>();

export const sessions = new Map<string, ProtectedSession>();

export const approvals = new Map<string, ApprovalRequest>();

export const receipts = new Map<string, Receipt>();

export const reputationEvents = new Map<string, ReputationEvent>();

export const runnerTasks = new Map<string, RunnerTask>();

export const domainTrust = new Map<string, DomainTrustRecord>();

export const agentTasks = new Map<string, AgentTask>();

export const agentDelegations = new Map<string, AgentDelegation>();

export const routes = new Map<string, AegisRoute>();

export const skills = new Map<string, Skill>();

export const installedSkills = new Map<string, InstalledSkill>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const MOCK_USER_ID = "user_001";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
