import type { FastifyInstance } from "fastify";
import type { SensitiveActionTimelineItem, SensitiveActionEventType } from "@aegis/types";
import {
  MOCK_USER_ID,
  credentialUseAuthorizations,
  secretFieldInjections,
  securityChallenges,
  challengeEmailResolutions,
  credentialStepHandoffs,
  paymentCardFillHandoffs,
  purchaseConfirmationHandoffs,
} from "../store/index.js";
import { taskBrowserSessions } from "../runtime/taskBrowserSessions.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function sanitizeReceiptText(input: unknown, maxLen = 160): string {
  if (typeof input !== "string") return "";
  let s = input.replace(/\s+/g, " ").trim();
  s = s.replace(/\b\d{6,8}\b/g, "[redacted-code]");
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  s = s.replace(/(password|token|secret|code)\s*[:=]\s*[^,\s]+/gi, "$1=[redacted]");
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + "…";
  return s;
}

function getSinceCutoff(since: string): number {
  const now = Date.now();
  switch (since) {
    case "today": {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "7d":
      return now - 7 * 24 * 60 * 60 * 1000;
    case "all":
      return 0;
    case "24h":
    default:
      return now - 24 * 60 * 60 * 1000;
  }
}

const EVENT_GROUP_TYPES: Record<string, SensitiveActionEventType[]> = {
  browser: ["task_browser_session_started", "task_browser_session_closed"],
  credential: [
    "credential_authorization_approved",
    "credential_authorization_fulfilled",
    "secret_field_injected",
    "credential_step_handoff_executed",
  ],
  challenge: [
    "security_challenge_reported",
    "challenge_code_submitted_manual",
    "challenge_code_injected",
  ],
  email: [
    "challenge_email_resolution_requested",
    "challenge_email_code_found",
    "challenge_email_code_injected",
  ],
  payment: ["payment_card_fill_executed", "purchase_confirmation_submitted", "purchase_confirmation_failed"],
};

// ─── Route ────────────────────────────────────────────────────────────────────

export async function sensitiveReceiptsRouter(server: FastifyInstance): Promise<void> {
  server.get("/api/internal/sensitive-receipts/recent", async (req, reply) => {
    const {
      browser_session_id: bsFilter,
      authorization_id: authFilter,
      challenge_id: chFilter,
      since: sinceParam,
      event_group: eventGroupParam,
      limit: limitStr,
    } = (req.query ?? {}) as {
      browser_session_id?: string;
      authorization_id?: string;
      challenge_id?: string;
      since?: string;
      event_group?: string;
      limit?: string;
    };
    const limit = Math.min(parseInt(limitStr ?? "50", 10) || 50, 200);

    const items: SensitiveActionTimelineItem[] = [];

    // ── Task browser sessions ─────────────────────────────────────────────────
    // Skip if filtering by authorization_id or challenge_id — sessions are not linked by those IDs
    if (!authFilter && !chFilter) {
      for (const session of taskBrowserSessions.values()) {
        if (session.user_id !== MOCK_USER_ID) continue;
        if (bsFilter && session.browser_session_id !== bsFilter) continue;

        items.push({
          item_id: `task_browser_session_started:${session.browser_session_id}:${session.created_at}`,
          event_type: "task_browser_session_started",
          timestamp: session.created_at,
          description: "Secure browser session started for your task",
          metadata: { ephemeral: true },
          privacy_guarantees: [
            "Ephemeral browser profile — no password saving",
            "Autofill and card saving disabled",
          ],
          browser_session_id: session.browser_session_id,
        });

        if (session.closed_at) {
          items.push({
            item_id: `task_browser_session_closed:${session.browser_session_id}:${session.closed_at}`,
            event_type: "task_browser_session_closed",
            timestamp: session.closed_at,
            description: "Browser session was closed and profile cleanup completed",
            metadata: { cleanup_complete: session.cleanup_complete ?? false },
            privacy_guarantees: [
              "Browser profile deleted",
              "All cookies and session storage destroyed",
            ],
            browser_session_id: session.browser_session_id,
          });
        }
      }
    }

    // ── Credential use authorizations ─────────────────────────────────────────
    // Skip if filtering by browser_session_id or challenge_id — not linked by those IDs
    if (!bsFilter && !chFilter) {
      for (const auth of credentialUseAuthorizations.values()) {
        if (auth.user_id !== MOCK_USER_ID) continue;
        if (authFilter && auth.authorization_id !== authFilter) continue;

        if (auth.approved_at) {
          items.push({
            item_id: `credential_authorization_approved:${auth.authorization_id}:${auth.approved_at}`,
            event_type: "credential_authorization_approved",
            timestamp: auth.approved_at,
            domain: auth.domain,
            description: `${auth.pass_label} credential was approved for one login attempt on ${auth.domain}`,
            metadata: {
              domain: auth.domain,
              pass_label: auth.pass_label,
              username_uses: auth.use_counts.username,
              password_uses: auth.use_counts.password,
            },
            privacy_guarantees: [
              "One approval covers one login attempt",
              "Raw credentials never returned to agent",
            ],
            authorization_id: auth.authorization_id,
          });
        }

        if (auth.fulfilled_at) {
          items.push({
            item_id: `credential_authorization_fulfilled:${auth.authorization_id}:${auth.fulfilled_at}`,
            event_type: "credential_authorization_fulfilled",
            timestamp: auth.fulfilled_at,
            domain: auth.domain,
            description: `${auth.pass_label} credential use was completed on ${auth.domain}`,
            metadata: {
              domain: auth.domain,
              pass_label: auth.pass_label,
              fields_used: auth.used_field_kinds.join(", "),
            },
            privacy_guarantees: [
              "Raw credentials never returned to agent",
              "Authorization is now fulfilled — cannot be reused",
            ],
            authorization_id: auth.authorization_id,
          });
        }
      }
    }

    // ── Secret field injections ───────────────────────────────────────────────
    // Skip if filtering by browser_session_id or challenge_id — not linked by those IDs
    if (!bsFilter && !chFilter) {
      for (const inj of secretFieldInjections.values()) {
        if (inj.user_id !== MOCK_USER_ID) continue;
        if (inj.status !== "filled" || !inj.filled_at) continue;
        if (authFilter && inj.authorization_id !== authFilter) continue;

        const isPassword = inj.field_kind === "password";
        const sanitizedReason = sanitizeReceiptText(inj.reason);
        items.push({
          item_id: `secret_field_injected:${inj.injection_request_id}:${inj.filled_at}`,
          event_type: "secret_field_injected",
          timestamp: inj.filled_at,
          domain: inj.domain,
          description: isPassword
            ? "Password was injected without revealing it to the agent"
            : "Username was filled without revealing it to the agent",
          metadata: {
            field_kind: inj.field_kind,
            domain: inj.domain,
            ...(sanitizedReason ? { reason: sanitizedReason } : {}),
          },
          privacy_guarantees: isPassword
            ? [
                "Password injected via CDP — not returned to agent",
                "KMS-resolved secret never exposed",
              ]
            : ["Username injected via CDP — not returned to agent"],
          ...(inj.authorization_id ? { authorization_id: inj.authorization_id } : {}),
        });
      }
    }

    // ── Credential step handoffs ──────────────────────────────────────────────
    // Skip if filtering by browser_session_id or challenge_id — not linked by those IDs
    if (!bsFilter && !chFilter) {
      for (const rec of credentialStepHandoffs.values()) {
        if (rec.user_id !== MOCK_USER_ID) continue;
        if (authFilter && rec.authorization_id !== authFilter) continue;

        const isPassword = rec.step_kind === "password_submit";
        items.push({
          item_id: `credential_step_handoff_executed:${rec.handoff_id}:${rec.completed_at}`,
          event_type: "credential_step_handoff_executed",
          timestamp: rec.completed_at,
          domain: rec.domain,
          description: isPassword
            ? `Login submit completed on ${rec.domain} — outcome: ${rec.outcome}`
            : `Username step completed on ${rec.domain} — outcome: ${rec.outcome}`,
          metadata: {
            handoff_id: rec.handoff_id,
            step_kind: rec.step_kind,
            outcome: rec.outcome,
            pass_label: rec.pass_label,
            ...(rec.challenge_kind ? { challenge_kind: rec.challenge_kind } : {}),
          },
          privacy_guarantees: [
            "Raw credential was not returned to agent",
            "raw_value_revealed_to_agent: false enforced as TypeScript literal",
          ],
          ...(rec.authorization_id ? { authorization_id: rec.authorization_id } : {}),
        });
      }
    }

    // ── Security challenges ───────────────────────────────────────────────────
    // Skip if filtering by authorization_id — not linked by that ID
    if (!authFilter) {
      for (const ch of securityChallenges.values()) {
        if (ch.user_id !== MOCK_USER_ID) continue;
        if (chFilter && ch.challenge_id !== chFilter) continue;
        if (bsFilter && ch.browser_session_id !== bsFilter) continue;

        items.push({
          item_id: `security_challenge_reported:${ch.challenge_id}:${ch.created_at}`,
          event_type: "security_challenge_reported",
          timestamp: ch.created_at,
          domain: ch.domain,
          description: `A verification code challenge was detected on ${ch.domain}`,
          metadata: {
            challenge_type: ch.challenge_type,
            domain: ch.domain,
            ...(ch.masked_destination ? { masked_destination: ch.masked_destination } : {}),
          },
          privacy_guarantees: ["Verification code not shared with agent"],
          challenge_id: ch.challenge_id,
          ...(ch.browser_session_id ? { browser_session_id: ch.browser_session_id } : {}),
        });

        if (ch.submitted_at) {
          // Only emit manual submission event if Gmail did NOT resolve this challenge
          const emailResolution = Array.from(challengeEmailResolutions.values()).find(
            (r) => r.challenge_id === ch.challenge_id,
          );
          const resolvedByEmail =
            emailResolution &&
            (emailResolution.status === "code_found" || emailResolution.status === "injected");

          if (!resolvedByEmail) {
            items.push({
              item_id: `challenge_code_submitted_manual:${ch.challenge_id}:${ch.submitted_at}`,
              event_type: "challenge_code_submitted_manual",
              timestamp: ch.submitted_at,
              domain: ch.domain,
              description: "Verification code was submitted in the Antigen UI",
              metadata: { challenge_type: ch.challenge_type, domain: ch.domain },
              privacy_guarantees: ["Code entered in Antigen UI — not pasted into chat"],
              challenge_id: ch.challenge_id,
              ...(ch.browser_session_id ? { browser_session_id: ch.browser_session_id } : {}),
            });
          }
        }

        if (ch.injected_at) {
          items.push({
            item_id: `challenge_code_injected:${ch.challenge_id}:${ch.injected_at}`,
            event_type: "challenge_code_injected",
            timestamp: ch.injected_at,
            domain: ch.domain,
            description: "Verification code was injected and deleted from memory",
            metadata: { challenge_type: ch.challenge_type, domain: ch.domain },
            privacy_guarantees: ["Code injected via CDP and deleted from Antigen memory immediately"],
            challenge_id: ch.challenge_id,
            ...(ch.browser_session_id ? { browser_session_id: ch.browser_session_id } : {}),
          });
        }
      }
    }

    // ── Challenge email resolutions ───────────────────────────────────────────
    // Skip if filtering by browser_session_id or authorization_id — not linked by those IDs
    if (!bsFilter && !authFilter) {
      for (const res of challengeEmailResolutions.values()) {
        if (res.user_id !== MOCK_USER_ID) continue;
        if (chFilter && res.challenge_id !== chFilter) continue;

        items.push({
          item_id: `challenge_email_resolution_requested:${res.resolution_id}:${res.created_at}`,
          event_type: "challenge_email_resolution_requested",
          timestamp: res.created_at,
          domain: res.domain,
          description: `Email code search was started for ${res.domain}`,
          metadata: {
            domain: res.domain,
            ...(res.sender_domain ? { sender_domain: res.sender_domain } : {}),
          },
          privacy_guarantees: [
            "No email body or inbox listing returned to agent",
            "Search is sender-allowlisted only",
          ],
          challenge_id: res.challenge_id,
          resolution_id: res.resolution_id,
        });

        if (res.found_at) {
          items.push({
            item_id: `challenge_email_code_found:${res.resolution_id}:${res.found_at}`,
            event_type: "challenge_email_code_found",
            timestamp: res.found_at,
            domain: res.domain,
            description: "A verification code was found in email and held in Antigen memory",
            metadata: {
              domain: res.domain,
              ...(res.sender_domain ? { sender_domain: res.sender_domain } : {}),
              ...(res.received_at ? { received_at: res.received_at } : {}),
            },
            privacy_guarantees: ["Code held in Antigen memory only — not returned to agent"],
            challenge_id: res.challenge_id,
            resolution_id: res.resolution_id,
          });
        }

        if (res.injected_at) {
          items.push({
            item_id: `challenge_email_code_injected:${res.resolution_id}:${res.injected_at}`,
            event_type: "challenge_email_code_injected",
            timestamp: res.injected_at,
            domain: res.domain,
            description: "Verification code was injected from email and deleted from memory",
            metadata: { domain: res.domain },
            privacy_guarantees: [
              "Code injected via CDP and deleted from memory immediately",
              "Email body never exposed",
            ],
            challenge_id: res.challenge_id,
            resolution_id: res.resolution_id,
          });
        }
      }
    }

    // ── Payment card fill handoffs ────────────────────────────────────────────
    // Skip if filtering by browser_session_id or challenge_id — not linked by those IDs
    if (!bsFilter && !chFilter) {
      for (const rec of paymentCardFillHandoffs.values()) {
        if (rec.user_id !== MOCK_USER_ID) continue;
        if (authFilter && rec.authorization_id !== authFilter) continue;

        items.push({
          item_id: `payment_card_fill_executed:${rec.handoff_id}:${rec.completed_at}`,
          event_type: "payment_card_fill_executed",
          timestamp: rec.completed_at,
          domain: rec.domain,
          description: `Card field '${rec.field}' fill ${rec.outcome} on ${rec.domain} — ${rec.payment_method_label} ···${rec.last4}`,
          metadata: {
            handoff_id: rec.handoff_id,
            field: rec.field,
            outcome: rec.outcome,
            payment_method_label: rec.payment_method_label,
            last4: rec.last4,
            raw_values_revealed_to_agent: false,
            purchase_not_authorized: true,
          },
          privacy_guarantees: [
            "Raw card values were not returned to the agent",
            "raw_values_revealed_to_agent: false enforced as TypeScript literal",
            "purchase_not_authorized: true — this is card field fill only, not a purchase authorization",
          ],
          authorization_id: rec.authorization_id,
        });
      }
    }

    // ── Purchase confirmation handoffs ────────────────────────────────────────
    if (!bsFilter && !chFilter) {
      for (const rec of purchaseConfirmationHandoffs.values()) {
        if (rec.user_id !== MOCK_USER_ID) continue;

        const eventType = rec.outcome === "submitted"
          ? "purchase_confirmation_submitted" as const
          : "purchase_confirmation_failed" as const;

        const amountStr = rec.amount != null ? ` ${rec.currency}${rec.amount}` : " (amount unknown)";
        items.push({
          item_id: `purchase_confirmation_${rec.outcome}:${rec.handoff_id}:${rec.completed_at}`,
          event_type: eventType,
          timestamp: rec.completed_at,
          domain: rec.domain,
          description: `Purchase ${rec.outcome} on ${rec.domain} — ${rec.merchant}${amountStr} via ${rec.payment_method_label} ···${rec.payment_method_last4}`,
          metadata: {
            handoff_id: rec.handoff_id,
            merchant: rec.merchant,
            outcome: rec.outcome,
            button_text: rec.button_text,
            payment_method_label: rec.payment_method_label,
            last4: rec.payment_method_last4,
            raw_values_revealed_to_agent: false,
          },
          privacy_guarantees: [
            "Raw card values were not returned to the agent",
            "raw_values_revealed_to_agent: false enforced as TypeScript literal",
            "No card number, CVV, card refs, ciphertext, cookies, storage, CDP URL, or KMS material in this record",
            "Purchase confirmation is a separate approval from card field fill",
          ],
          purchase_confirmation_id: rec.purchase_confirmation_id,
        });
      }
    }

    // ── Apply time filter ─────────────────────────────────────────────────────
    const cutoffMs = getSinceCutoff(sinceParam ?? "24h");
    const timeFiltered =
      cutoffMs === 0
        ? items
        : items.filter((item) => new Date(item.timestamp).getTime() >= cutoffMs);

    // ── Apply event group filter ──────────────────────────────────────────────
    const allowedTypes =
      eventGroupParam && eventGroupParam !== "all"
        ? EVENT_GROUP_TYPES[eventGroupParam]
        : null;
    const grouped = allowedTypes
      ? timeFiltered.filter((item) => allowedTypes.includes(item.event_type))
      : timeFiltered;

    grouped.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return reply.send({ items: grouped.slice(0, limit) });
  });
}
