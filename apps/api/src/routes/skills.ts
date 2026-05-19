import type { FastifyInstance } from "fastify";
import type { AgentDelegation, InstalledSkill } from "@aegis/types";
import { skills, installedSkills, passes, agentDelegations, MOCK_USER_ID, newId } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";

function sendError(reply: any, status: number, code: string, message: string) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

export async function skillRoutes(server: FastifyInstance) {
  /**
   * GET /api/skills
   *
   * List approved marketplace skills.
   * ?domain= filters by exact domain match.
   * ?installed=true filters to the demo user's installed skills only.
   * Each result includes an `installed` boolean for UI convenience.
   */
  server.get<{ Querystring: { domain?: string; installed?: string } }>(
    "/api/skills",
    async (req, reply) => {
      const { domain, installed } = req.query;

      // Resolve optional bearer token for agent-scoped skill discovery.
      // No token → existing web UI behavior, no auth required.
      // Auth path: Bearer token is pass.token → find pass → find delegation via pass.id.
      const rawAuth = (req.headers["authorization"] as string | undefined) ?? "";
      const bearerMatch = rawAuth.match(/^Bearer (.+)$/i);
      const token = bearerMatch?.[1]?.trim();

      let delegation: AgentDelegation | undefined;
      if (token) {
        const pass = Array.from(passes.values()).find(
          (p) => p.user_id === MOCK_USER_ID && p.token === token
        );
        if (!pass) {
          return reply.status(401).send({
            ok: false, error: { code: "INVALID_TOKEN", message: "Token does not match any delegation." },
          });
        }
        if (pass.status === "revoked") {
          return reply.status(401).send({
            ok: false, error: { code: "DELEGATION_REVOKED", message: "This delegation has been revoked." },
          });
        }
        if (pass.status === "expired" || new Date(pass.expires_at) < new Date()) {
          return reply.status(401).send({
            ok: false, error: { code: "DELEGATION_EXPIRED", message: "This delegation has expired. Request a new delegation." },
          });
        }
        const found = Array.from(agentDelegations.values()).find(
          (d) => d.user_id === MOCK_USER_ID && d.token_id === pass.id
        );
        if (!found) {
          return reply.status(401).send({
            ok: false, error: { code: "INVALID_TOKEN", message: "Token does not match any delegation." },
          });
        }
        if (found.status === "revoked") {
          return reply.status(401).send({
            ok: false, error: { code: "DELEGATION_REVOKED", message: "This delegation has been revoked." },
          });
        }
        if (found.status === "expired" || (found.expires_at && new Date(found.expires_at) < new Date())) {
          found.status = "expired";
          found.updated_at = new Date().toISOString();
          agentDelegations.set(found.id, found);
          schedulePersist();
          return reply.status(401).send({
            ok: false, error: { code: "DELEGATION_EXPIRED", message: "This delegation has expired. Request a new delegation." },
          });
        }
        delegation = found;
      }

      let list = Array.from(skills.values());

      if (domain) list = list.filter((s) => s.domain === domain);

      const installedSkillIds = new Set(
        Array.from(installedSkills.values())
          .filter((i) => i.user_id === MOCK_USER_ID && i.enabled)
          .map((i) => i.skill_id)
      );

      if (installed === "true") {
        list = list.filter((s) => installedSkillIds.has(s.skill_id));
      }

      // Apply delegation skill-access policy when a valid token is present.
      // Only applies to installed-skill queries — marketplace browsing is unscoped.
      if (delegation && installed === "true") {
        const mode = delegation.skill_access_mode ?? "all";
        const ids = delegation.skill_access_skill_ids ?? [];
        list = list.filter((s) => {
          if (mode === "exclude") return !ids.includes(s.skill_id);
          if (mode === "only") return ids.includes(s.skill_id);
          return true; // "all" — no restriction
        });
      }

      const result = list
        .sort((a, b) => b.published_at.localeCompare(a.published_at))
        .map((s) => ({ ...s, installed: installedSkillIds.has(s.skill_id) }));

      return { ok: true, data: result };
    }
  );

  /**
   * POST /api/skills/:skillId/install
   *
   * Install a marketplace skill for the demo user. Idempotent — re-enables
   * if the skill was previously uninstalled.
   */
  server.post<{ Params: { skillId: string } }>(
    "/api/skills/:skillId/install",
    async (req, reply) => {
      const skill = skills.get(req.params.skillId);
      if (!skill) return sendError(reply, 404, "NOT_FOUND", "Skill not found.");

      const existing = Array.from(installedSkills.values()).find(
        (i) => i.skill_id === skill.skill_id && i.user_id === MOCK_USER_ID
      );

      if (existing) {
        existing.enabled = true;
        installedSkills.set(existing.installed_skill_id, existing);
        schedulePersist();
        return { ok: true, data: existing };
      }

      const record: InstalledSkill = {
        installed_skill_id: newId("inskill"),
        skill_id: skill.skill_id,
        user_id: MOCK_USER_ID,
        installed_at: new Date().toISOString(),
        enabled: true,
      };
      installedSkills.set(record.installed_skill_id, record);
      schedulePersist();
      return { ok: true, data: record };
    }
  );

  /**
   * DELETE /api/skills/:skillId/install
   *
   * Soft-uninstall: sets enabled = false. Install history is preserved.
   */
  server.delete<{ Params: { skillId: string } }>(
    "/api/skills/:skillId/install",
    async (req, reply) => {
      const existing = Array.from(installedSkills.values()).find(
        (i) => i.skill_id === req.params.skillId && i.user_id === MOCK_USER_ID
      );
      if (!existing) return sendError(reply, 404, "NOT_FOUND", "Skill not installed.");

      existing.enabled = false;
      installedSkills.set(existing.installed_skill_id, existing);
      schedulePersist();
      return { ok: true, data: { uninstalled: true } };
    }
  );

  /**
   * GET /api/installed-skills
   *
   * List all enabled installed skills for the demo user, each joined with
   * its full Skill record.
   */
  server.get("/api/installed-skills", async () => {
    const userInstalled = Array.from(installedSkills.values()).filter(
      (i) => i.user_id === MOCK_USER_ID && i.enabled
    );
    const result = userInstalled
      .map((i) => {
        const skill = skills.get(i.skill_id);
        return skill ? { ...i, skill } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b!.installed_at.localeCompare(a!.installed_at));
    return { ok: true, data: result };
  });
}
