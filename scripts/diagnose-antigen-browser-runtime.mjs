#!/usr/bin/env node
/**
 * diagnose-antigen-browser-runtime.mjs
 *
 * Developer diagnostic for the Antigen local browser runtime. Use it before manual
 * QA to prove that:
 *   - the demo token resolves to the expected agent/delegation,
 *   - CDP is reachable on localhost:9222,
 *   - exactly one usable page target exists (no chrome://settings/help confusion),
 *   - the runtime endpoint binds to the same CDP URL the diagnostic is inspecting.
 *
 * Mostly read-only. CDP and /me probes are read-only. By default it ALSO calls
 * POST /api/agent/v1/runtime/browser-endpoint, which may PROVISION or REUSE a
 * runtime session. Pass --no-provision to skip that POST for a pure read-only pass.
 *
 * Secret-safety: prints only metadata and the demo token literal (pass_demo_001,
 * acceptable in this local demo context). Never prints cookies, localStorage, form
 * values, or page content.
 *
 * Usage:
 *   npm run diagnose:antigen-browser
 *   node scripts/diagnose-antigen-browser-runtime.mjs --no-provision
 */

const API_BASE = process.env.AEGIS_API_BASE ?? "http://localhost:4000";
const TOKEN = process.env.AEGIS_AGENT_TOKEN ?? "pass_demo_001";
const CDP_PORT = parseInt(process.env.AEGIS_CDP_PORT ?? "9222", 10);
const CDP_BASE = `http://localhost:${CDP_PORT}`;
const NO_PROVISION = process.argv.includes("--no-provision");

const warnings = [];
const warn = (msg) => { warnings.push(msg); };

function line(label, value) {
  console.log(`  ${label.padEnd(26)} ${value}`);
}
function header(title) {
  console.log(`\n=== ${title} ===`);
}

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, body };
}

// ── 1. CDP reachability ─────────────────────────────────────────────────────────

let cdpReachable = false;
header("CDP reachability (/json/version)");
try {
  const { ok, body } = await getJson(`${CDP_BASE}/json/version`);
  if (ok && body) {
    cdpReachable = true;
    line("reachable", "yes");
    line("Browser", body.Browser ?? "(unknown)");
    line("Protocol-Version", body["Protocol-Version"] ?? "(unknown)");
    line("webSocketDebuggerUrl", body.webSocketDebuggerUrl ?? "(none)");
  } else {
    line("reachable", `no (status ${body ? "with body" : "no body"})`);
    warn(`CDP not reachable at ${CDP_BASE}/json/version — no browser is listening on port ${CDP_PORT}.`);
  }
} catch (err) {
  line("reachable", `no (${err.message})`);
  warn(`CDP unreachable at ${CDP_BASE} — is an Antigen browser session running? Start QA first.`);
}

// ── 2. CDP targets ───────────────────────────────────────────────────────────────

header("CDP targets (/json/list)");
let pageTargets = [];
if (cdpReachable) {
  try {
    const { ok, body } = await getJson(`${CDP_BASE}/json/list`);
    const targets = ok && Array.isArray(body) ? body : [];
    if (targets.length === 0) {
      line("targets", "0");
      warn("No CDP targets found — the browser is up but has no tabs.");
    }
    for (const t of targets) {
      const url = t.url ?? "";
      const isPage = t.type === "page";
      const isSystem = url.startsWith("chrome://") || url.startsWith("devtools://") || url === "about:blank" || url === "";
      const usable = isPage && !isSystem;
      if (isPage) pageTargets.push({ url, usable, title: t.title ?? "", id: t.id ?? "" });
      console.log(`  - type=${t.type} usable=${usable}`);
      line("    url", url || "(blank)");
      line("    title", t.title ?? "(none)");
      line("    id", t.id ?? "(none)");
      if (isPage && url.includes("chrome://settings/help")) {
        warn("A page target is on chrome://settings/help — target selection may bind here instead of the real page.");
      }
    }
    line("page_targets", String(pageTargets.length));
    const usablePages = pageTargets.filter((p) => p.usable);
    line("usable_page_targets", String(usablePages.length));
    if (pageTargets.length > 1) {
      warn(`More than one page target (${pageTargets.length}) — @playwright/mcp may bind to the wrong one. Close extra tabs.`);
    }
    if (usablePages.length === 0 && pageTargets.length > 0) {
      warn("No usable page target — only blank/system/chrome:// pages are open. Navigate to the real site before QA actions.");
    }
  } catch (err) {
    line("targets", `error (${err.message})`);
    warn(`Could not read CDP targets: ${err.message}`);
  }
} else {
  line("targets", "skipped (CDP unreachable)");
}

// ── 3. Runtime identity ──────────────────────────────────────────────────────────

header("Runtime identity");
line("token", TOKEN);
let apiReachable = false;
try {
  const { ok, status, body } = await getJson(`${API_BASE}/api/agent/v1/me`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  apiReachable = true;
  if (ok && body?.data) {
    const d = body.data;
    line("agent_id", d.agent_id ?? d.agent_name ?? "(unknown)");
    line("delegation_id", d.delegation_id ?? d.delegation?.id ?? "(unknown)");
  } else {
    line("/me", `status ${status}`);
    warn(`GET /api/agent/v1/me returned ${status} — token may be invalid/expired. Reconnect the connector.`);
  }
} catch (err) {
  line("/me", `unreachable (${err.message})`);
  warn(`API unreachable at ${API_BASE} — is the Aegis server running on that port?`);
}

// ── 4. Runtime browser endpoint ──────────────────────────────────────────────────

header("Runtime browser endpoint (POST /runtime/browser-endpoint)");
if (NO_PROVISION) {
  line("probe", "skipped (--no-provision)");
} else if (!apiReachable) {
  line("probe", "skipped (API unreachable)");
} else {
  console.log("  note: this probe may provision or reuse a runtime session.");
  try {
    const { ok, status, body } = await getJson(`${API_BASE}/api/agent/v1/runtime/browser-endpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({}),
    });
    if (ok && body?.data) {
      const d = body.data;
      line("browser_runtime_id", d.browser_runtime_id ?? "(none)");
      line("cdp_url", d.cdp_url ?? "(none)");
      line("runtime_mode", d.runtime_mode ?? "(none)");
      line("reused_existing", String(d.reused_existing));
      line("persistent_profile_enabled", String(d.persistent_profile_enabled));
      line("port_auto_selected", String(d.port_auto_selected));
      if (d.cdp_url && d.cdp_url !== CDP_BASE) {
        warn(`Runtime endpoint cdp_url (${d.cdp_url}) differs from the diagnostic CDP base (${CDP_BASE}) — ` +
          `the adapter and your inspection may be bound to different browser instances.`);
      }
    } else {
      line("probe", `status ${status} ${body?.error?.code ?? ""}`);
      warn(`browser-endpoint returned ${status} — ${body?.error?.message ?? "could not provision runtime"}.`);
    }
  } catch (err) {
    line("probe", `error (${err.message})`);
    warn(`browser-endpoint probe failed: ${err.message}`);
  }
}

// ── 5. Warnings summary ──────────────────────────────────────────────────────────

header("Warnings");
if (warnings.length === 0) {
  console.log("  none — runtime binding looks healthy.");
} else {
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}
console.log("");
process.exit(warnings.length > 0 ? 1 : 0);
