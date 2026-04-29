"use client";

import { useRef, useState } from "react";
import {
  listCollars,
  createPass,
  createAgentSession,
  agentNavigate,
  agentClick,
  approveRequest,
} from "@/lib/api";

type Phase =
  | "idle"
  | "running"
  | "waiting_approval"
  | "approving"
  | "done"
  | "error";

interface StepDef {
  label: string;
  activeIn: Phase[];
  doneAfter: Phase[];
}

const STEPS: StepDef[] = [
  {
    label: "Protected session created",
    activeIn: ["running"],
    doneAfter: ["waiting_approval", "approving", "done"],
  },
  {
    label: "Checkout reached",
    activeIn: ["running"],
    doneAfter: ["waiting_approval", "approving", "done"],
  },
  {
    label: "Sensitive action detected",
    activeIn: ["running"],
    doneAfter: ["waiting_approval", "approving", "done"],
  },
  {
    label: "Waiting for approval",
    activeIn: ["waiting_approval"],
    doneAfter: ["approving", "done"],
  },
  {
    label: "Runner filled fake checkout data",
    activeIn: ["approving"],
    doneAfter: ["done"],
  },
  {
    label: "Receipt created",
    activeIn: [],
    doneAfter: ["done"],
  },
];

function stepStatus(step: StepDef, phase: Phase): "pending" | "active" | "done" {
  if (step.doneAfter.includes(phase)) return "done";
  if (step.activeIn.includes(phase)) return "active";
  return "pending";
}

export default function DemoPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [approvalRequestId, setApprovalId] = useState<string | null>(null);
  const [runnerTaskId, setRunnerTaskId] = useState<string | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const passTokenRef = useRef<string | null>(null);

  async function handleRunDemo() {
    setPhase("running");
    setSessionId(null);
    setApprovalId(null);
    setRunnerTaskId(null);
    setReceiptId(null);
    setErrorMsg(null);
    passTokenRef.current = null;

    try {
      const collars = await listCollars();
      if (!collars.length) throw new Error("No collars found. Is the API seeded?");
      const collarId = collars[0].id;

      const pass = await createPass({
        agent_name: "Demo Agent",
        purpose: "Aegis Demo — shopping checkout",
        default_collar_id: collarId,
        expires_in_minutes: 30,
      });

      if (!pass.token) throw new Error("Pass created but no token returned.");
      passTokenRef.current = pass.token;

      const session = await createAgentSession(pass.token, "Aegis Demo");
      setSessionId(session.session_id);

      await agentNavigate(pass.token, session.session_id, "http://localhost:3001/checkout.html");

      const click = await agentClick(pass.token, session.session_id, {
        type: "text",
        value: "Place Order",
      });

      if (click.decision !== "approval_required" || !click.approval_request_id) {
        throw new Error(
          `Expected approval_required but got: ${click.decision}. Make sure the mock store is running on port 3001.`
        );
      }

      setApprovalId(click.approval_request_id);
      setPhase("waiting_approval");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  async function handleApproveAndRun() {
    if (!approvalRequestId) return;
    setPhase("approving");
    setErrorMsg(null);

    try {
      const result = await approveRequest(approvalRequestId, "Approved for demo");
      setRunnerTaskId(result.runner_task_id ?? null);
      setReceiptId(result.receipt_id);
      setPhase("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  const isRunning = phase === "running" || phase === "approving";

  return (
    <div className="max-w-2xl">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-1">
          <h1 className="text-2xl font-semibold text-white">Demo</h1>
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 font-mono">
            simulated · local · fake data
          </span>
        </div>
        <p className="text-sm text-gray-400 mt-1">
          Aegis lets outside agents browse freely, but pauses sensitive actions and lets
          Aegis Runner execute approved steps without exposing secrets.
        </p>
      </div>

      {/* Timeline */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 mb-6">
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-4">
          Demo Flow
        </h2>
        <ol className="space-y-3">
          {STEPS.map((step, i) => {
            const status = stepStatus(step, phase);
            return (
              <li key={i} className="flex items-center gap-3">
                <span
                  className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold transition-colors
                    ${status === "done" ? "bg-green-800 text-green-400" : ""}
                    ${status === "active" ? "bg-indigo-700 text-indigo-300 animate-pulse" : ""}
                    ${status === "pending" ? "bg-gray-800 text-gray-600" : ""}
                  `}
                >
                  {status === "done" ? "✓" : i + 1}
                </span>
                <span
                  className={`text-sm transition-colors
                    ${status === "done" ? "text-green-400" : ""}
                    ${status === "active" ? "text-indigo-300" : ""}
                    ${status === "pending" ? "text-gray-600" : ""}
                  `}
                >
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Action Panel */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 mb-6 space-y-4">
        {/* Run Agent Demo */}
        <div>
          <button
            disabled={isRunning}
            onClick={handleRunDemo}
            className="text-sm bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed text-white px-5 py-2 rounded-md transition-colors font-medium"
          >
            {phase === "running" ? "Running agent demo…" : "Run Agent Demo"}
          </button>
          <p className="text-xs text-gray-600 mt-1.5">
            This demo uses a local mock store and fake vault data. No real payment is made.
          </p>
        </div>

        {/* IDs after agent run */}
        {(phase === "waiting_approval" || phase === "approving" || phase === "done") && (
          <div className="border-t border-gray-800 pt-4 space-y-1.5">
            {sessionId && (
              <p className="text-xs text-gray-500">
                <span className="text-gray-600">session_id</span>{" "}
                <span className="font-mono text-gray-400">{sessionId}</span>
              </p>
            )}
            {approvalRequestId && (
              <p className="text-xs text-gray-500">
                <span className="text-gray-600">approval_request_id</span>{" "}
                <span className="font-mono text-gray-400">{approvalRequestId}</span>
              </p>
            )}
          </div>
        )}

        {/* Approve and Run */}
        {(phase === "waiting_approval" || phase === "approving") && (
          <div className="border-t border-gray-800 pt-4">
            <button
              disabled={phase === "approving"}
              onClick={handleApproveAndRun}
              className="text-sm bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-5 py-2 rounded-md transition-colors font-medium"
            >
              {phase === "approving" ? "Running Aegis Runner…" : "Approve and Run Aegis Runner"}
            </button>
          </div>
        )}

        {/* Success state */}
        {phase === "done" && (
          <div className="border-t border-gray-800 pt-4 space-y-3">
            <div className="space-y-1.5">
              {runnerTaskId && (
                <p className="text-xs text-gray-500">
                  <span className="text-gray-600">runner_task_id</span>{" "}
                  <span className="font-mono text-gray-400">{runnerTaskId}</span>
                </p>
              )}
              {receiptId && (
                <p className="text-xs text-gray-500">
                  <span className="text-gray-600">receipt_id</span>{" "}
                  <span className="font-mono text-gray-400">{receiptId}</span>
                </p>
              )}
            </div>
            <div className="bg-green-950 border border-green-800 rounded-md px-4 py-3">
              <p className="text-xs text-green-300 font-medium mb-0.5">
                Aegis Runner filled fake checkout details from the mock vault.
              </p>
              <p className="text-xs text-green-500">
                The outside agent never received the card number, CVV, or address.
              </p>
            </div>
          </div>
        )}

        {/* Error state */}
        {phase === "error" && errorMsg && (
          <div className="border-t border-gray-800 pt-4">
            <div className="bg-red-950 border border-red-800 rounded-md px-4 py-3">
              <p className="text-xs text-red-400 font-medium mb-0.5">Demo failed</p>
              <p className="text-xs text-red-500 font-mono">{errorMsg}</p>
            </div>
            <button
              onClick={handleRunDemo}
              className="mt-3 text-xs text-gray-400 hover:text-white px-3 py-1.5 border border-gray-700 rounded-md transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>

      {/* What this proves */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
          What this proves
        </h2>
        <ul className="space-y-2">
          {[
            "Outside agent chose the browser action.",
            "Aegis intercepted the sensitive click before execution.",
            "User approval was required.",
            "Aegis Runner filled fake checkout data from the mock vault.",
            "The outside agent never received the card number, CVV, or address.",
            "A receipt was created.",
          ].map((point) => (
            <li key={point} className="flex items-start gap-2 text-sm text-gray-400">
              <span className="text-indigo-500 mt-0.5 shrink-0">—</span>
              {point}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
