import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import type { Collar, AgentTask, AgentDelegation, AegisRoute } from "@aegis/types";
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
  routes,
} from "./index.js";
import type { User, PassWithToken, ReputationEvent, DomainTrustRecord } from "./index.js";

const __filename = fileURLToPath(import.meta.url);
const DATA_DIR = join(dirname(__filename), "../../.data");
const DATA_FILE = join(DATA_DIR, "aegis-store.json");

// ─── Seed Data ────────────────────────────────────────────────────────────────

export function seedDefaultData(): void {
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
    id: `collar_${randomUUID()}`,
    user_id: "user_001",
    name: "Research & Action Starter",
    description:
      "A general-purpose starter collar. Browse and research freely. Require approval before committing to anything.",
    purpose: "Safely delegate research and action tasks to an outside agent.",
    status: "active",
    allowed_actions: ["browse", "search", "read", "compare", "draft", "add_to_cart"],
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
  ensureWebsiteTrustSeeds(NOW);
}

function ensureWebsiteTrustSeeds(now?: string): void {
  const NOW = now ?? new Date().toISOString();

  if (!domainTrust.has("localhost")) {
    domainTrust.set("localhost", {
      id: "wtr_demo_localhost",
      domain: "localhost",
      website_aegis_id: "web_aegis_demo_store",
      business_name: "AegisDemo Store",
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
      business_name: "AegisDemo Store",
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
      routes: Array.from(routes.entries()),
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

export function loadStore(): void {
  if (!existsSync(DATA_FILE)) {
    console.log("[persistence] No data file found — seeding default data.");
    seedDefaultData();
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
    for (const [k, v] of (data.routes ?? [])) routes.set(k, v as AegisRoute);

    ensureWebsiteTrustSeeds();

    const errorCount = Array.from(sessions.values()).filter(
      (s) => (s as any).status === "error"
    ).length;
    console.log(
      `[persistence] Loaded store from ${DATA_FILE} — ${sessions.size} sessions (${errorCount} marked error on restart)`
    );
  } catch (err) {
    console.error("[persistence] Failed to load store — seeding defaults:", err);
    seedDefaultData();
  }
}

export function resetStoreForDemo(): void {
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

  try {
    if (existsSync(DATA_FILE)) unlinkSync(DATA_FILE);
  } catch {}

  seedDefaultData();
}
