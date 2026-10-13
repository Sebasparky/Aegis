#!/usr/bin/env node
/**
 * demo-preflight.mjs — checks that the local synthetic /demo can run.
 *
 * Verifies the root `.env` has a usable Ed25519 receipt-signing keypair and a local KMS key,
 * and that the bind host is loopback. With `--live`, also probes the three local servers.
 *
 * Prints variable NAMES and pass/fail only. Never prints a key, token, or any env value.
 * Exits 1 with the exact fix when something is missing. Uses Node built-ins only.
 *
 *   node scripts/demo-preflight.mjs          # env checks
 *   node scripts/demo-preflight.mjs --live   # env checks + http://127.0.0.1:{4000,3000,3001}
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = resolve(REPO_ROOT, ".env");
const LIVE = process.argv.includes("--live");

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const failures = [];
const warnings = [];
const passes = [];

function fail(msg, fix) { failures.push({ msg, fix }); }
function warn(msg) { warnings.push(msg); }
function pass(msg) { passes.push(msg); }

/** Minimal .env parser: KEY=VALUE, optional surrounding quotes, # comments. No interpolation. */
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function checkJwk(env, name, { requirePrivate }) {
  const raw = env[name];
  if (!raw) {
    fail(`${name} is not set`, "node apps/api/scripts/generate-receipt-keypair.mjs   # paste both printed lines into .env");
    return;
  }
  if (raw.includes("REPLACE") || raw.includes("<base64url")) {
    fail(`${name} still holds the .env.example placeholder`, "node apps/api/scripts/generate-receipt-keypair.mjs");
    return;
  }
  let jwk;
  try { jwk = JSON.parse(raw); } catch {
    fail(`${name} is not valid JSON`, "Re-run the keypair generator and paste the line exactly, including the single quotes.");
    return;
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    fail(`${name} is not an Ed25519 OKP JWK`, "node apps/api/scripts/generate-receipt-keypair.mjs");
    return;
  }
  if (requirePrivate && typeof jwk.d !== "string") {
    fail(`${name} has no private component`, "Use the PRIVATE line from the generator for this variable.");
    return;
  }
  if (!requirePrivate && typeof jwk.d === "string") {
    warn(`${name} contains a private component; the public variable should hold only the public JWK.`);
  }
  pass(`${name}: Ed25519 ${requirePrivate ? "private" : "public"} JWK present`);
}

function checkKmsKey(env) {
  const raw = env.AEGIS_LOCAL_KMS_KEY_B64;
  if (!raw) {
    fail("AEGIS_LOCAL_KMS_KEY_B64 is not set", 'echo "AEGIS_LOCAL_KMS_KEY_B64=$(openssl rand -base64 32)" >> .env');
    return;
  }
  if (raw.includes("REPLACE")) {
    fail("AEGIS_LOCAL_KMS_KEY_B64 still holds the .env.example placeholder", 'echo "AEGIS_LOCAL_KMS_KEY_B64=$(openssl rand -base64 32)" >> .env');
    return;
  }
  let bytes;
  try { bytes = Buffer.from(raw, "base64"); } catch { bytes = Buffer.alloc(0); }
  if (bytes.length !== 32) {
    fail("AEGIS_LOCAL_KMS_KEY_B64 does not decode to 32 bytes", 'echo "AEGIS_LOCAL_KMS_KEY_B64=$(openssl rand -base64 32)" >> .env');
    return;
  }
  pass("AEGIS_LOCAL_KMS_KEY_B64: 32-byte key present");
}

function checkBindHost(env) {
  const raw = env.AEGIS_API_BIND_HOST;
  if (raw === undefined || raw === "") { pass("AEGIS_API_BIND_HOST: unset → 127.0.0.1 (loopback)"); return; }
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!LOOPBACK.has(host)) {
    fail("AEGIS_API_BIND_HOST is not a loopback host; the API will refuse to start", "Set AEGIS_API_BIND_HOST=127.0.0.1 (or ::1 / localhost) or remove it.");
    return;
  }
  pass(`AEGIS_API_BIND_HOST: ${host} (loopback)`);
}

function checkProviders(env) {
  if (env.AEGIS_RECEIPT_ALLOW_UNSIGNED_DEV === "true") {
    warn("AEGIS_RECEIPT_ALLOW_UNSIGNED_DEV=true is set. It does NOT bypass approval signing; approvals still require the JWK keypair.");
  }
  if (env.AEGIS_PERSISTENCE_PROVIDER === "supabase") {
    warn("AEGIS_PERSISTENCE_PROVIDER=supabase. The demo works with the default local provider; Supabase is not required.");
  }
  if (env.AEGIS_KMS_PROVIDER && env.AEGIS_KMS_PROVIDER !== "local_dev") {
    fail(`AEGIS_KMS_PROVIDER=${env.AEGIS_KMS_PROVIDER} cannot decrypt demo secrets (cloud_kms_stub always throws)`, "Set AEGIS_KMS_PROVIDER=local_dev or remove it.");
  }
}

async function probe(url, expectText) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const body = await res.text();
    if (!res.ok) return `HTTP ${res.status}`;
    if (expectText && !body.includes(expectText)) return `unexpected body (missing "${expectText}")`;
    return null;
  } catch (err) {
    return err?.name === "AbortError" ? "timeout" : (err?.cause?.code ?? err?.message ?? "unreachable");
  } finally {
    clearTimeout(t);
  }
}

async function checkLive() {
  const targets = [
    ["API", "http://127.0.0.1:4000/health", '"healthy"', "npm run dev   (or: npm -w apps/api run dev)"],
    ["Mock store", "http://127.0.0.1:3001/checkout.html", "Place Order", "npm -w apps/mock-store run dev"],
    ["Web UI", "http://127.0.0.1:3000/demo", null, "npm -w apps/web run dev"],
  ];
  for (const [label, url, expect, fix] of targets) {
    const problem = await probe(url, expect);
    if (problem) fail(`${label} not reachable at ${url} (${problem})`, fix);
    else pass(`${label} reachable at ${url}`);
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────
console.log("Aegis demo preflight (values are never printed)\n");

if (!existsSync(ENV_PATH)) {
  fail("No .env file at the repo root", "cp .env.example .env && node apps/api/scripts/generate-receipt-keypair.mjs   # then paste the two lines into .env");
} else {
  const env = parseEnv(readFileSync(ENV_PATH, "utf8"));
  checkJwk(env, "AEGIS_RECEIPT_JWS_PRIVATE_JWK", { requirePrivate: true });
  checkJwk(env, "AEGIS_RECEIPT_JWS_PUBLIC_JWK", { requirePrivate: false });
  checkKmsKey(env);
  checkBindHost(env);
  checkProviders(env);
}

if (LIVE) await checkLive();

for (const p of passes) console.log(`  PASS  ${p}`);
for (const w of warnings) console.log(`  WARN  ${w}`);
for (const f of failures) console.log(`  FAIL  ${f.msg}\n        fix: ${f.fix}`);

console.log("");
if (failures.length) {
  console.log(`Preflight FAILED (${failures.length} problem${failures.length === 1 ? "" : "s"}). The /demo approval step will not work until these are fixed.`);
  process.exit(1);
}
console.log(LIVE ? "Preflight OK. Open http://localhost:3000/demo." : "Env OK. Start the servers with `npm run dev`, then re-run with --live.");
