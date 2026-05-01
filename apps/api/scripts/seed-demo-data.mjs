import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "../.data");
const STORE_PATH = join(DATA_DIR, "aegis-store.json");
const BACKUP_PATH = join(DATA_DIR, "aegis-store.backup.json");

mkdirSync(DATA_DIR, { recursive: true });

if (existsSync(STORE_PATH)) {
  copyFileSync(STORE_PATH, BACKUP_PATH);
  console.log("Backed up existing store to aegis-store.backup.json");
}

const BANKING_STEPS = [
  {
    step_id: "step_seed_b1",
    order: 1,
    action: "navigate",
    intent: "statements",
    description: "navigate Statements",
    target: {
      preferred_locator: { type: "role", role: "tab", name: "Statements" },
      fallback_locators: [
        { type: "label", name: "Statements" },
        { type: "css", value: "#tab-statements" }
      ],
      confidence: 0.9
    },
    approval_required: false,
    confidence_required: 0.7
  },
  {
    step_id: "step_seed_b2",
    order: 2,
    action: "select",
    intent: "select_month",
    description: "select Statement month",
    target: {
      preferred_locator: { type: "label", name: "Statement month" },
      fallback_locators: [
        { type: "label", name: "Select Month" },
        { type: "role", role: "combobox", name: "Statement month" },
        { type: "css", value: "[name=\"month\"]" },
        { type: "css", value: "#month-select" },
        { type: "testid", value: "statement-month" }
      ],
      confidence: 0.88
    },
    value_policy: { type: "enum_selection", value: "February 2024", store_value: true },
    approval_required: false,
    confidence_required: 0.7,
    variable_binding: "select_month"
  },
  {
    step_id: "step_seed_b3",
    order: 3,
    action: "click",
    intent: "download_statement",
    description: "click Download Statement",
    target: {
      preferred_locator: { type: "label", name: "Download statement" },
      fallback_locators: [
        { type: "role", role: "button", name: "Download Statement" },
        { type: "css", value: "#download-btn" },
        { type: "role", role: "button", name: "Download statement" },
        { type: "testid", value: "download-statement" }
      ],
      confidence: 0.88
    },
    approval_required: false,
    confidence_required: 0.7
  }
];

const BANKING_VERIFICATION = {
  route_id: "route_demo_banking_001",
  started_at: "2026-04-30T10:00:00.000Z",
  completed_at: "2026-04-30T10:00:01.000Z",
  passed: true,
  step_results: [
    {
      step_id: "step_seed_b1",
      order: 1,
      action: "navigate",
      locator_attempts: [{ locator: { type: "role", role: "tab", name: "Statements" }, found: true }],
      selected_locator: { type: "role", role: "tab", name: "Statements" },
      locator_found: true,
      action_performed: true,
      passed: true,
      confidence: 0.9
    },
    {
      step_id: "step_seed_b2",
      order: 2,
      action: "select",
      locator_attempts: [{ locator: { type: "label", name: "Statement month" }, found: true }],
      selected_locator: { type: "label", name: "Statement month" },
      locator_found: true,
      action_performed: true,
      passed: true,
      confidence: 0.88
    },
    {
      step_id: "step_seed_b3",
      order: 3,
      action: "click",
      locator_attempts: [{ locator: { type: "label", name: "Download statement" }, found: true }],
      selected_locator: { type: "label", name: "Download statement" },
      locator_found: true,
      action_performed: true,
      passed: true,
      confidence: 0.88
    }
  ],
  errors: [],
  promoted_trust_tier: "aegis_scanned"
};

const WIKIPEDIA_STEPS = [
  {
    step_id: "step_seed_w1",
    order: 1,
    action: "fill",
    intent: "search_wikipedia",
    description: "fill Search Wikipedia",
    target: {
      preferred_locator: { type: "label", name: "Search Wikipedia" },
      fallback_locators: [
        { type: "placeholder", value: "Search Wikipedia" },
        { type: "css", value: "[name=\"search\"]" },
        { type: "role", role: "combobox", name: "Search Wikipedia" }
      ],
      confidence: 0.88
    },
    value_policy: { type: "safe_literal", value: "Michigan", store_value: true },
    approval_required: false,
    confidence_required: 0.7
  },
  {
    step_id: "step_seed_w2",
    order: 2,
    action: "click",
    intent: "search",
    description: "click Search",
    target: {
      preferred_locator: { type: "label", name: "Search" },
      fallback_locators: [
        { type: "role", role: "button", name: "Search" },
        { type: "css", value: "button" }
      ],
      confidence: 0.88
    },
    approval_required: false,
    confidence_required: 0.7
  }
];

const WIKIPEDIA_VERIFICATION_BASE = {
  started_at: "2026-04-30T10:05:00.000Z",
  completed_at: "2026-04-30T10:05:02.000Z",
  passed: true,
  step_results: [
    {
      step_id: "step_seed_w1",
      order: 1,
      action: "fill",
      locator_attempts: [{ locator: { type: "label", name: "Search Wikipedia" }, found: true }],
      selected_locator: { type: "label", name: "Search Wikipedia" },
      locator_found: true,
      action_performed: true,
      passed: true,
      confidence: 0.88
    },
    {
      step_id: "step_seed_w2",
      order: 2,
      action: "click",
      locator_attempts: [{ locator: { type: "label", name: "Search" }, found: true }],
      selected_locator: { type: "label", name: "Search" },
      locator_found: true,
      action_performed: true,
      passed: true,
      confidence: 0.88
    }
  ],
  errors: [],
  promoted_trust_tier: "aegis_scanned"
};

const DRAFT_STEPS = BANKING_STEPS.map(s => ({
  ...s,
  step_id: s.step_id.replace("_b", "_d"),
  variable_binding: s.variable_binding
}));

const PENDING_STEPS = WIKIPEDIA_STEPS.map(s => ({
  ...s,
  step_id: s.step_id.replace("_w", "_p")
}));

const PENDING_VERIFICATION = {
  ...WIKIPEDIA_VERIFICATION_BASE,
  route_id: "route_demo_pending_001",
  step_results: WIKIPEDIA_VERIFICATION_BASE.step_results.map(r => ({
    ...r,
    step_id: r.step_id.replace("_w", "_p")
  }))
};

const routes = [
  [
    "route_demo_banking_001",
    {
      route_id: "route_demo_banking_001",
      version: "1.0.0",
      created_at: "2026-04-30T09:00:00.000Z",
      last_verified_at: "2026-04-30T10:00:01.000Z",
      creator_aegis_id: "aid_user_001",
      trust_tier: "aegis_scanned",
      domain: "localhost",
      workflow_name: "Demo Banking Workflow",
      workflow_description: "Download a monthly account statement from the demo banking app. Parameterized by month.",
      risk_level: "low",
      required_permissions: ["browse"],
      allowed_actions: ["browse"],
      forbidden_actions: [],
      approval_gates: [],
      confidence_threshold: 0.7,
      steps: BANKING_STEPS,
      variables: [
        {
          name: "select_month",
          label: "Select Month",
          type: "select",
          default_value: "February 2024",
          step_id: "step_seed_b2"
        }
      ],
      run_count: 0,
      success_rate: 0,
      incident_count: 0,
      verification_report: BANKING_VERIFICATION,
      marketplace_status: "private"
    }
  ],
  [
    "route_demo_wikipedia_001",
    {
      route_id: "route_demo_wikipedia_001",
      version: "1.0.0",
      created_at: "2026-04-30T09:10:00.000Z",
      last_verified_at: "2026-04-30T10:05:02.000Z",
      creator_aegis_id: "aid_user_001",
      trust_tier: "aegis_scanned",
      domain: "en.wikipedia.org",
      workflow_name: "Wikipedia Search",
      workflow_description: "Search Wikipedia for any topic. Fills the search box and submits. Verified against live Wikipedia.",
      risk_level: "low",
      required_permissions: ["browse"],
      allowed_actions: ["browse"],
      forbidden_actions: [],
      approval_gates: [],
      confidence_threshold: 0.7,
      steps: WIKIPEDIA_STEPS,
      run_count: 0,
      success_rate: 0,
      incident_count: 0,
      verification_report: { ...WIKIPEDIA_VERIFICATION_BASE, route_id: "route_demo_wikipedia_001" },
      marketplace_status: "approved",
      submitted_for_review_at: "2026-04-30T12:00:00.000Z",
      reviewed_at: "2026-04-30T12:00:00.000Z",
      review_note: "Standard search workflow. Locators verified. No sensitive data."
    }
  ],
  [
    "route_demo_draft_001",
    {
      route_id: "route_demo_draft_001",
      version: "1.0.0",
      created_at: "2026-04-30T09:20:00.000Z",
      last_verified_at: "2026-04-30T09:20:00.000Z",
      creator_aegis_id: "aid_user_001",
      trust_tier: "unverified_draft",
      domain: "localhost",
      workflow_name: "Account Statement Draft",
      workflow_description: "Draft workflow for downloading account statements. Ready for private use — run verification to submit to marketplace.",
      risk_level: "low",
      required_permissions: ["browse"],
      allowed_actions: ["browse"],
      forbidden_actions: [],
      approval_gates: [],
      confidence_threshold: 0.7,
      steps: DRAFT_STEPS,
      run_count: 0,
      success_rate: 0,
      incident_count: 0
    }
  ],
  [
    "route_demo_pending_001",
    {
      route_id: "route_demo_pending_001",
      version: "1.0.0",
      created_at: "2026-04-30T09:30:00.000Z",
      last_verified_at: "2026-04-30T10:05:02.000Z",
      creator_aegis_id: "aid_user_001",
      trust_tier: "aegis_scanned",
      domain: "en.wikipedia.org",
      workflow_name: "Wikipedia Topic Lookup",
      workflow_description: "Look up any topic on Wikipedia. Identical locators to Wikipedia Search — submitted for marketplace review.",
      risk_level: "low",
      required_permissions: ["browse"],
      allowed_actions: ["browse"],
      forbidden_actions: [],
      approval_gates: [],
      confidence_threshold: 0.7,
      steps: PENDING_STEPS,
      run_count: 0,
      success_rate: 0,
      incident_count: 0,
      verification_report: PENDING_VERIFICATION,
      marketplace_status: "pending_review",
      submitted_for_review_at: "2026-04-30T18:00:00.000Z"
    }
  ],
  [
    "route_demo_purchase_001",
    {
      route_id: "route_demo_purchase_001",
      version: "1.0.0",
      created_at: "2026-04-30T12:10:00.000Z",
      last_verified_at: "2026-04-30T12:10:01.000Z",
      creator_aegis_id: "aid_user_001",
      trust_tier: "aegis_scanned",
      domain: "test.aegis.local",
      workflow_name: "Demo Purchase Route",
      workflow_description: "Demo route requiring purchase permission — used to test collar enforcement.",
      risk_level: "high",
      required_permissions: ["purchase"],
      allowed_actions: ["purchase"],
      forbidden_actions: [],
      approval_gates: [],
      confidence_threshold: 0.7,
      steps: [],
      variables: [],
      run_count: 0,
      success_rate: 0,
      incident_count: 0,
      marketplace_status: "private"
    }
  ],
  [
    "route_demo_blocked_001",
    {
      route_id: "route_demo_blocked_001",
      version: "1.0.0",
      created_at: "2026-04-30T12:20:00.000Z",
      last_verified_at: "2026-04-30T12:20:01.000Z",
      creator_aegis_id: "aid_user_001",
      trust_tier: "aegis_scanned",
      domain: "test.aegis.local",
      workflow_name: "Demo Blocked Route",
      workflow_description: "Demo route requiring identity_disclosure — used to test hard collar blocking.",
      risk_level: "critical",
      required_permissions: ["identity_disclosure"],
      allowed_actions: ["identity_disclosure"],
      forbidden_actions: [],
      approval_gates: [],
      confidence_threshold: 0.7,
      steps: [],
      variables: [],
      run_count: 0,
      success_rate: 0,
      incident_count: 0,
      marketplace_status: "private"
    }
  ]
];

const skills = [
  [
    "skill_demo_wikipedia_001",
    {
      skill_id: "skill_demo_wikipedia_001",
      route_id: "route_demo_wikipedia_001",
      name: "Wikipedia Search",
      summary: "Search Wikipedia for any topic. Fills the search box and submits. Verified against live Wikipedia.",
      domain: "en.wikipedia.org",
      risk_level: "low",
      trust_tier: "aegis_scanned",
      required_permissions: ["browse"],
      forbidden_actions: [],
      approval_gates: [],
      created_at: "2026-04-30T12:00:00.000Z",
      published_at: "2026-04-30T12:00:00.000Z"
    }
  ],
  [
    "skill_demo_purchase_001",
    {
      skill_id: "skill_demo_purchase_001",
      route_id: "route_demo_purchase_001",
      name: "Demo Purchase Skill",
      summary: "Demo skill requiring purchase permission — used to test collar enforcement.",
      domain: "test.aegis.local",
      risk_level: "high",
      trust_tier: "aegis_scanned",
      required_permissions: ["purchase"],
      forbidden_actions: [],
      approval_gates: [],
      created_at: "2026-04-30T12:10:00.000Z",
      published_at: "2026-04-30T12:10:00.000Z"
    }
  ],
  [
    "skill_demo_blocked_001",
    {
      skill_id: "skill_demo_blocked_001",
      route_id: "route_demo_blocked_001",
      name: "Demo Blocked Skill",
      summary: "Demo skill requiring identity_disclosure — used to test hard collar blocking.",
      domain: "test.aegis.local",
      risk_level: "critical",
      trust_tier: "aegis_scanned",
      required_permissions: ["identity_disclosure"],
      forbidden_actions: [],
      approval_gates: [],
      created_at: "2026-04-30T12:20:00.000Z",
      published_at: "2026-04-30T12:20:00.000Z"
    }
  ]
];

const store = {
  users: [
    [
      "user_001",
      {
        id: "user_001",
        email: "demo@aegis.local",
        display_name: "Demo User",
        aegis_id: "aid_user_001",
        created_at: "2026-04-28T01:27:21.845Z",
        updated_at: "2026-04-28T01:27:21.845Z"
      }
    ]
  ],
  collars: [
    [
      "collar_demo_starter",
      {
        id: "collar_demo_starter",
        user_id: "user_001",
        name: "Research & Action Starter",
        description: "A general-purpose starter collar. Browse and research freely. Require approval before committing to anything.",
        purpose: "Safely delegate research and action tasks to an outside agent.",
        status: "active",
        allowed_actions: ["browse", "search", "read", "compare", "draft", "add_to_cart"],
        approval_required_actions: [
          "login", "purchase", "payment", "share_email", "share_phone",
          "submit_form", "post_publicly", "upload_file", "send_email", "create_account"
        ],
        blocked_actions: [
          "subscription", "government_id_upload", "identity_disclosure",
          "medical_data_disclosure", "financial_data_disclosure", "delete_account"
        ],
        spending_limits: {
          max_without_approval: 0,
          max_with_approval: 100,
          subscriptions_allowed: false
        },
        counterparty_rules: {
          sensitive_actions_require_verified_business: false,
          block_known_prompt_injection_sites: true
        },
        session_limits: {
          max_duration_minutes: 120,
          max_active_sessions: 3
        },
        created_at: "2026-04-28T01:27:21.845Z",
        updated_at: "2026-04-28T01:27:21.845Z"
      }
    ]
  ],
  passes: [],
  sessions: [],
  approvals: [],
  receipts: [],
  reputationEvents: [],
  runnerTasks: [],
  domainTrust: [
    [
      "localhost",
      {
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
        created_at: "2026-04-28T06:05:18.406Z",
        updated_at: "2026-04-28T06:05:18.406Z"
      }
    ],
    [
      "example-store.local",
      {
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
        created_at: "2026-04-28T06:05:18.406Z",
        updated_at: "2026-04-28T06:05:18.406Z"
      }
    ],
    [
      "bad-store.local",
      {
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
        created_at: "2026-04-28T06:05:18.406Z",
        updated_at: "2026-04-28T06:05:18.406Z"
      }
    ]
  ],
  agentTasks: [],
  agentDelegations: [
    [
      "delg_demo_001",
      {
        id: "delg_demo_001",
        user_id: "user_001",
        user_aegis_id: "aid_user_001",
        agent_name: "agent_demo_001",
        agent_platform: "api",
        channel: "api",
        default_collar_id: "collar_demo_starter",
        status: "active",
        token_id: "pass_demo_001",
        skill_access_mode: "all",
        skill_access_skill_ids: [],
        created_at: "2026-04-30T12:00:00.000Z",
        updated_at: "2026-04-30T12:00:00.000Z"
      }
    ],
    [
      "delg_demo_restricted",
      {
        id: "delg_demo_restricted",
        user_id: "user_001",
        user_aegis_id: "aid_user_001",
        agent_name: "agent_demo_restricted",
        agent_platform: "api",
        channel: "api",
        default_collar_id: "collar_demo_starter",
        status: "active",
        token_id: "pass_demo_002",
        skill_access_mode: "only",
        skill_access_skill_ids: [],
        created_at: "2026-04-30T12:00:01.000Z",
        updated_at: "2026-04-30T12:00:01.000Z"
      }
    ]
  ],
  routes,
  skills,
  installedSkills: []
};

writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
console.log("Demo data seeded. 6 routes, 3 skills, 2 delegations written.");
console.log("  route_demo_banking_001   — Demo Banking Workflow       (localhost, aegis_scanned, private)");
console.log("  route_demo_wikipedia_001 — Wikipedia Search            (en.wikipedia.org, aegis_scanned, approved)");
console.log("  route_demo_draft_001     — Account Statement Draft     (localhost, unverified_draft)");
console.log("  route_demo_pending_001   — Wikipedia Topic Lookup      (en.wikipedia.org, aegis_scanned, pending_review)");
console.log("  skill_demo_wikipedia_001 — Wikipedia Search (Skill)    (/marketplace — install to add to Skill Library)");
