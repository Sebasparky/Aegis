"use client";

import { useEffect, useState } from "react";

const OUTSIDE_AGENT_PROMPT = `You are acting through Aegis, a trust and control layer for browser automation.

Rules:
- Use only Aegis browser endpoints: create-session, navigate, read-page, click, type, screenshot, request-capability, close.
- Do not access the browser directly.
- Normal browsing (search, compare, read) is allowed without interruption.
- Sensitive actions (purchase, login, form submit, identity disclosure) go through Aegis enforcement.
- Never ask the user for passwords, card numbers, CVV, addresses, or identity documents. Aegis handles these.
- If Aegis returns { "decision": "approval_required" }: stop immediately, tell the user what action is pending, and wait. Do not retry the action.
- If Aegis returns { "decision": "block" }: stop. Do not attempt to bypass the block.
- After the user approves, Aegis Runner will execute the sensitive step. You will receive a receipt confirming the outcome.
- Treat receipts as the source of truth for sensitive actions.
- The agent_pass_token was provided to you at session start. Include it in every request body.`;

const EXAMPLE_FLOW = [
  {
    step: 1,
    label: "Create a protected session",
    endpoint: "POST /api/agent/create-session",
    body: `{
  "agent_pass_token": "pass_YOUR_TOKEN",
  "purpose": "Buy running shoes",
  "mode": "headless"
}`,
    note: null,
    color: "green",
  },
  {
    step: 2,
    label: "Navigate to the page",
    endpoint: "POST /api/agent/session/:sessionId/navigate",
    body: `{
  "agent_pass_token": "pass_YOUR_TOKEN",
  "url": "https://example-store.com/checkout"
}`,
    note: null,
    color: "green",
  },
  {
    step: 3,
    label: "Read the page",
    endpoint: "POST /api/agent/session/:sessionId/read-page",
    body: `{
  "agent_pass_token": "pass_YOUR_TOKEN"
}`,
    note: null,
    color: "green",
  },
  {
    step: 4,
    label: "Click a target element",
    endpoint: "POST /api/agent/session/:sessionId/click",
    body: `{
  "agent_pass_token": "pass_YOUR_TOKEN",
  "target": { "type": "text", "value": "Place Order" }
}`,
    note: null,
    color: "green",
  },
  {
    step: 5,
    label: "Stop if approval_required",
    endpoint: null,
    body: `// Response from click:
{
  "decision": "approval_required",
  "approval_request_id": "appr_xyz",
  "reason": "Action requires user approval."
}

// → Stop. Tell the user. Wait.
// → Do NOT retry the click.
// → After user approves, Aegis Runner executes the step.
// → You receive a receipt — not raw secrets.`,
    note: "Agent must stop and wait for user approval. Aegis Runner handles the sensitive step.",
    color: "amber",
  },
  {
    step: 6,
    label: "Never bypass a block",
    endpoint: null,
    body: `// Response from click or request-capability:
{
  "decision": "block",
  "reason": "Action is blocked by collar policy."
}

// → Stop. Inform the user.
// → Do NOT attempt another path around this block.`,
    note: "Collar policy is final. Do not attempt workarounds.",
    color: "red",
  },
];

interface ToolDef {
  name: string;
  description: string;
  endpoint: string;
  method: string;
  required_inputs: string[];
  optional_inputs: string[];
  safety_notes: string[];
  possible_responses: Array<{ decision: string; description: string }>;
}

interface ToolsManifest {
  response_semantics: Record<string, string>;
  tools: ToolDef[];
}

const DECISION_COLORS: Record<string, string> = {
  allow: "text-green-400 bg-green-950 border-green-900",
  approval_required: "text-amber-400 bg-amber-950 border-amber-900",
  block: "text-red-400 bg-red-950 border-red-900",
  completed_by_runner: "text-indigo-400 bg-indigo-950 border-indigo-900",
};

function CopyBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="relative">
      <pre className="bg-gray-950 border border-gray-800 rounded-lg p-4 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed">
        {code}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 text-xs px-2 py-1 rounded bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

export default function AgentBridgePage() {
  const [manifest, setManifest] = useState<ToolsManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("http://localhost:4000/api/agent/tools")
      .then((r) => r.json())
      .then((json) => {
        if (json.ok) setManifest(json.data);
        else setError("API returned an error.");
      })
      .catch(() => setError("Could not reach the Aegis API. Is it running?"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-3xl space-y-10">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-white">Agent Bridge</h1>
        <p className="mt-2 text-gray-400 text-sm leading-relaxed">
          Aegis is not the agent. Outside agents decide what to do — browse, compare, click. Aegis
          owns the protected browser runtime, enforces collars at sensitive boundaries, and hands
          approved sensitive steps to Aegis Runner. The agent never holds secrets.
        </p>
        <div className="mt-3 flex gap-3 text-xs text-gray-500">
          <span className="text-green-400">Agents can browse.</span>
          <span className="text-gray-600">·</span>
          <span className="text-amber-400">Aegis decides when they can commit.</span>
        </div>
      </div>

      {/* Two Ways to Use Aegis */}
      <section>
        <h2 className="text-base font-semibold text-white mb-3">Two Ways to Connect an Agent</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-sm font-medium text-white mb-1">Task Package mode</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              User creates a scoped task with a specific start URL. The agent gets a one-time
              launch token and navigates to that URL. Best for controlled, single-task delegation
              where you know exactly where the agent should go.
            </p>
            <p className="mt-2 text-xs text-indigo-400">→ /tasks</p>
          </div>
          <div className="bg-gray-900 border border-indigo-900 rounded-lg p-4">
            <p className="text-sm font-medium text-white mb-1">Delegation mode</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              User creates a named delegation for an outside agent (e.g. OpenClaw) once. The agent
              stores a reusable <code className="font-mono text-amber-300">AEGIS_PASS_TOKEN</code>{" "}
              and starts new Aegis sessions for each natural-language command. User keeps texting the
              agent normally through Slack or another channel — Aegis is the protected browser
              runtime underneath.
            </p>
            <p className="mt-2 text-xs text-indigo-400">→ /delegations</p>
          </div>
        </div>
      </section>

      {/* Response Semantics */}
      <section>
        <h2 className="text-base font-semibold text-white mb-3">Response Semantics</h2>
        <div className="space-y-2">
          {[
            { key: "allow", label: "allow", agent: "Continue." },
            {
              key: "approval_required",
              label: "approval_required",
              agent: "Stop. Tell the user what is pending. Wait. Do not retry.",
            },
            { key: "block", label: "block", agent: "Stop. Do not bypass. Inform the user." },
            {
              key: "completed_by_runner",
              label: "completed_by_runner",
              agent: "Continue. Receipt is the record. Secrets were never shared.",
            },
          ].map(({ key, label, agent }) => (
            <div
              key={key}
              className={`flex items-start gap-3 border rounded-lg px-3 py-2 ${DECISION_COLORS[key]}`}
            >
              <code className="text-xs font-mono shrink-0 mt-0.5">{label}</code>
              <span className="text-xs opacity-80">{agent}</span>
            </div>
          ))}
          <p className="text-xs text-gray-600 pt-1">
            <code className="font-mono">sensitive_data_shared_with_agent</code> is always{" "}
            <code className="font-mono">false</code>. Vault values are never returned to the
            outside agent.
          </p>
        </div>
      </section>

      {/* Available Tools */}
      <section>
        <h2 className="text-base font-semibold text-white mb-3">
          Available Tools{" "}
          <span className="text-xs font-normal text-gray-500 ml-1">
            — GET /api/agent/tools
          </span>
        </h2>

        {loading && <p className="text-gray-500 text-sm">Loading tools manifest...</p>}
        {error && (
          <div className="bg-red-950 border border-red-900 rounded-lg p-4 text-sm text-red-400">
            {error}
          </div>
        )}

        {manifest && (
          <div className="space-y-3">
            {manifest.tools.map((tool) => (
              <div
                key={tool.name}
                className="bg-gray-900 border border-gray-800 rounded-lg p-4"
              >
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-indigo-950 border border-indigo-900 text-indigo-400">
                    {tool.name}
                  </span>
                  <span className="text-xs font-mono text-gray-600">{tool.endpoint}</span>
                </div>
                <p className="text-sm text-gray-400 mb-3">{tool.description}</p>

                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mb-3">
                  {tool.required_inputs.length > 0 && (
                    <div>
                      <span className="text-gray-600">Required: </span>
                      <span className="text-gray-400 font-mono">
                        {tool.required_inputs.join(", ")}
                      </span>
                    </div>
                  )}
                  {tool.optional_inputs.length > 0 && (
                    <div>
                      <span className="text-gray-600">Optional: </span>
                      <span className="text-gray-400 font-mono">
                        {tool.optional_inputs.join(", ")}
                      </span>
                    </div>
                  )}
                </div>

                {tool.possible_responses.length > 1 && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {tool.possible_responses.map((r) => (
                      <span
                        key={r.decision}
                        className={`text-xs px-2 py-0.5 rounded border font-mono ${DECISION_COLORS[r.decision] ?? "text-gray-400 bg-gray-800 border-gray-700"}`}
                      >
                        {r.decision}
                      </span>
                    ))}
                  </div>
                )}

                {tool.safety_notes.length > 0 && (
                  <ul className="space-y-0.5">
                    {tool.safety_notes.map((note, i) => (
                      <li key={i} className="text-xs text-gray-600">
                        · {note}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Copy-Paste Prompt */}
      <section>
        <h2 className="text-base font-semibold text-white mb-1">
          Outside-Agent System Prompt
        </h2>
        <p className="text-sm text-gray-500 mb-3">
          Paste this into the system prompt of Claude, ChatGPT, or any agent that will use Aegis.
        </p>
        <CopyBlock code={OUTSIDE_AGENT_PROMPT} />
      </section>

      {/* Example API Flow */}
      <section>
        <h2 className="text-base font-semibold text-white mb-3">Example API Flow</h2>
        <div className="space-y-3">
          {EXAMPLE_FLOW.map(({ step, label, endpoint, body, note, color }) => (
            <div
              key={step}
              className={`bg-gray-900 border rounded-lg p-4 ${
                color === "amber"
                  ? "border-amber-900"
                  : color === "red"
                    ? "border-red-900"
                    : "border-gray-800"
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                    color === "amber"
                      ? "bg-amber-950 text-amber-400"
                      : color === "red"
                        ? "bg-red-950 text-red-400"
                        : "bg-gray-800 text-gray-500"
                  }`}
                >
                  {step}
                </span>
                <span className="text-sm font-medium text-white">{label}</span>
                {endpoint && (
                  <span className="text-xs font-mono text-gray-600 ml-1">{endpoint}</span>
                )}
              </div>
              <pre className="text-xs font-mono text-gray-400 bg-gray-950 border border-gray-800 rounded p-3 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                {body}
              </pre>
              {note && (
                <p
                  className={`text-xs mt-2 ${
                    color === "amber" ? "text-amber-500" : "text-red-500"
                  }`}
                >
                  {note}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Pass Token Warning */}
      <section>
        <div className="bg-amber-950 border border-amber-900 rounded-lg p-4">
          <p className="text-sm font-semibold text-amber-400 mb-1">MVP Pass Token Warning</p>
          <p className="text-xs text-amber-200 leading-relaxed">
            In the current MVP, a pass token grants full access to a protected browser session.
            Treat it like a password — do not log it, do not expose it in frontend code, and do
            not commit it to version control. Pass tokens do not yet have expiry rotation or
            scoped permission beyond the attached collar. Production use will require encrypted
            token management.
          </p>
        </div>
      </section>

      {/* Current Limitations */}
      <section>
        <h2 className="text-base font-semibold text-white mb-2">Current Limitations</h2>
        <ul className="space-y-1 text-sm text-gray-500">
          {[
            "MCP server available — see apps/mcp-server/README.md for setup and tool list.",
            "No real LLM integration — demo uses a simulated agent script.",
            "Mock vault only — fake card and address data; no real credentials.",
            "Local mock store only — sensitive detection is tuned for localhost.",
            "No real payment — runner fills form fields but does not submit.",
            "In-memory store — sessions, passes, and receipts reset on API restart.",
          ].map((line, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-gray-700 shrink-0">·</span>
              {line}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
