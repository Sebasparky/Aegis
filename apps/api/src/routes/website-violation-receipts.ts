import type { FastifyInstance } from "fastify";
import type {
  WebsiteViolationReceipt,
  WebsiteViolationType,
  WebsiteViolationDecision,
  WebsiteViolationDetectionSource,
} from "@aegis/types";
import { websiteTrustProfiles, websiteViolationReceipts, newId } from "../store/index.js";
import {
  buildSignedWebsiteViolationReceipt,
  verifyStoredWebsiteViolationReceipt,
} from "../lib/websiteViolationReceiptSigning.js";
import { schedulePersist } from "../store/persistence.js";

function normalizeDomain(raw: string): string {
  let d = raw.replace(/^https?:\/\//i, "");
  d = d.split("/")[0];
  d = d.split(":")[0];
  return d.toLowerCase().trim();
}

function stripQueryString(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    // Not a full URL — return as-is (may be an origin or partial path)
    return url.split("?")[0];
  }
}

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function websiteViolationReceiptRoutes(app: FastifyInstance) {
  /**
   * POST /api/website-violation-receipts
   * Create a signed violation receipt for a committed safety promise on an active profile.
   * Demo/manual creation path in v1 — real detection hooks are out of scope.
   */
  app.post("/api/website-violation-receipts", async (req, reply) => {
    const body = req.body as {
      website_profile_id?: string;
      domain?: string;
      violation_type: WebsiteViolationType;
      violated_promise_id: string;
      observed_at?: string;
      redacted_evidence_summary: string;
      detection_source: WebsiteViolationDetectionSource;
      decision: WebsiteViolationDecision;
      followup_required?: boolean;
      target_url_or_origin?: string;
      session_id?: string;
      route_run_id?: string;
      workspace_id?: string;
      task_id?: string;
      delegation_id?: string;
      agent_name?: string;
      agent_platform?: string;
      evidence_hash?: string;
      detection_signals_count?: number;
      blocked_action_type?: string;
      reputation_delta?: number;
    };

    if (!body.violation_type) {
      return sendError(reply, 400, "MISSING_VIOLATION_TYPE", "violation_type is required.");
    }
    if (!body.violated_promise_id) {
      return sendError(reply, 400, "MISSING_PROMISE_ID", "violated_promise_id is required.");
    }
    if (!body.redacted_evidence_summary) {
      return sendError(reply, 400, "MISSING_EVIDENCE_SUMMARY", "redacted_evidence_summary is required.");
    }
    if (!body.detection_source) {
      return sendError(reply, 400, "MISSING_DETECTION_SOURCE", "detection_source is required.");
    }
    if (!body.decision) {
      return sendError(reply, 400, "MISSING_DECISION", "decision is required.");
    }

    // Resolve profile
    let profile = body.website_profile_id
      ? websiteTrustProfiles.get(body.website_profile_id)
      : undefined;

    if (!profile && body.domain) {
      const domain = normalizeDomain(body.domain);
      profile = Array.from(websiteTrustProfiles.values()).find(
        (p) => p.domain === domain && p.status === "active"
      );
    }

    if (!profile) {
      return sendError(
        reply,
        404,
        "WEBSITE_PROFILE_NOT_FOUND",
        body.website_profile_id
          ? `No WebsiteTrustProfile found for profile_id '${body.website_profile_id}'.`
          : `No active WebsiteTrustProfile found for domain '${body.domain}'.`
      );
    }

    if (profile.status !== "active") {
      return sendError(
        reply,
        422,
        "PROFILE_NOT_ACTIVE",
        `WebsiteTrustProfile '${profile.profile_id}' has status '${profile.status}'. Only active profiles can have violation receipts created against them.`
      );
    }

    // Validate the violated promise
    const promise = profile.safety_promises.find(
      (p) => p.promise_id === body.violated_promise_id
    );

    if (!promise) {
      return sendError(
        reply,
        404,
        "PROMISE_NOT_FOUND",
        `No safety promise with id '${body.violated_promise_id}' found on profile '${profile.profile_id}'.`
      );
    }

    if (!promise.committed) {
      return sendError(
        reply,
        422,
        "PROMISE_NOT_COMMITTED",
        `Promise '${body.violated_promise_id}' exists on profile '${profile.profile_id}' but is not committed (committed: false). Only committed promises can be violated.`
      );
    }

    const now = new Date().toISOString();
    const issuer = process.env.AEGIS_RECEIPT_ISSUER ?? "aegis";

    const fields: Omit<WebsiteViolationReceipt, "verification"> = {
      receipt_id: newId("wvr"),
      receipt_type: "website_violation",
      schema_version: "1.0",
      issuer: issuer as "aegis",
      created_at: now,

      // Snapshot from profile at time of violation
      website_profile_id: profile.profile_id,
      website_aegis_id: profile.website_aegis_id,
      domain: profile.domain,
      company_name: profile.company_name,
      verification_status_at_violation: profile.verification_status,
      profile_hash: profile.profile_hash,
      profile_version: profile.profile_version,

      // Violated promise
      violation_type: body.violation_type,
      violated_promise_id: promise.promise_id,
      violated_promise_title: promise.title,
      severity: promise.severity_if_violated,

      // Observed behavior
      observed_at: body.observed_at ?? now,
      ...(body.target_url_or_origin !== undefined
        ? { target_url_or_origin: stripQueryString(body.target_url_or_origin) }
        : {}),
      ...(body.session_id !== undefined ? { session_id: body.session_id } : {}),
      ...(body.route_run_id !== undefined ? { route_run_id: body.route_run_id } : {}),
      ...(body.workspace_id !== undefined ? { workspace_id: body.workspace_id } : {}),
      ...(body.task_id !== undefined ? { task_id: body.task_id } : {}),
      ...(body.delegation_id !== undefined ? { delegation_id: body.delegation_id } : {}),
      ...(body.agent_name !== undefined ? { agent_name: body.agent_name } : {}),
      ...(body.agent_platform !== undefined ? { agent_platform: body.agent_platform } : {}),
      redacted_evidence_summary: body.redacted_evidence_summary,
      ...(body.evidence_hash !== undefined ? { evidence_hash: body.evidence_hash } : {}),
      detection_source: body.detection_source,
      ...(body.detection_signals_count !== undefined
        ? { detection_signals_count: body.detection_signals_count }
        : {}),

      // Antigen response
      decision: body.decision,
      ...(body.blocked_action_type !== undefined
        ? { blocked_action_type: body.blocked_action_type }
        : {}),
      ...(body.reputation_delta !== undefined ? { reputation_delta: body.reputation_delta } : {}),
      followup_required: body.followup_required ?? false,

      // Privacy literals — never set through a variable
      raw_secrets_in_receipt: false,
      raw_credentials_in_receipt: false,
      raw_page_content_in_receipt: false,
    };

    const receipt = await buildSignedWebsiteViolationReceipt(fields);
    websiteViolationReceipts.set(receipt.receipt_id, receipt);
    schedulePersist();

    return reply.status(201).send({ ok: true, data: receipt });
  });

  /**
   * GET /api/website-violation-receipts
   * List violation receipts with optional filters.
   */
  app.get("/api/website-violation-receipts", async (req, reply) => {
    const query = req.query as {
      domain?: string;
      violation_type?: string;
      severity?: string;
      decision?: string;
    };

    let all = Array.from(websiteViolationReceipts.values());

    if (query.domain) {
      const d = normalizeDomain(query.domain);
      all = all.filter((r) => r.domain === d);
    }
    if (query.violation_type) {
      all = all.filter((r) => r.violation_type === query.violation_type);
    }
    if (query.severity) {
      all = all.filter((r) => r.severity === query.severity);
    }
    if (query.decision) {
      all = all.filter((r) => r.decision === query.decision);
    }

    all.sort((a, b) => b.created_at.localeCompare(a.created_at));

    return reply.send({ ok: true, data: all, count: all.length });
  });

  /**
   * GET /api/website-violation-receipts/:receiptId/verify
   * Cryptographically verify receipt integrity (hash + JWS).
   * Must be registered before /:receiptId to prevent Fastify matching "verify" as a receipt_id.
   */
  app.get<{ Params: { receiptId: string } }>(
    "/api/website-violation-receipts/:receiptId/verify",
    async (req, reply) => {
      const receipt = websiteViolationReceipts.get(req.params.receiptId);
      if (!receipt) {
        return reply.status(404).send({
          ok: false,
          error: { code: "RECEIPT_NOT_FOUND", message: "Violation receipt not found." },
        });
      }
      const result = await verifyStoredWebsiteViolationReceipt(receipt);
      return reply.send({ ok: true, data: result });
    }
  );

  /**
   * GET /api/website-violation-receipts/:receiptId
   * Get a violation receipt by ID.
   */
  app.get<{ Params: { receiptId: string } }>(
    "/api/website-violation-receipts/:receiptId",
    async (req, reply) => {
      const receipt = websiteViolationReceipts.get(req.params.receiptId);
      if (!receipt) {
        return reply.status(404).send({
          ok: false,
          error: { code: "RECEIPT_NOT_FOUND", message: "Violation receipt not found." },
        });
      }
      return reply.send({ ok: true, data: receipt });
    }
  );
}
