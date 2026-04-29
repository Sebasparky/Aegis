import type { FastifyInstance } from "fastify";
import type { ProtectedSession, ApprovalRequest, Receipt } from "@aegis/types";
import { sessions, approvals, receipts, reputationEvents, collars, newId } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";
import type { PassWithToken } from "../store/index.js";
import { validatePassToken } from "../services/passValidator.js";
import { evaluateAction } from "../policies/evaluate.js";
import {
  createBrowserSession,
  getController,
  closeBrowserSession,
} from "../browser/browserManager.js";
import { detect } from "../detection/sensitiveDetector.js";
import type { ElementTarget } from "../browser/actionInspector.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

function lookupTrustStatus(domain?: string) {
  // Domain trust lookup is mocked for MVP.
  // Real implementation will query domain_trust_records.
  if (!domain) return "unknown" as const;
  const known: Record<string, "business_verified" | "domain_verified"> = {
    "nike.com": "business_verified",
    "amazon.com": "business_verified",
    "example-store.com": "domain_verified",
  };
  return known[domain.toLowerCase()] ?? ("unverified" as const);
}

/**
 * Shared guard for browser-action routes.
 *
 * Validates: pass token → session exists → session owned by pass → not expired.
 * Returns the resolved session, or sends an error and returns null.
 */
async function guardBrowserSession(
  reply: any,
  token: string | undefined,
  sessionId: string
): Promise<{ pass: PassWithToken; session: ProtectedSession } | null> {
  const validation = validatePassToken(token);
  if (!validation.ok) {
    sendError(reply, 401, validation.code, validation.message);
    return null;
  }

  const { pass } = validation;
  const session = sessions.get(sessionId);
  if (!session) {
    sendError(reply, 404, "NOT_FOUND", "Session not found.");
    return null;
  }
  if (session.aegis_pass_id !== pass.id) {
    sendError(reply, 403, "FORBIDDEN", "This session does not belong to the provided pass.");
    return null;
  }
  if (new Date(session.expires_at) < new Date()) {
    sendError(reply, 400, "SESSION_EXPIRED", "Session has expired.");
    return null;
  }

  return { pass, session };
}

// ─── Body Types ───────────────────────────────────────────────────────────────

interface CreateSessionBody {
  agent_pass_token: string;
  purpose?: string;
  requested_collar_id?: string;
  mode?: "headless" | "visible";
}

interface NavigateBody {
  agent_pass_token: string;
  url: string;
}

interface BrowserActionBody {
  agent_pass_token: string;
}

interface RequestCapabilityBody {
  agent_pass_token: string;
  action_type: string;
  domain?: string;
  context?: Record<string, unknown>;
}

interface ClickBody {
  agent_pass_token: string;
  target: ElementTarget;
}

interface TypeBody {
  agent_pass_token: string;
  target: ElementTarget;
  value: string;
}

// ─── Route Registration ───────────────────────────────────────────────────────

export async function agentRoutes(server: FastifyInstance) {
  /**
   * GET /api/agent/tools
   *
   * Machine-readable manifest of all agent-facing tools. No auth required.
   * Outside agents and MCP clients can read this to discover available endpoints.
   */
  server.get("/api/agent/tools", async (_req, _reply) => {
    return {
      ok: true,
      data: {
        response_semantics: {
          allow: "Action was safe and executed. Agent may continue.",
          approval_required:
            "Session is paused. User must approve or deny. Agent must stop and wait. Do not retry the action.",
          block:
            "Collar policy blocked the action. Agent must stop. Do not attempt to bypass.",
          completed_by_runner:
            "Aegis Runner executed the sensitive step internally. Receipt is the record. Agent may continue.",
          sensitive_data_shared_with_agent:
            "Always false. Vault values (card numbers, CVV, passwords, addresses) are never returned to the outside agent.",
        },
        tools: [
          {
            name: "create_session",
            description:
              "Open a protected Playwright browser session under an Aegis Pass. Each session gets an isolated Chromium context enforced by the collar attached to the pass.",
            endpoint: "POST /api/agent/create-session",
            method: "POST",
            required_inputs: ["agent_pass_token"],
            optional_inputs: ["purpose", "requested_collar_id", "mode"],
            example_request: {
              agent_pass_token: "pass_REPLACE_WITH_YOUR_TOKEN",
              purpose: "Buy running shoes on example-store.com",
              mode: "headless",
            },
            possible_responses: [
              {
                decision: "allow",
                description:
                  "Session created. Returns session_id, collar_id, allowed_actions, approval_required_actions, blocked_actions.",
              },
            ],
            safety_notes: [
              "Pass token grants access to a protected session — treat it like a password.",
              "Never log or expose the pass token in frontend code.",
            ],
          },
          {
            name: "navigate",
            description:
              "Navigate the protected browser to a URL. URL navigation is always allowed — it is not a sensitive action.",
            endpoint: "POST /api/agent/session/:sessionId/navigate",
            method: "POST",
            required_inputs: ["agent_pass_token", "url"],
            optional_inputs: [],
            example_request: {
              agent_pass_token: "pass_REPLACE_WITH_YOUR_TOKEN",
              url: "https://example-store.com/checkout",
            },
            possible_responses: [
              {
                decision: "allow",
                description: "Browser navigated to the URL. Always returns allow.",
              },
            ],
            safety_notes: [],
          },
          {
            name: "read_page",
            description:
              "Return the page title and a text preview of the current page. Useful for the agent to understand page content without screenshots.",
            endpoint: "POST /api/agent/session/:sessionId/read-page",
            method: "POST",
            required_inputs: ["agent_pass_token"],
            optional_inputs: [],
            example_request: {
              agent_pass_token: "pass_REPLACE_WITH_YOUR_TOKEN",
            },
            possible_responses: [
              {
                decision: "allow",
                description: "Returns title and text_preview of the current page.",
              },
            ],
            safety_notes: [],
          },
          {
            name: "click",
            description:
              "Click a browser element. Aegis inspects the element, detects if the action is sensitive, evaluates the collar, and either executes the click, pauses for approval, or blocks.",
            endpoint: "POST /api/agent/session/:sessionId/click",
            method: "POST",
            required_inputs: ["agent_pass_token", "target"],
            optional_inputs: [],
            example_request: {
              agent_pass_token: "pass_REPLACE_WITH_YOUR_TOKEN",
              target: { type: "text", value: "Place Order" },
            },
            possible_responses: [
              {
                decision: "allow",
                description: "Click was safe and executed.",
              },
              {
                decision: "approval_required",
                description:
                  "Sensitive action detected. Session paused. Returns approval_request_id. Agent must stop and wait.",
              },
              {
                decision: "block",
                description:
                  "Action blocked by collar policy. Agent must stop. Do not bypass.",
              },
            ],
            safety_notes: [
              "target.type is 'text' (match by visible text) or 'selector' (CSS selector).",
              "If approval_required is returned, do not retry the click. Wait for user approval.",
            ],
          },
          {
            name: "type",
            description:
              "Type a value into a browser input. Aegis inspects the field before allowing. Typed values are never stored in receipts.",
            endpoint: "POST /api/agent/session/:sessionId/type",
            method: "POST",
            required_inputs: ["agent_pass_token", "target", "value"],
            optional_inputs: [],
            example_request: {
              agent_pass_token: "pass_REPLACE_WITH_YOUR_TOKEN",
              target: { type: "selector", value: "#email" },
              value: "user@example.com",
            },
            possible_responses: [
              { decision: "allow", description: "Value typed into the field." },
              {
                decision: "approval_required",
                description: "Field detected as sensitive. Session paused.",
              },
              { decision: "block", description: "Field blocked by collar policy." },
            ],
            safety_notes: [
              "Never pass card numbers, CVV, passwords, or identity data as the value. Aegis Runner handles sensitive field fills from the vault.",
              "Typed values are not stored in receipts.",
            ],
          },
          {
            name: "screenshot",
            description:
              "Return a base64-encoded PNG of the current page. Useful for the agent to visually inspect the page state.",
            endpoint: "POST /api/agent/session/:sessionId/screenshot",
            method: "POST",
            required_inputs: ["agent_pass_token"],
            optional_inputs: [],
            example_request: {
              agent_pass_token: "pass_REPLACE_WITH_YOUR_TOKEN",
            },
            possible_responses: [
              {
                decision: "allow",
                description: "Returns screenshot_base64 (PNG, base64-encoded).",
              },
            ],
            safety_notes: [],
          },
          {
            name: "request_capability",
            description:
              "Explicitly ask Aegis whether a named action is permitted before attempting it. Use this to check collar policy without triggering a real browser action.",
            endpoint: "POST /api/agent/session/:sessionId/request-capability",
            method: "POST",
            required_inputs: ["agent_pass_token", "action_type"],
            optional_inputs: ["domain", "context"],
            example_request: {
              agent_pass_token: "pass_REPLACE_WITH_YOUR_TOKEN",
              action_type: "purchase",
              domain: "example-store.com",
              context: { summary: "Agent wants to place a $99 order" },
            },
            possible_responses: [
              {
                decision: "allow",
                description: "Action permitted. Returns receipt_id.",
              },
              {
                decision: "approval_required",
                description:
                  "Action requires user approval. Returns approval_request_id. Session is paused.",
              },
              {
                decision: "block",
                description:
                  "Action blocked by collar policy. Returns receipt_id.",
              },
            ],
            safety_notes: [
              "When approval_required is returned, the session enters waiting_for_approval and cannot accept further capability requests until the user approves or denies.",
              "After approval, Aegis Runner executes the sensitive step. The agent receives a receipt, not raw secrets.",
            ],
          },
          {
            name: "close_session",
            description:
              "Close the protected browser session and its Playwright context. Call this when the agent is done or on error.",
            endpoint: "POST /api/agent/session/:sessionId/close",
            method: "POST",
            required_inputs: ["agent_pass_token"],
            optional_inputs: [],
            example_request: {
              agent_pass_token: "pass_REPLACE_WITH_YOUR_TOKEN",
            },
            possible_responses: [
              {
                decision: "allow",
                description: "Session closed. Returns session_id and status: 'closed'.",
              },
            ],
            safety_notes: [],
          },
        ],
      },
    };
  });

  /**
   * POST /api/agent/create-session
   *
   * Outside agents use this to request a protected browser session under an Aegis Pass.
   * Launches an isolated Playwright/Chromium context immediately after creating the session record.
   */
  server.post<{ Body: CreateSessionBody }>("/api/agent/create-session", async (req, reply) => {
    const { agent_pass_token, purpose, requested_collar_id, mode = "headless" } = req.body ?? {};

    const validation = validatePassToken(agent_pass_token);
    if (!validation.ok) {
      return sendError(reply, 401, validation.code, validation.message);
    }

    const { pass, collar: defaultCollar } = validation;

    // If the agent requests a specific collar, use it — otherwise fall back to the pass default.
    let collar = defaultCollar;
    if (requested_collar_id && requested_collar_id !== pass.default_collar_id) {
      const { collars } = await import("../store/index.js");
      const requested = collars.get(requested_collar_id);
      if (!requested || requested.status !== "active" || requested.user_id !== pass.user_id) {
        return sendError(reply, 400, "FORBIDDEN", "Requested collar is not available for this pass.");
      }
      collar = requested;
    }

    // Session expiry: earlier of collar max duration or pass expiry
    const collarMaxMs = collar.session_limits.max_duration_minutes * 60 * 1000;
    const collarExpiry = new Date(Date.now() + collarMaxMs);
    const passExpiry = new Date(pass.expires_at);
    const expires_at = collarExpiry < passExpiry ? collarExpiry.toISOString() : passExpiry.toISOString();

    const now = new Date().toISOString();
    const session: ProtectedSession = {
      id: newId("sess"),
      user_id: pass.user_id,
      aegis_pass_id: pass.id,
      collar_id: collar.id,
      status: "active",
      mode,
      current_url: undefined,
      current_domain: undefined,
      created_at: now,
      expires_at,
    };

    sessions.set(session.id, session);
    schedulePersist();

    // Launch an isolated Playwright browser context for this session.
    try {
      await createBrowserSession(session.id, mode);
    } catch (err) {
      sessions.set(session.id, { ...session, status: "error" });
      schedulePersist();
      server.log.error(err, "Failed to launch browser session");
      return reply.status(500).send({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "Failed to launch protected browser session." },
      });
    }

    return {
      ok: true,
      data: {
        session_id: session.id,
        collar_id: collar.id,
        status: session.status,
        mode: session.mode,
        expires_at: session.expires_at,
        allowed_actions: collar.allowed_actions,
        approval_required_actions: collar.approval_required_actions,
        blocked_actions: collar.blocked_actions,
        spending_limits: collar.spending_limits,
      },
    };
  });

  /**
   * POST /api/agent/session/:sessionId/navigate
   *
   * Navigates the protected browser session to a URL.
   * Always returns decision "allow" for this milestone — sensitive action detection is Milestone 5.
   */
  server.post<{ Params: { sessionId: string }; Body: NavigateBody }>(
    "/api/agent/session/:sessionId/navigate",
    async (req, reply) => {
      const { sessionId } = req.params;
      const { agent_pass_token, url } = req.body ?? {};

      const guard = await guardBrowserSession(reply, agent_pass_token, sessionId);
      if (!guard) return;
      const { session } = guard;

      if (session.status !== "active") {
        return sendError(reply, 400, `SESSION_${session.status.toUpperCase()}`, `Session is ${session.status}.`);
      }

      if (!url || typeof url !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "url is required.");
      }

      const controller = getController(sessionId);
      if (!controller) {
        return reply.status(500).send({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "Browser context for this session is no longer available." },
        });
      }

      let domain: string;
      try {
        domain = new URL(url).hostname;
      } catch {
        return sendError(reply, 400, "VALIDATION_ERROR", "Invalid URL.");
      }

      try {
        const result = await controller.navigate(url);
        const updatedSession = { ...session, current_url: result.url, current_domain: domain };
        sessions.set(sessionId, updatedSession);
        schedulePersist();
        return {
          ok: true,
          data: { session_id: sessionId, current_url: result.url, decision: "allow" },
        };
      } catch (err) {
        server.log.error(err, "Navigation failed");
        return reply.status(500).send({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "Navigation failed." },
        });
      }
    }
  );

  /**
   * POST /api/agent/session/:sessionId/read-page
   *
   * Returns the title and a text preview of the current page.
   */
  server.post<{ Params: { sessionId: string }; Body: BrowserActionBody }>(
    "/api/agent/session/:sessionId/read-page",
    async (req, reply) => {
      const { sessionId } = req.params;
      const { agent_pass_token } = req.body ?? {};

      const guard = await guardBrowserSession(reply, agent_pass_token, sessionId);
      if (!guard) return;
      const { session } = guard;

      if (session.status !== "active") {
        return sendError(reply, 400, `SESSION_${session.status.toUpperCase()}`, `Session is ${session.status}.`);
      }

      const controller = getController(sessionId);
      if (!controller) {
        return reply.status(500).send({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "Browser context for this session is no longer available." },
        });
      }

      try {
        const result = await controller.readPage();
        return {
          ok: true,
          data: {
            session_id: sessionId,
            current_url: session.current_url,
            title: result.title,
            text_preview: result.text_preview,
          },
        };
      } catch (err) {
        server.log.error(err, "readPage failed");
        return reply.status(500).send({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "Failed to read page." },
        });
      }
    }
  );

  /**
   * POST /api/agent/session/:sessionId/screenshot
   *
   * Returns a base64-encoded PNG screenshot of the current page.
   */
  server.post<{ Params: { sessionId: string }; Body: BrowserActionBody }>(
    "/api/agent/session/:sessionId/screenshot",
    async (req, reply) => {
      const { sessionId } = req.params;
      const { agent_pass_token } = req.body ?? {};

      const guard = await guardBrowserSession(reply, agent_pass_token, sessionId);
      if (!guard) return;
      const { session } = guard;

      if (session.status !== "active") {
        return sendError(reply, 400, `SESSION_${session.status.toUpperCase()}`, `Session is ${session.status}.`);
      }

      const controller = getController(sessionId);
      if (!controller) {
        return reply.status(500).send({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "Browser context for this session is no longer available." },
        });
      }

      try {
        const screenshot_base64 = await controller.screenshot();
        return { ok: true, data: { session_id: sessionId, screenshot_base64 } };
      } catch (err) {
        server.log.error(err, "screenshot failed");
        return reply.status(500).send({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "Failed to take screenshot." },
        });
      }
    }
  );

  /**
   * POST /api/agent/session/:sessionId/close
   *
   * Closes the protected browser session and its Playwright context.
   * Accepts sessions in "active" or "waiting_for_approval" status.
   */
  server.post<{ Params: { sessionId: string }; Body: BrowserActionBody }>(
    "/api/agent/session/:sessionId/close",
    async (req, reply) => {
      const { sessionId } = req.params;
      const { agent_pass_token } = req.body ?? {};

      const guard = await guardBrowserSession(reply, agent_pass_token, sessionId);
      if (!guard) return;
      const { session } = guard;

      const closeable: string[] = ["active", "waiting_for_approval"];
      if (!closeable.includes(session.status)) {
        return sendError(reply, 400, `SESSION_${session.status.toUpperCase()}`, `Session is already ${session.status}.`);
      }

      await closeBrowserSession(sessionId);
      sessions.set(sessionId, { ...session, status: "closed" });
      schedulePersist();

      return { ok: true, data: { session_id: sessionId, status: "closed" } };
    }
  );

  /**
   * POST /api/agent/session/:sessionId/request-capability
   *
   * The agent requests permission to perform a sensitive action.
   * Aegis evaluates it against the active collar and responds with:
   *   - allow     → receipt created, proceed
   *   - approval_required → approval_request created, session paused
   *   - block     → receipt created, action denied
   */
  server.post<{ Params: { sessionId: string }; Body: RequestCapabilityBody }>(
    "/api/agent/session/:sessionId/request-capability",
    async (req, reply) => {
      const { sessionId } = req.params;
      const { agent_pass_token, action_type, domain, context } = req.body ?? {};

      // Validate pass
      const validation = validatePassToken(agent_pass_token);
      if (!validation.ok) {
        return sendError(reply, 401, validation.code, validation.message);
      }

      const { pass, collar } = validation;

      // Validate action_type is a known string
      if (!action_type || typeof action_type !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "action_type is required.");
      }

      // Resolve session
      const session = sessions.get(sessionId);
      if (!session) {
        return sendError(reply, 404, "NOT_FOUND", "Session not found.");
      }

      // Session must belong to the same pass
      if (session.aegis_pass_id !== pass.id) {
        return sendError(reply, 403, "FORBIDDEN", "This session does not belong to the provided pass.");
      }

      // Session must be active (waiting_for_approval sessions are locked)
      if (session.status === "waiting_for_approval") {
        return sendError(reply, 400, "SESSION_PAUSED", "Session is waiting for an approval before accepting new capability requests.");
      }
      if (session.status !== "active") {
        return sendError(reply, 400, `SESSION_${session.status.toUpperCase()}`, `Session is ${session.status}.`);
      }

      // Look up domain trust
      const counterparty_trust_status = lookupTrustStatus(domain);

      // Evaluate the action
      const result = evaluateAction({
        collar,
        session,
        action_type: action_type as any,
        domain,
        context,
        counterparty_trust_status,
      });

      const now = new Date().toISOString();

      if (result.decision === "allow") {
        const receipt: Receipt = {
          id: newId("rec"),
          user_id: pass.user_id,
          session_id: sessionId,
          collar_id: collar.id,
          action_type: action_type as any,
          decision: "allowed",
          domain,
          counterparty_trust_status,
          reason: result.reason,
          outcome: "completed",
          sensitive_data_shared_with_agent: false,
          created_at: now,
        };
        receipts.set(receipt.id, receipt);
        schedulePersist();

        return {
          ok: true,
          data: {
            decision: "allow",
            reason: result.reason,
            risk_level: result.risk_level,
            receipt_id: receipt.id,
          },
        };
      }

      if (result.decision === "block") {
        const receipt: Receipt = {
          id: newId("rec"),
          user_id: pass.user_id,
          session_id: sessionId,
          collar_id: collar.id,
          action_type: action_type as any,
          decision: "blocked",
          domain,
          counterparty_trust_status,
          reason: result.reason,
          outcome: "blocked",
          sensitive_data_shared_with_agent: false,
          created_at: now,
        };
        receipts.set(receipt.id, receipt);

        // Reputation event for blocked action
        reputationEvents.set(newId("rep"), {
          id: newId("rep"),
          entity_type: "user_aegis_id",
          entity_id: "aid_user_001",
          event_type: "sensitive_action_blocked",
          severity: "warning",
          session_id: sessionId,
          receipt_id: receipt.id,
          domain,
          weight: -1,
          created_at: now,
        });
        schedulePersist();

        return {
          ok: true,
          data: {
            decision: "block",
            reason: result.reason,
            risk_level: result.risk_level,
            receipt_id: receipt.id,
          },
        };
      }

      // approval_required: create approval request and pause the session
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min TTL
      const approval: ApprovalRequest = {
        id: newId("appr"),
        user_id: pass.user_id,
        session_id: sessionId,
        collar_id: collar.id,
        action_type: action_type as any,
        risk_level: result.risk_level,
        domain,
        summary: context?.summary as string | undefined ??
          `Agent requests to perform: ${action_type}${domain ? ` on ${domain}` : ""}`,
        reason: result.reason,
        context: context ?? {},
        status: "pending",
        created_at: now,
        expires_at: expiresAt,
      };

      approvals.set(approval.id, approval);

      // Pause the session until the approval is resolved
      sessions.set(sessionId, { ...session, status: "waiting_for_approval" });
      schedulePersist();

      return {
        ok: true,
        data: {
          decision: "approval_required",
          reason: result.reason,
          risk_level: result.risk_level,
          approval_request_id: approval.id,
        },
      };
    }
  );

  // ─── Shared enforcement logic for click / type ─────────────────────────────

  async function enforceAndExecute(
    reply: any,
    sessionId: string,
    token: string | undefined,
    action: "click" | "type",
    target: ElementTarget,
    typeValue?: string
  ) {
    const guard = await guardBrowserSession(reply, token, sessionId);
    if (!guard) return;
    const { pass, session } = guard;

    if (session.status === "waiting_for_approval") {
      return sendError(reply, 400, "SESSION_PAUSED", "Session is paused waiting for approval.");
    }
    if (session.status !== "active") {
      return sendError(
        reply,
        400,
        `SESSION_${session.status.toUpperCase()}`,
        `Session is ${session.status}.`
      );
    }

    const controller = getController(sessionId);
    if (!controller) {
      return reply.status(500).send({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "Browser context no longer available." },
      });
    }

    // Inspect element before deciding
    const elementInfo = await controller.getElementInfo(target, action === "click");
    if (!elementInfo.found) {
      return sendError(reply, 400, "ELEMENT_NOT_FOUND", `Element not found: ${JSON.stringify(target)}`);
    }

    // Detect sensitive action from available signals
    const detection = detect({
      action,
      url: session.current_url,
      targetText: elementInfo.text,
      elementInfo,
    });

    // Non-sensitive: execute immediately, no receipt
    if (!detection.sensitive) {
      try {
        if (action === "click") {
          await controller.click(target);
        } else {
          await controller.type(target, typeValue!);
        }
      } catch (err) {
        server.log.error(err, `${action} failed`);
        return reply.status(500).send({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: `${action} failed.` },
        });
      }
      return {
        ok: true,
        data: { decision: "allow", executed: true, sensitive: false },
      };
    }

    // Sensitive: run through collar policy
    const collar = collars.get(session.collar_id);
    if (!collar) {
      return reply.status(500).send({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "Collar for this session could not be resolved." },
      });
    }

    const counterparty_trust_status = lookupTrustStatus(session.current_domain);
    const result = evaluateAction({
      collar,
      session,
      action_type: detection.action_type,
      domain: session.current_domain,
      counterparty_trust_status,
    });

    const now = new Date().toISOString();
    const domain = session.current_domain;

    if (result.decision === "allow") {
      try {
        if (action === "click") {
          await controller.click(target);
        } else {
          await controller.type(target, typeValue!);
        }
      } catch (err) {
        server.log.error(err, `${action} failed after allow decision`);
        return reply.status(500).send({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: `${action} failed.` },
        });
      }

      const receipt: Receipt = {
        id: newId("rec"),
        user_id: pass.user_id,
        session_id: sessionId,
        collar_id: collar.id,
        action_type: detection.action_type,
        decision: "allowed",
        domain,
        counterparty_trust_status,
        reason: result.reason,
        outcome: "completed",
        sensitive_data_shared_with_agent: false,
        created_at: now,
      };
      receipts.set(receipt.id, receipt);
      schedulePersist();

      return {
        ok: true,
        data: {
          decision: "allow",
          executed: true,
          sensitive: true,
          detected_action_type: detection.action_type,
          risk_level: result.risk_level,
          reason: result.reason,
          receipt_id: receipt.id,
        },
      };
    }

    if (result.decision === "block") {
      const receipt: Receipt = {
        id: newId("rec"),
        user_id: pass.user_id,
        session_id: sessionId,
        collar_id: collar.id,
        action_type: detection.action_type,
        decision: "blocked",
        domain,
        counterparty_trust_status,
        reason: result.reason,
        outcome: "blocked",
        sensitive_data_shared_with_agent: false,
        created_at: now,
      };
      receipts.set(receipt.id, receipt);
      schedulePersist();

      return {
        ok: true,
        data: {
          decision: "block",
          executed: false,
          sensitive: true,
          detected_action_type: detection.action_type,
          risk_level: result.risk_level,
          reason: result.reason,
          receipt_id: receipt.id,
        },
      };
    }

    // approval_required
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const approval: ApprovalRequest = {
      id: newId("appr"),
      user_id: pass.user_id,
      session_id: sessionId,
      collar_id: collar.id,
      action_type: detection.action_type,
      risk_level: result.risk_level,
      domain,
      summary: `Agent wants to ${action} "${elementInfo.text || target.value}" (detected: ${detection.action_type})`,
      reason: result.reason,
      context: {
        target,
        detected_action_type: detection.action_type,
        detected_risk_level: detection.risk_level,
        signals: detection.signals,
      },
      status: "pending",
      created_at: now,
      expires_at: expiresAt,
    };

    approvals.set(approval.id, approval);
    sessions.set(sessionId, { ...session, status: "waiting_for_approval" });
    schedulePersist();

    return {
      ok: true,
      data: {
        decision: "approval_required",
        executed: false,
        sensitive: true,
        detected_action_type: detection.action_type,
        risk_level: result.risk_level,
        reason: result.reason,
        approval_request_id: approval.id,
      },
    };
  }

  /**
   * POST /api/agent/session/:sessionId/click
   *
   * Detects the action from the target element, evaluates it against the collar,
   * and either executes the click, creates an approval, or blocks.
   */
  server.post<{ Params: { sessionId: string }; Body: ClickBody }>(
    "/api/agent/session/:sessionId/click",
    async (req, reply) => {
      const { sessionId } = req.params;
      const { agent_pass_token, target } = req.body ?? {};

      if (!target?.type || !target?.value) {
        return sendError(reply, 400, "VALIDATION_ERROR", "target.type and target.value are required.");
      }

      return enforceAndExecute(reply, sessionId, agent_pass_token, "click", target);
    }
  );

  /**
   * POST /api/agent/session/:sessionId/type
   *
   * Detects the action from the target element metadata, evaluates it against the collar,
   * and either fills the input, creates an approval, or blocks.
   * The typed value is not stored in receipts.
   */
  server.post<{ Params: { sessionId: string }; Body: TypeBody }>(
    "/api/agent/session/:sessionId/type",
    async (req, reply) => {
      const { sessionId } = req.params;
      const { agent_pass_token, target, value } = req.body ?? {};

      if (!target?.type || !target?.value) {
        return sendError(reply, 400, "VALIDATION_ERROR", "target.type and target.value are required.");
      }
      if (typeof value !== "string") {
        return sendError(reply, 400, "VALIDATION_ERROR", "value is required.");
      }

      return enforceAndExecute(reply, sessionId, agent_pass_token, "type", target, value);
    }
  );
}
