import type { FastifyInstance } from "fastify";
import type { ProfileMemoryRequest, ProfileFieldKind } from "@aegis/types";
import { profileMemoryRequests, privateProfileMemory, encryptedSecretVault, MOCK_USER_ID, newId } from "../store/index.js";
import { getKmsProvider } from "../lib/kms.js";
import { schedulePersist } from "../store/persistence.js";

const VALID_PROFILE_FIELD_KINDS = new Set<ProfileFieldKind>([
  "first_name", "last_name", "email", "phone",
  "shipping_address_line1", "shipping_address_line2",
  "city", "region", "postal_code", "country",
]);

function safeView(r: ProfileMemoryRequest) {
  return {
    request_id: r.request_id,
    domain: r.domain,
    page_url: r.page_url,
    missing_fields: r.missing_fields,
    reason: r.reason,
    status: r.status,
    raw_profile_value_revealed_to_agent: false as const,
    created_at: r.created_at,
    expires_at: r.expires_at,
    completed_at: r.completed_at,
  };
}

export async function profileMemoryRequestRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/internal/profile-memory-requests — list, optionally filtered by status
  server.get("/api/internal/profile-memory-requests", async (req, reply) => {
    const { status } = req.query as { status?: string };
    const now = new Date();

    // Lazy expiry: mark pending_user requests past their expiry time
    for (const r of profileMemoryRequests.values()) {
      if (r.user_id === MOCK_USER_ID && r.status === "pending_user" && new Date(r.expires_at) <= now) {
        r.status = "expired";
        profileMemoryRequests.set(r.request_id, r);
      }
    }

    let items = Array.from(profileMemoryRequests.values())
      .filter(r => r.user_id === MOCK_USER_ID);
    if (status) items = items.filter(r => r.status === status);

    return reply.send({ ok: true, data: items.map(safeView) });
  });

  // POST /api/internal/profile-memory-requests/:id/submit
  server.post("/api/internal/profile-memory-requests/:id/submit", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      values?: Record<string, string>;
      save_for_future?: boolean;
    };

    const r = profileMemoryRequests.get(id);
    if (!r || r.user_id !== MOCK_USER_ID) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Profile memory request not found." } });
    }
    if (r.status !== "pending_user") {
      return reply.status(409).send({ ok: false, error: { code: "REQUEST_NOT_PENDING", message: `Request status is '${r.status}'; cannot submit.` } });
    }
    if (new Date(r.expires_at) <= new Date()) {
      r.status = "expired";
      profileMemoryRequests.set(id, r);
      schedulePersist();
      return reply.status(410).send({ ok: false, error: { code: "REQUEST_EXPIRED", message: "Profile memory request has expired." } });
    }
    if (!body.values || typeof body.values !== "object") {
      return reply.status(422).send({ ok: false, error: { code: "MISSING_VALUES", message: "Request body must include a 'values' object." } });
    }

    // Validate all missing fields are present in submitted values
    const missingInBody: string[] = r.missing_fields.filter(f => {
      const v = body.values![f];
      return typeof v !== "string" || v.trim() === "";
    });
    if (missingInBody.length > 0) {
      return reply.status(422).send({
        ok: false,
        error: { code: "INCOMPLETE_VALUES", message: `Missing required fields: ${missingInBody.join(", ")}.` },
      });
    }

    const kms = getKmsProvider();
    const NOW = new Date().toISOString();
    const fieldsStored: ProfileFieldKind[] = [];

    for (const [fieldKey, rawValue] of Object.entries(body.values)) {
      if (!VALID_PROFILE_FIELD_KINDS.has(fieldKey as ProfileFieldKind)) continue;
      const kind = fieldKey as ProfileFieldKind;
      const trimmed = rawValue.trim();
      if (!trimmed) continue;

      // Find existing item for this field kind or create a new one
      const existing = Array.from(privateProfileMemory.values()).find(
        m => m.field_kind === kind && m.user_id === MOCK_USER_ID,
      );

      const memory_id = existing ? existing.memory_id : newId("ppm");

      try {
        const blob = await kms.encryptSecret(trimmed, {
          user_id: MOCK_USER_ID,
          pass_id: memory_id,
          domain: r.domain,
          purpose: "profile_field",
        });
        encryptedSecretVault.set(memory_id, blob);

        if (existing) {
          existing.updated_at = NOW;
          existing.provenance = { source: "user_provided", domain_at_creation: r.domain };
          privateProfileMemory.set(memory_id, existing);
        } else {
          privateProfileMemory.set(memory_id, {
            memory_id,
            user_id: MOCK_USER_ID,
            field_kind: kind,
            value_ref: `ppvault://${memory_id}/value`,
            data_class: 2,
            sensitivity: "private",
            default_disclosure_mode: "fill_only",
            agent_visible_allowed: false,
            provenance: { source: "user_provided", domain_at_creation: r.domain },
            created_at: NOW,
            updated_at: NOW,
            user_editable: true,
            uses: [],
          });
        }

        fieldsStored.push(kind);
      } catch (err) {
        console.error(`[profile-memory-requests] KMS encrypt failed for field ${kind}:`, err);
        return reply.status(500).send({ ok: false, error: { code: "KMS_ENCRYPT_FAILED", message: "Failed to securely store profile value." } });
      }
    }

    r.status = "completed";
    r.completed_at = NOW;
    profileMemoryRequests.set(id, r);
    schedulePersist();

    return reply.send({
      ok: true,
      request_id: id,
      status: "completed",
      fields_stored: fieldsStored,
      raw_profile_value_revealed_to_agent: false as const,
    });
  });

  // POST /api/internal/profile-memory-requests/:id/cancel
  server.post("/api/internal/profile-memory-requests/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };

    const r = profileMemoryRequests.get(id);
    if (!r || r.user_id !== MOCK_USER_ID) {
      return reply.status(404).send({ ok: false, error: { code: "NOT_FOUND", message: "Profile memory request not found." } });
    }
    if (r.status !== "pending_user") {
      return reply.status(409).send({ ok: false, error: { code: "REQUEST_NOT_PENDING", message: `Request status is '${r.status}'; cannot cancel.` } });
    }

    r.status = "cancelled";
    profileMemoryRequests.set(id, r);
    schedulePersist();

    return reply.send({ ok: true, request_id: id, status: "cancelled" });
  });
}
