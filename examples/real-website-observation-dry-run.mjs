/**
 * Real Website Observation Dry Run v1
 *
 * Sends an observe-only request to Aegis. Aegis navigates to the URL in an isolated
 * headless browser, detects sensitive surfaces, and returns a structured report.
 *
 * OBSERVE-ONLY GUARANTEE:
 * No clicks. No typing. No form submissions. No credentials released.
 * No KMS decryption. No route execution. No screenshots captured.
 *
 * Usage:
 *   node examples/real-website-observation-dry-run.mjs
 *   URL=https://example.com node examples/real-website-observation-dry-run.mjs
 *   URL=https://www.wikipedia.org node examples/real-website-observation-dry-run.mjs
 *   URL=http://localhost:3000/demo-travel TASK_CATEGORY=travel_booking node examples/real-website-observation-dry-run.mjs
 *   URL=http://localhost:3000/demo-login TASK_CATEGORY=login node examples/real-website-observation-dry-run.mjs
 */

const API_BASE = process.env.API_BASE ?? "http://localhost:4000";
const TOKEN = process.env.AEGIS_AGENT_TOKEN ?? "pass_demo_001";
const URL_TARGET = process.env.URL ?? "https://example.com";
const TASK_CATEGORY = process.env.TASK_CATEGORY || undefined;

const authHeader = { Authorization: `Bearer ${TOKEN}` };
const SEP = "─".repeat(60);

async function request(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...authHeader,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok && !json.ok) {
    const err = json.error ?? { code: "UNKNOWN", message: res.statusText };
    throw Object.assign(new Error(`${err.code}: ${err.message}`), { code: err.code, status: res.status });
  }
  return json;
}

console.log(SEP);
console.log("  Aegis Real Website Observation Dry Run v1");
console.log(SEP);
console.log(`  Requested URL:   ${URL_TARGET}`);
console.log(`  Task category:   ${TASK_CATEGORY ?? "(not specified)"}`);
console.log(`  API base:        ${API_BASE}`);
console.log(SEP);
console.log("  Submitting observe-only request...");
console.log();

let result;
try {
  const res = await request("POST", "/api/agent/v1/observation-dry-runs", {
    url: URL_TARGET,
    ...(TASK_CATEGORY ? { task_category: TASK_CATEGORY } : {}),
  });
  result = res.data;
} catch (err) {
  console.error(`  ERROR: ${err.message}`);
  process.exit(1);
}

console.log(`  dry_run_id:    ${result.dry_run_id}`);
console.log(`  status:        ${result.status}`);
console.log(`  final_url:     ${result.final_url ?? "(none)"}`);
console.log(`  domain:        ${result.domain ?? "(none)"}`);
console.log();

console.log(SEP);
console.log("  Recommendation");
console.log(SEP);
console.log(`  ${result.recommendation}`);
console.log();

console.log(SEP);
console.log("  Observation Mode");
console.log(SEP);
console.log(`  mode:              ${result.observation_mode.mode}`);
if (result.observation_mode.activated_at) {
  console.log(`  activated_at:      ${result.observation_mode.activated_at}`);
}
if (result.observation_mode.activation_reasons.length > 0) {
  console.log(`  activation_reasons:`);
  for (const r of result.observation_mode.activation_reasons) {
    console.log(`    - ${r}`);
  }
}
if (result.observation_mode.sensitive_signals.length > 0) {
  console.log(`  sensitive_signals:`);
  for (const s of result.observation_mode.sensitive_signals) {
    console.log(`    - ${s}`);
  }
}
console.log();

if (result.open_summary) {
  console.log(SEP);
  console.log("  Open Summary (non-sensitive page)");
  console.log(SEP);
  if (result.open_summary.page_title) console.log(`  title:    ${result.open_summary.page_title}`);
  if (result.open_summary.headings.length > 0) {
    console.log("  headings:");
    for (const h of result.open_summary.headings) console.log(`    - ${h}`);
  }
  if (result.open_summary.links_sample.length > 0) {
    console.log("  links:");
    for (const l of result.open_summary.links_sample) console.log(`    - ${l}`);
  }
  if (result.open_summary.buttons_sample.length > 0) {
    console.log("  buttons:");
    for (const b of result.open_summary.buttons_sample) console.log(`    - ${b}`);
  }
  console.log(`  forms detected: ${result.open_summary.forms_detected}`);
  console.log();
}

console.log(SEP);
console.log("  Surface Summary");
console.log(SEP);
console.log(`  total elements:     ${result.summary.total_elements}`);
console.log(`  sensitive elements: ${result.summary.sensitive_elements}`);
console.log(`  redacted values:    ${result.summary.redacted_values}`);
if (result.summary.required_capabilities.length > 0) {
  console.log(`  required caps:      ${result.summary.required_capabilities.join(", ")}`);
}
if (result.summary.navigation_ms !== undefined) {
  console.log(`  navigation_ms:      ${result.summary.navigation_ms}`);
}
console.log();

if (result.sensitive_surfaces.length > 0) {
  console.log(SEP);
  console.log("  Sensitive Surfaces Detected");
  console.log(SEP);
  for (const s of result.sensitive_surfaces) {
    const label = s.label ?? s.text ?? s.input_type ?? s.kind;
    const cap = s.required_capability ? ` [requires: ${s.required_capability}]` : "";
    const sens = s.sensitivity ? ` (${s.sensitivity})` : "";
    console.log(`  • [${s.kind}] ${label}${sens}${cap}`);
    console.log(`    reason: ${s.reason}`);
  }
  console.log();
}

if (result.error) {
  console.log(SEP);
  console.log("  Error");
  console.log(SEP);
  console.log(`  code:    ${result.error.code}`);
  console.log(`  message: ${result.error.message}`);
  console.log();
}

console.log(SEP);
console.log("  Safety Rules Enforced");
console.log(SEP);
const rules = result.safety_rules_enforced;
console.log(`  no_clicks:           ${rules.no_clicks}`);
console.log(`  no_typing:           ${rules.no_typing}`);
console.log(`  no_form_submit:      ${rules.no_form_submit}`);
console.log(`  no_credential_fill:  ${rules.no_credential_fill}`);
console.log(`  no_payment_release:  ${rules.no_payment_release}`);
console.log(`  no_kms_decrypt:      ${rules.no_kms_decrypt}`);
console.log(`  no_route_execution:  ${rules.no_route_execution}`);
console.log(`  no_screenshot:       ${rules.no_screenshot}`);
console.log(`  no_full_dom_dump:    ${rules.no_full_dom_dump}`);
console.log();
console.log(SEP);
console.log("  OBSERVE-ONLY: no clicks, no typing, no forms submitted,");
console.log("  no credentials released, no screenshots captured.");
console.log(SEP);
