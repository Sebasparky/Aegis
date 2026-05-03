import type { WebsiteAegisPolicy } from "@aegis/types";

const DEMO_POLICY: WebsiteAegisPolicy = {
  version: "aegis-policy-v1",
  domain: "localhost",
  issued_at: "2026-05-03T00:00:00.000Z",
  agent_access: "allowed_with_aegis",
  verification_level: "dev_localhost",
  policy_source: "well_known",
  supported_workflows: [
    {
      workflow_id: "demo_login",
      name: "Demo Login",
      task_category: "login",
      path_prefixes: ["/demo-login"],
      required_capabilities: ["login_credential"],
      requires_user_approval: true,
      prohibited_capabilities: ["payment_method", "identity_profile"],
      prohibited_actions: ["identity_disclosure", "account_deletion"],
      support_path: "/support",
      notes:
        "Demo login workflow. Aegis must fill credentials through controlled runtime custody.",
    },
    {
      workflow_id: "demo_travel_booking",
      name: "Demo Travel Booking",
      task_category: "travel_booking",
      path_prefixes: ["/demo-travel"],
      required_capabilities: ["payment_method"],
      requires_user_approval: true,
      max_amount_usd: 100,
      currency: "USD",
      allowed_payment_instrument_types: ["demo_card"],
      prohibited_capabilities: ["identity_profile"],
      prohibited_actions: ["identity_disclosure", "account_deletion"],
      support_path: "/support",
      refund_policy: "mock_demo_no_real_payment",
      dispute_policy: "mock_demo_no_real_payment",
      notes: "Mock workflow. No real money is processed.",
    },
  ],
  global_prohibited_actions: ["identity_disclosure", "account_deletion"],
  required_assertions: ["delegation_passport_v1", "website_trust_assertion_v1"],
  contact: {
    support_url: "http://localhost:3000/support",
    security_url: "http://localhost:3000/security",
    terms_url: "http://localhost:3000/terms",
  },
  limitations: {
    not_business_verified: true,
    self_asserted_policy: true,
    not_a_guarantee: true,
  },
};

export function GET() {
  return new Response(JSON.stringify(DEMO_POLICY, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}
