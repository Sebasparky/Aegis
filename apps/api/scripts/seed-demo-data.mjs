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

// Dev-only demo vault pass. Uses fake seeded credentials only.
// The actual secret value lives in devSecretVault in store/index.ts — NOT here.
const DEMO_VAULT_PASS = {
  pass_id: "pass_vault_demo_login_001",
  user_id: "user_001",
  label: "Demo Login Account",
  kind: "login_password",
  domain: "localhost",
  username: "demo_user",
  secret_ref: "devvault://demo-login-password",
  created_at: "2026-04-30T12:00:00.000Z",
  updated_at: "2026-04-30T12:00:00.000Z"
};

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

// Demo travel booking — mock flight Detroit → New York, tokenized payment method.
// All step values are safe_literals — no secrets, no raw card data.
const TRAVEL_STEPS = [
  {
    step_id: "step_travel_001",
    order: 1,
    action: "fill",
    intent: "fill_passenger_name",
    description: "fill Passenger Name",
    target: {
      preferred_locator: { type: "label", name: "Passenger Name" },
      fallback_locators: [
        { type: "placeholder", name: "Passenger Name" },
        { type: "css", value: "input[name=\"passengerName\"]" }
      ],
      confidence: 0.9
    },
    value_policy: { type: "safe_literal", value: "Demo User", store_value: true },
    approval_required: false,
    confidence_required: 0.7
  },
  {
    step_id: "step_travel_002",
    order: 2,
    action: "fill",
    intent: "fill_from_city",
    description: "fill From city",
    target: {
      preferred_locator: { type: "label", name: "From" },
      fallback_locators: [
        { type: "placeholder", name: "From" },
        { type: "css", value: "input[name=\"from\"]" }
      ],
      confidence: 0.9
    },
    value_policy: { type: "safe_literal", value: "Detroit, MI (DTW)", store_value: true },
    approval_required: false,
    confidence_required: 0.7
  },
  {
    step_id: "step_travel_003",
    order: 3,
    action: "fill",
    intent: "fill_to_city",
    description: "fill To city",
    target: {
      preferred_locator: { type: "label", name: "To" },
      fallback_locators: [
        { type: "placeholder", name: "To" },
        { type: "css", value: "input[name=\"to\"]" }
      ],
      confidence: 0.9
    },
    value_policy: { type: "safe_literal", value: "New York, NY (JFK)", store_value: true },
    approval_required: false,
    confidence_required: 0.7
  },
  {
    step_id: "step_travel_004",
    order: 4,
    action: "fill",
    intent: "fill_departure_date",
    description: "fill Departure Date",
    target: {
      preferred_locator: { type: "label", name: "Departure Date" },
      fallback_locators: [
        { type: "placeholder", name: "Departure Date" },
        { type: "css", value: "input[name=\"departureDate\"]" }
      ],
      confidence: 0.85
    },
    value_policy: { type: "safe_literal", value: "2026-07-15", store_value: true },
    approval_required: false,
    confidence_required: 0.7
  },
  {
    step_id: "step_travel_005",
    order: 5,
    action: "click",
    intent: "click_pay_and_book",
    description: "click Pay & Book button",
    target: {
      preferred_locator: { type: "role", role: "button", name: "Pay & Book" },
      fallback_locators: [
        { type: "css", value: "button[type=\"submit\"]" },
        { type: "testid", name: "pay-book-btn" }
      ],
      confidence: 0.9
    },
    approval_required: false,
    confidence_required: 0.8
  }
];

const TRAVEL_VERIFICATION = {
  route_id: "route_demo_travel_booking_001",
  started_at: "2026-04-30T13:00:00.000Z",
  completed_at: "2026-04-30T13:00:04.000Z",
  passed: true,
  step_results: [
    {
      step_id: "step_travel_001",
      order: 1,
      action: "fill",
      locator_attempts: [{ locator: { type: "label", name: "Passenger Name" }, found: true }],
      selected_locator: { type: "label", name: "Passenger Name" },
      locator_found: true,
      action_performed: true,
      passed: true,
      confidence: 0.9
    },
    {
      step_id: "step_travel_002",
      order: 2,
      action: "fill",
      locator_attempts: [{ locator: { type: "label", name: "From" }, found: true }],
      selected_locator: { type: "label", name: "From" },
      locator_found: true,
      action_performed: true,
      passed: true,
      confidence: 0.9
    },
    {
      step_id: "step_travel_003",
      order: 3,
      action: "fill",
      locator_attempts: [{ locator: { type: "label", name: "To" }, found: true }],
      selected_locator: { type: "label", name: "To" },
      locator_found: true,
      action_performed: true,
      passed: true,
      confidence: 0.9
    },
    {
      step_id: "step_travel_004",
      order: 4,
      action: "fill",
      locator_attempts: [{ locator: { type: "label", name: "Departure Date" }, found: true }],
      selected_locator: { type: "label", name: "Departure Date" },
      locator_found: true,
      action_performed: true,
      passed: true,
      confidence: 0.85
    },
    {
      step_id: "step_travel_005",
      order: 5,
      action: "click",
      locator_attempts: [{ locator: { type: "role", role: "button", name: "Pay & Book" }, found: true }],
      selected_locator: { type: "role", role: "button", name: "Pay & Book" },
      locator_found: true,
      action_performed: true,
      passed: true,
      confidence: 0.9
    }
  ],
  errors: [],
  promoted_trust_tier: "aegis_scanned"
};

// Demo login — fake local credentials, aegis_controlled execution path.
// Uses safe_literal value policies so replay.js fills the demo credentials
// automatically. This is not real credential custody — it is a demo only.
const LOGIN_STEPS = [
  {
    step_id: "step_login_1",
    order: 1,
    action: "fill",
    intent: "fill_username",
    description: "fill Username",
    target: {
      preferred_locator: { type: "label", name: "Username" },
      fallback_locators: [
        { type: "placeholder", value: "Username" },
        { type: "css", value: "input[name=\"username\"]" },
        { type: "role", role: "textbox", name: "Username" }
      ],
      confidence: 0.9
    },
    value_policy: { type: "pass_field", pass_id: "pass_vault_demo_login_001", field: "username", store_value: false },
    variable_binding: "username",
    approval_required: false,
    confidence_required: 0.7
  },
  {
    step_id: "step_login_2",
    order: 2,
    action: "fill",
    intent: "fill_password",
    description: "fill Password",
    target: {
      preferred_locator: { type: "label", name: "Password" },
      fallback_locators: [
        { type: "placeholder", value: "Password" },
        { type: "css", value: "input[type=\"password\"]" },
        { type: "css", value: "input[name=\"password\"]" }
      ],
      confidence: 0.9
    },
    value_policy: { type: "secret_ref", pass_id: "pass_vault_demo_login_001", field: "password", store_value: false },
    variable_binding: "password",
    approval_required: false,
    confidence_required: 0.7
  },
  {
    step_id: "step_login_3",
    order: 3,
    action: "click",
    intent: "submit_login",
    description: "click Sign In",
    target: {
      preferred_locator: { type: "role", role: "button", name: "Sign In" },
      fallback_locators: [
        { type: "css", value: "button[type=\"submit\"]" },
        { type: "role", role: "button", name: "Login" }
      ],
      confidence: 0.9
    },
    approval_required: false,
    confidence_required: 0.7
  }
];

const LOGIN_VERIFICATION = {
  route_id: "route_demo_login_001",
  started_at: "2026-04-30T11:00:00.000Z",
  completed_at: "2026-04-30T11:00:02.000Z",
  passed: true,
  step_results: [
    {
      step_id: "step_login_1",
      order: 1,
      action: "fill",
      locator_attempts: [{ locator: { type: "label", name: "Username" }, found: true }],
      selected_locator: { type: "label", name: "Username" },
      locator_found: true,
      action_performed: true,
      passed: true,
      confidence: 0.9
    },
    {
      step_id: "step_login_2",
      order: 2,
      action: "fill",
      locator_attempts: [{ locator: { type: "label", name: "Password" }, found: true }],
      selected_locator: { type: "label", name: "Password" },
      locator_found: true,
      action_performed: true,
      passed: true,
      confidence: 0.9
    },
    {
      step_id: "step_login_3",
      order: 3,
      action: "click",
      locator_attempts: [{ locator: { type: "role", role: "button", name: "Sign In" }, found: true }],
      selected_locator: { type: "role", role: "button", name: "Sign In" },
      locator_found: true,
      action_performed: true,
      passed: true,
      confidence: 0.9
    }
  ],
  errors: [],
  promoted_trust_tier: "aegis_scanned"
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
      execution_mode: "agent_runnable",
      sensitivity_level: "routine",
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
      marketplace_status: "private",
      execution_mode: "aegis_controlled",
      sensitivity_level: "sensitive"
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
      marketplace_status: "private",
      execution_mode: "aegis_controlled",
      sensitivity_level: "sensitive"
    }
  ],
  [
    "route_demo_travel_booking_001",
    {
      route_id: "route_demo_travel_booking_001",
      version: "1.0.0",
      created_at: "2026-04-30T13:00:00.000Z",
      last_verified_at: "2026-04-30T13:00:04.000Z",
      creator_aegis_id: "aid_user_001",
      trust_tier: "aegis_scanned",
      domain: "localhost",
      url_match: { hostname: "localhost", path_prefix: "/demo-travel" },
      start_url: "http://localhost:3000/demo-travel",
      workflow_name: "Demo Flight Booking",
      workflow_description: "Books a mock Detroit → New York flight using an Aegis-tokenized demo payment method. No real money processed.",
      risk_level: "high",
      required_permissions: ["travel_booking", "payment"],
      allowed_actions: ["travel_booking", "payment"],
      forbidden_actions: ["identity_disclosure", "delete_account"],
      approval_gates: [],
      confidence_threshold: 0.75,
      steps: TRAVEL_STEPS,
      run_count: 0,
      success_rate: 0,
      incident_count: 0,
      verification_report: TRAVEL_VERIFICATION,
      marketplace_status: "approved",
      submitted_for_review_at: "2026-04-30T13:30:00.000Z",
      reviewed_at: "2026-04-30T13:30:00.000Z",
      review_note: "Mock travel booking workflow with tokenized payment method. Aegis-controlled execution only.",
      execution_mode: "aegis_controlled",
      sensitivity_level: "sensitive"
    }
  ],
  [
    "route_demo_travel_violation_001",
    {
      route_id: "route_demo_travel_violation_001",
      version: "1.0.0",
      created_at: "2026-05-03T10:00:00.000Z",
      last_verified_at: "2026-05-03T10:00:04.000Z",
      creator_aegis_id: "aid_user_001",
      trust_tier: "aegis_scanned",
      domain: "localhost",
      url_match: { hostname: "localhost", path_prefix: "/demo-travel" },
      start_url: "http://localhost:3000/demo-travel?violation=1",
      workflow_name: "Demo Flight Booking (Violation Demo)",
      workflow_description: "Same steps as Demo Flight Booking but starts on /demo-travel?violation=1, which fires a credential form submit outside the Aegis coverage window. Used to demonstrate Coverage Violation Blocking v1.",
      risk_level: "high",
      required_permissions: ["travel_booking", "payment"],
      allowed_actions: ["travel_booking", "payment"],
      forbidden_actions: ["identity_disclosure", "delete_account"],
      approval_gates: [],
      confidence_threshold: 0.75,
      steps: TRAVEL_STEPS,
      run_count: 0,
      success_rate: 0,
      incident_count: 0,
      verification_report: TRAVEL_VERIFICATION,
      marketplace_status: "approved",
      submitted_for_review_at: "2026-05-03T10:30:00.000Z",
      reviewed_at: "2026-05-03T10:30:00.000Z",
      review_note: "Violation demo route — fires uncovered credential event before Aegis coverage window opens.",
      execution_mode: "aegis_controlled",
      sensitivity_level: "sensitive"
    }
  ],
  [
    "route_demo_login_001",
    {
      route_id: "route_demo_login_001",
      version: "1.0.0",
      created_at: "2026-04-30T11:00:00.000Z",
      last_verified_at: "2026-04-30T11:00:02.000Z",
      creator_aegis_id: "aid_user_001",
      trust_tier: "aegis_scanned",
      domain: "localhost",
      url_match: { hostname: "localhost", path_prefix: "/demo-login" },
      start_url: "http://localhost:3000/demo-login",
      workflow_name: "Demo Login",
      workflow_description: "Fill username and password and click Sign In on the Aegis demo login page. Uses fake demo credentials. Proves aegis_controlled execution path with approval gating and outcome verification.",
      risk_level: "high",
      required_permissions: ["login"],
      allowed_actions: ["login"],
      forbidden_actions: [],
      approval_gates: [],
      confidence_threshold: 0.7,
      steps: LOGIN_STEPS,
      variables: [
        {
          name: "username",
          label: "Username",
          type: "text",
          default_value: "demo_user",
          step_id: "step_login_1"
        },
        {
          name: "password",
          label: "Password",
          type: "text",
          default_value: "",
          step_id: "step_login_2"
        }
      ],
      run_count: 0,
      success_rate: 0,
      incident_count: 0,
      verification_report: LOGIN_VERIFICATION,
      marketplace_status: "approved",
      submitted_for_review_at: "2026-04-30T11:30:00.000Z",
      reviewed_at: "2026-04-30T11:30:00.000Z",
      review_note: "Demo login workflow with fake local credentials. Aegis-controlled execution only — agents cannot fetch the recipe.",
      execution_mode: "aegis_controlled",
      sensitivity_level: "sensitive"
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
      published_at: "2026-04-30T12:00:00.000Z",
      execution_mode: "agent_runnable",
      sensitivity_level: "routine",
      listing_status: "active",
      creator_aegis_id: "aid_user_001"
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
      published_at: "2026-04-30T12:10:00.000Z",
      execution_mode: "aegis_controlled",
      sensitivity_level: "sensitive",
      listing_status: "active",
      creator_aegis_id: "aid_user_001"
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
      published_at: "2026-04-30T12:20:00.000Z",
      execution_mode: "aegis_controlled",
      sensitivity_level: "sensitive",
      listing_status: "active",
      creator_aegis_id: "aid_user_001"
    }
  ],
  [
    "skill_demo_login_001",
    {
      skill_id: "skill_demo_login_001",
      route_id: "route_demo_login_001",
      name: "Demo Login",
      summary: "Log in to the Aegis demo login page using fake local credentials. Proves aegis_controlled execution: approval gating, Aegis-controlled fill, outcome verification, receipt.",
      domain: "localhost",
      risk_level: "high",
      trust_tier: "aegis_scanned",
      required_permissions: ["login"],
      forbidden_actions: [],
      approval_gates: [],
      created_at: "2026-04-30T11:30:00.000Z",
      published_at: "2026-04-30T11:30:00.000Z",
      execution_mode: "aegis_controlled",
      sensitivity_level: "sensitive",
      listing_status: "active",
      creator_aegis_id: "aid_user_001"
    }
  ],
  [
    "skill_demo_travel_booking_001",
    {
      skill_id: "skill_demo_travel_booking_001",
      route_id: "route_demo_travel_booking_001",
      name: "Demo Flight Booking",
      summary: "Books a mock Detroit → New York flight using an Aegis-tokenized demo payment method. No real money processed. Proves travel_booking authorization, payment coverage, and receipt chain.",
      domain: "localhost",
      risk_level: "high",
      trust_tier: "aegis_scanned",
      required_permissions: ["travel_booking", "payment"],
      forbidden_actions: ["identity_disclosure", "delete_account"],
      approval_gates: [],
      created_at: "2026-04-30T13:30:00.000Z",
      published_at: "2026-04-30T13:30:00.000Z",
      execution_mode: "aegis_controlled",
      sensitivity_level: "sensitive",
      listing_status: "active",
      creator_aegis_id: "aid_user_001"
    }
  ],
  [
    "skill_demo_travel_violation_001",
    {
      skill_id: "skill_demo_travel_violation_001",
      route_id: "route_demo_travel_violation_001",
      name: "Demo Flight Booking (Violation Demo)",
      summary: "Demonstrates Coverage Violation Blocking v1. Starts on /demo-travel?violation=1, which fires a credential form submit outside the Aegis coverage window. Run is blocked, receipt status is failed, authorization is not fulfilled.",
      domain: "localhost",
      risk_level: "high",
      trust_tier: "aegis_scanned",
      required_permissions: ["travel_booking", "payment"],
      forbidden_actions: ["identity_disclosure", "delete_account"],
      approval_gates: [],
      created_at: "2026-05-03T10:30:00.000Z",
      published_at: "2026-05-03T10:30:00.000Z",
      execution_mode: "aegis_controlled",
      sensitivity_level: "sensitive",
      listing_status: "active",
      creator_aegis_id: "aid_user_001"
    }
  ]
];

const publishedSkillVersions = [
  [
    "psv_demo_wikipedia_001",
    {
      version_id: "psv_demo_wikipedia_001",
      skill_id: "skill_demo_wikipedia_001",
      route_id: "route_demo_wikipedia_001",
      snapshot_at: "2026-04-30T12:00:00.000Z",
      workflow_name: "Wikipedia Search",
      workflow_description: "Search Wikipedia for any topic. Fills the search box and submits. Verified against live Wikipedia.",
      domain: "en.wikipedia.org",
      trust_tier: "aegis_scanned",
      risk_level: "low",
      required_permissions: ["browse"],
      forbidden_actions: [],
      allowed_actions: ["browse", "search"],
      approval_gates: [],
      steps: WIKIPEDIA_STEPS,
      execution_mode: "agent_runnable",
      sensitivity_level: "routine",
      verification_report: {
        ...WIKIPEDIA_VERIFICATION_BASE,
        route_id: "route_demo_wikipedia_001"
      }
    }
  ]
];

// Demo payment method capability — metadata only, no PAN, no CVV.
const DEMO_PAYMENT_METHOD = {
  payment_method_id: "pay_method_demo_001",
  user_id: "user_001",
  label: "Aegis Demo Card",
  network: "visa",
  last4: "4242",
  billing_country: "US",
  capability_ref: "demo-payment-method",
  created_at: "2026-04-30T13:00:00.000Z"
};

// Pre-installed skills so agents can request runs without manual UI installation.
const installedSkills = [
  [
    "ins_skill_login_001",
    {
      installed_skill_id: "ins_skill_login_001",
      skill_id: "skill_demo_login_001",
      user_id: "user_001",
      installed_at: "2026-04-30T11:30:00.000Z",
      enabled: true
    }
  ],
  [
    "ins_skill_travel_001",
    {
      installed_skill_id: "ins_skill_travel_001",
      skill_id: "skill_demo_travel_booking_001",
      user_id: "user_001",
      installed_at: "2026-04-30T13:30:00.000Z",
      enabled: true
    }
  ],
  [
    "ins_skill_travel_violation_001",
    {
      installed_skill_id: "ins_skill_travel_violation_001",
      skill_id: "skill_demo_travel_violation_001",
      user_id: "user_001",
      installed_at: "2026-05-03T10:30:00.000Z",
      enabled: true
    }
  ]
];

const WORKSPACE = {
  workspace_id: "ws_coord_trial_001",
  owner_user_id: "user_001",
  name: "Coordination Trial Workspace",
  description: "Three-task coordination trial. collar_research_001 agent handles research; collar_review_001 agent handles review; any agent handles the open analysis task.",
  collar_id: "collar_demo_starter",
  participant_delegation_ids: ["delg_demo_001", "delg_demo_restricted"],
  status: "active",
  created_at: "2026-05-11T00:00:00.000Z",
  updated_at: "2026-05-11T00:00:00.000Z"
};

const WORKSPACE_TASKS = [
  ["task_coord_001", {
    task_id: "task_coord_001",
    workspace_id: "ws_coord_trial_001",
    title: "Research Aegis product pillars",
    description: "Research and document the five Aegis pillars: AegisID, Delegation & Collars, Aegis Rails, Aegis Guard, and Audit Trail. Write 2-3 sentences each. Create a markdown artifact named `aegis-pillars-summary.md` linked to this task. Mark the task complete after creating the artifact.",
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
    updated_at: "2026-05-11T00:00:00.000Z"
  }],
  ["task_coord_002", {
    task_id: "task_coord_002",
    workspace_id: "ws_coord_trial_001",
    title: "Review and prioritize Aegis pillars",
    description: "Read the `aegis-pillars-summary.md` artifact. Identify the most important Aegis capability and write a 3-bullet argument for why it matters. Create a markdown artifact named `aegis-pillars-review.md` linked to this task. Mark the task complete after creating the artifact.",
    status: "open",
    assignment_type: "collar",
    required_collar_id: "collar_review_001",
    task_kind: "review",
    task_mode: "plan_first",
    priority: "normal",
    depends_on_task_ids: ["task_coord_001"],
    required_artifact_names: ["aegis-pillars-summary.md"],
    created_by_user_id: "user_001",
    created_at: "2026-05-11T00:01:00.000Z",
    updated_at: "2026-05-11T00:01:00.000Z"
  }],
  ["task_coord_003", {
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
    updated_at: "2026-05-11T00:02:00.000Z"
  }]
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
        allowed_actions: [
          "browse", "search", "read", "compare", "draft", "add_to_cart",
          "workspace_read", "workspace_task_list", "workspace_task_claim",
          "workspace_task_complete", "workspace_artifact_create",
          "workspace_artifact_list", "workspace_artifact_read"
        ],
        approval_required_actions: [
          "login", "purchase", "payment", "travel_booking", "share_email", "share_phone",
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
    ],
    [
      "collar_research_001",
      {
        id: "collar_research_001",
        user_id: "user_001",
        name: "Research Collar",
        description: "A collar for research and review tasks. Grants the same workspace permissions as the starter collar.",
        purpose: "Identify agents with research and review capability for collar-required workspace tasks.",
        status: "active",
        allowed_actions: [
          "browse", "search", "read", "compare", "draft",
          "workspace_read", "workspace_task_list", "workspace_task_claim",
          "workspace_task_complete", "workspace_artifact_create",
          "workspace_artifact_list", "workspace_artifact_read"
        ],
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
          max_with_approval: 50,
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
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z"
      }
    ],
    [
      "collar_review_001",
      {
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
          "workspace_artifact_list", "workspace_artifact_read"
        ],
        approval_required_actions: [
          "login", "purchase", "payment", "travel_booking", "share_email", "share_phone",
          "submit_form", "post_publicly", "upload_file", "send_email", "create_account"
        ],
        blocked_actions: [
          "subscription", "government_id_upload", "identity_disclosure",
          "medical_data_disclosure", "financial_data_disclosure", "delete_account"
        ],
        spending_limits: {
          max_without_approval: 0,
          max_with_approval: 50,
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
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z"
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
        default_collar_id: "collar_research_001",
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
        default_collar_id: "collar_review_001",
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
  publishedSkillVersions,
  installedSkills,
  aegisVaultPasses: [["pass_vault_demo_login_001", DEMO_VAULT_PASS]],
  paymentMethods: [["pay_method_demo_001", DEMO_PAYMENT_METHOD]],
  aegisWorkspaces: [["ws_coord_trial_001", WORKSPACE]],
  workspaceTasks: WORKSPACE_TASKS,
  workspaceArtifacts: [],
  workspaceAuditEvents: []
};

writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
console.log("Demo data seeded. 9 routes, 6 skills, 2 delegations, 3 collars, 1 workspace, 3 tasks, 1 payment method written.");
console.log("  route_demo_banking_001              — Demo Banking Workflow           (localhost, aegis_scanned, private)");
console.log("  route_demo_wikipedia_001            — Wikipedia Search                (en.wikipedia.org, aegis_scanned, approved, agent_runnable)");
console.log("  route_demo_draft_001                — Account Statement Draft         (localhost, unverified_draft)");
console.log("  route_demo_pending_001              — Wikipedia Topic Lookup          (en.wikipedia.org, aegis_scanned, pending_review)");
console.log("  route_demo_travel_booking_001       — Demo Flight Booking             (localhost, aegis_scanned, approved, aegis_controlled, high)");
console.log("  route_demo_travel_violation_001     — Demo Flight Booking (Violation) (localhost, aegis_scanned, approved, aegis_controlled, violation demo)");
console.log("  route_demo_login_001                — Demo Login                      (localhost, aegis_scanned, approved, aegis_controlled)");
console.log("  skill_demo_wikipedia_001            — Wikipedia Search (Skill)        (agent_runnable/routine)");
console.log("  skill_demo_login_001                — Demo Login (Skill)              (aegis_controlled/sensitive, pre-installed)");
console.log("  skill_demo_travel_booking_001       — Demo Flight Booking (Skill)     (aegis_controlled/sensitive, pre-installed)");
console.log("  skill_demo_travel_violation_001     — Demo Flight Booking Violation   (aegis_controlled/sensitive, violation demo, pre-installed)");
console.log("  pay_method_demo_001                 — Aegis Demo Card                 (visa, last4: 4242, metadata only)");
console.log("  collar_research_001                 — Research Collar");
console.log("  collar_review_001                   — Review Collar");
console.log("  ws_coord_trial_001                  — Coordination Trial Workspace    (collar_demo_starter, 2 participants, 3 open tasks)");
console.log("  task_coord_001: collar=collar_research_001, kind=research, priority=high, ready");
console.log("  task_coord_002: collar=collar_review_001,  kind=review,   priority=normal, blocked by task_coord_001 + aegis-pillars-summary.md");
console.log("  task_coord_003: assignment_type=open,      kind=analysis,  priority=low,   ready");
console.log("Workspace trial: Agent A = pass_demo_001 (collar_research_001) | Agent B = pass_demo_002 (collar_review_001) | Workspace = ws_coord_trial_001");
