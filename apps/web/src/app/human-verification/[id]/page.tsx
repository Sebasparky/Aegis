"use client";

/**
 * Human Presence Relay — focused verification page.
 *
 * Opened from the pending card in /route-run-approvals. Branches by challenge
 * type:
 *   press_and_hold → branded live hold (mirrored into the browser while held)
 *   checkbox_human → single "Confirm presence" tap (mirrored as one click)
 *   captcha/unknown → manual handoff (user solves in the browser, then recheck)
 *
 * Security: this page only ever sees the safe request view — no selectors,
 * coordinates, or page values. Completing a verification never authorizes a
 * purchase or payment.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  getHumanVerificationRequest,
  startHumanVerificationHold,
  sendHumanVerificationHeartbeat,
  endHumanVerificationHold,
  confirmHumanPresence,
  recheckHumanVerification,
  cancelHumanVerificationRequest,
  type HumanVerificationRequestView,
} from "@/lib/api";
import { PressAndHoldButton } from "@/components/press-and-hold";

const STATUS_POLL_MS = 2000;

function formatCountdown(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function GuaranteeList() {
  const items = [
    "Your live interaction is mirrored into the agent's browser in real time — nothing is recorded or replayed.",
    "Releasing early (or losing connection) immediately releases in the browser too.",
    "The agent cannot see, click, or bypass the challenge — only your live presence clears it.",
    "Completing this never authorizes a purchase, payment, or any other action.",
    "A signed receipt records that you provided live presence through Aegis.",
  ];
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((t) => (
        <li key={t} style={{ display: "flex", gap: 8, fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.5 }}>
          <span style={{ color: "oklch(0.42 0.09 150)", flexShrink: 0 }}>✓</span>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

export default function HumanVerificationPage() {
  const params = useParams<{ id: string }>();
  const requestId = params?.id;

  const [request, setRequest] = useState<HumanVerificationRequestView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [countdown, setCountdown] = useState("");
  // Pause status polling while a live hold is streaming heartbeats.
  const holdingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!requestId) return;
    try {
      const fresh = await getHumanVerificationRequest(requestId);
      setRequest(fresh);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load the request.");
    }
  }, [requestId]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      if (!holdingRef.current) void refresh();
    }, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!request) return;
    setCountdown(formatCountdown(request.expires_at));
    const id = setInterval(() => setCountdown(formatCountdown(request.expires_at)), 1000);
    return () => clearInterval(id);
  }, [request?.expires_at, request]);

  if (!requestId) return null;

  const status = request?.status;
  const actionable = status === "pending_user" || status === "in_progress";

  async function handleHoldStart(): Promise<boolean> {
    setActionError(null);
    setNotice(null);
    const res = await startHumanVerificationHold(requestId!);
    setRequest((prev) => (prev ? { ...prev, ...res } : prev));
    if (res.hold_state === "challenge_gone") {
      setNotice("The challenge is no longer on the page — the agent can resume.");
      return false;
    }
    holdingRef.current = res.hold_state === "holding";
    return res.hold_state === "holding";
  }

  async function handleHeartbeat(): Promise<"holding" | "released_fail_closed"> {
    const res = await sendHumanVerificationHeartbeat(requestId!);
    if (res.hold_state !== "holding") holdingRef.current = false;
    return res.hold_state;
  }

  async function handleHoldEnd(): Promise<void> {
    holdingRef.current = false;
    const res = await endHumanVerificationHold(requestId!);
    setRequest((prev) => (prev ? { ...prev, ...res } : prev));
    if (res.status === "completed") {
      setNotice(null);
    } else if (res.challenge_present === true) {
      setNotice("Not verified yet. The site may need a longer hold — press and hold again.");
    } else if (res.hold_state === "released_fail_closed") {
      setNotice("The hold was released for safety. Press and hold again.");
    } else {
      setNotice("Could not confirm the result — press and hold again, or check the agent's browser.");
    }
  }

  async function handleConfirm() {
    setConfirming(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await confirmHumanPresence(requestId!);
      setRequest((prev) => (prev ? { ...prev, ...res } : prev));
      if (res.confirm_state === "still_present") {
        setNotice("The challenge is still showing. Try confirming again, or complete it in the agent's browser.");
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Confirmation failed.");
    } finally {
      setConfirming(false);
    }
  }

  async function handleRecheck() {
    setRechecking(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await recheckHumanVerification(requestId!);
      setRequest((prev) => (prev ? { ...prev, ...res } : prev));
      if (res.challenge_present === true) {
        setNotice("The challenge is still showing in the browser. Complete it there, then check again.");
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Recheck failed.");
    } finally {
      setRechecking(false);
    }
  }

  async function handleCancel() {
    setCancelling(true);
    setActionError(null);
    try {
      const res = await cancelHumanVerificationRequest(requestId!);
      setRequest(res);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Cancel failed.");
    } finally {
      setCancelling(false);
    }
  }

  function renderInteraction() {
    if (!request) return null;

    if (request.status === "completed") {
      return (
        <div style={{ textAlign: "center", padding: "26px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 64, height: 64, borderRadius: "50%",
              background: "var(--green-soft)", border: "1px solid var(--green-ring)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 28, color: "oklch(0.42 0.09 150)",
            }}
          >
            ✓
          </div>
          <p style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-1)", margin: 0 }}>Verification complete. Agent resuming.</p>
          <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, maxWidth: 420 }}>
            The agent takes a fresh snapshot of the page before continuing. No purchase or payment was authorized by this verification.
          </p>
        </div>
      );
    }

    if (request.status === "expired" || request.status === "cancelled" || request.status === "failed") {
      const copy =
        request.status === "expired"
          ? "This request expired before completion. If the challenge is still in the agent's browser, a new request will appear automatically."
          : request.status === "cancelled"
            ? "This request was cancelled. If the challenge is still in the agent's browser, a new request will appear automatically."
            : "The live relay hit a browser error. If the challenge is still in the agent's browser, a new request will appear automatically.";
      return (
        <div style={{ textAlign: "center", padding: "22px 0" }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-2)", margin: "0 0 6px", textTransform: "capitalize" }}>{request.status}</p>
          <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0 }}>{copy}</p>
        </div>
      );
    }

    // Page-level cross-origin-iframe wall: the control is inside a secured frame
    // Aegis can't relay into — manual completion + recheck only, never the live
    // hold button (checked before the press_and_hold branch on purpose).
    if (request.page_level) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "8px 0" }}>
          <div style={{ background: "var(--amber-soft)", border: "1px solid var(--amber-ring)", borderRadius: "var(--r-2)", padding: "12px 16px" }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: "oklch(0.45 0.12 75)", margin: "0 0 4px" }}>Manual verification required</p>
            <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: 0, lineHeight: 1.55 }}>
              This page is showing a full-page human-verification wall whose control sits inside a secured
              frame Aegis can&apos;t relay into. Complete the visible challenge directly in the agent&apos;s
              browser window, then press &quot;I&apos;ve completed it&quot; — the agent takes a fresh snapshot and resumes.
            </p>
          </div>
          <button
            className="a-btn a-btn--primary"
            disabled={!actionable || rechecking}
            onClick={handleRecheck}
            style={{ alignSelf: "center" }}
          >
            {rechecking ? "Checking…" : "I've completed it"}
          </button>
        </div>
      );
    }

    if (request.challenge_type === "press_and_hold") {
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "12px 0" }}>
          <PressAndHoldButton
            disabled={!actionable}
            onHoldStart={handleHoldStart}
            onHeartbeat={handleHeartbeat}
            onHoldEnd={handleHoldEnd}
            onError={(m) => setActionError(m)}
          />
        </div>
      );
    }

    if (request.challenge_type === "checkbox_human") {
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "18px 0" }}>
          <button
            className="a-btn a-btn--primary"
            disabled={!actionable || confirming}
            onClick={handleConfirm}
            style={{ fontSize: 14, padding: "12px 26px" }}
          >
            {confirming ? "Confirming…" : "Confirm presence"}
          </button>
          <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: 0, textAlign: "center", maxWidth: 420 }}>
            Aegis mirrors a single click into the site's confirmation control — caused by your tap, right now.
          </p>
        </div>
      );
    }

    // Deferred types: image/text/puzzle captcha + unknown — manual handoff only.
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "8px 0" }}>
        <div style={{ background: "var(--amber-soft)", border: "1px solid var(--amber-ring)", borderRadius: "var(--r-2)", padding: "12px 16px" }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "oklch(0.45 0.12 75)", margin: "0 0 4px" }}>Manual verification required</p>
          <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: 0, lineHeight: 1.55 }}>
            This challenge ({request.challenge_label.toLowerCase()}) can't be relayed yet — Aegis never auto-solves captchas.
            Complete it directly in the agent's browser window, then come back and press "I've completed it".
          </p>
        </div>
        <button
          className="a-btn a-btn--primary"
          disabled={!actionable || rechecking}
          onClick={handleRecheck}
          style={{ alignSelf: "center" }}
        >
          {rechecking ? "Checking…" : "I've completed it"}
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 660, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <Link href="/route-run-approvals" style={{ fontSize: 12.5, color: "var(--ink-3)", textDecoration: "none" }}>
          ← Back to approvals
        </Link>
      </div>

      {loadError && !request && (
        <div className="a-card" style={{ padding: 20 }}>
          <p style={{ fontSize: 13, color: "oklch(0.45 0.13 25)", margin: 0 }}>{loadError}</p>
        </div>
      )}

      {request && (
        <div className="apr-card apr-card--amber">
          <div className="apr-card__head">
            <div>
              <div className="a-eyebrow" style={{ color: "oklch(0.45 0.12 75)", marginBottom: 4 }}>Human verification</div>
              <p style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 2px" }}>
                {request.challenge_label}
                {request.surface_title ? ` — “${request.surface_title}”` : ""}
              </p>
              <p style={{ fontSize: 11.5, color: "oklch(0.45 0.12 75)", fontFamily: "monospace", margin: 0 }}>{request.domain}</p>
            </div>
            <span
              className={
                request.status === "completed"
                  ? "a-status a-status--green"
                  : actionable
                    ? "a-status a-status--amber"
                    : "a-status a-status--quiet"
              }
              style={{ flexShrink: 0 }}
            >
              {actionable && <span className="a-status__dot" />}
              {request.status === "pending_user"
                ? "Verification required"
                : request.status === "in_progress"
                  ? "In progress"
                  : request.status}
            </span>
          </div>

          <div className="apr-card__body">
            <div className="apr-box">
              <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: 0, lineHeight: 1.55 }}>{request.instructions}</p>
              <p style={{ fontSize: 11.5, color: "var(--ink-4)", margin: "8px 0 0" }}>
                Agent: <span style={{ color: "var(--ink-2)" }}>{request.agent_name ?? request.delegation_id}</span>
                {actionable && countdown && (
                  <>
                    {" · "}Expires in <span style={{ fontFamily: "monospace", color: "var(--ink-2)" }}>{countdown}</span>
                  </>
                )}
              </p>
            </div>

            {renderInteraction()}

            {notice && (
              <p style={{ fontSize: 12.5, color: "oklch(0.45 0.12 75)", margin: 0, textAlign: "center" }}>{notice}</p>
            )}
            {actionError && (
              <p style={{ fontSize: 12.5, color: "oklch(0.45 0.13 25)", margin: 0, textAlign: "center" }}>{actionError}</p>
            )}

            <div className="apr-box">
              <div className="apr-box__head">Aegis guarantees</div>
              <GuaranteeList />
            </div>

            {actionable && (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button className="a-btn a-btn--danger" disabled={cancelling} onClick={handleCancel}>
                  {cancelling ? "Cancelling…" : "Cancel request"}
                </button>
              </div>
            )}

            <p style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "monospace", margin: 0 }}>{request.request_id}</p>
          </div>
        </div>
      )}
    </div>
  );
}
