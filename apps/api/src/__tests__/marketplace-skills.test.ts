import { vi } from "vitest";

vi.mock("../store/persistence.js", () => ({
  schedulePersist: vi.fn(),
  persistStore: vi.fn(),
  loadStore: vi.fn(),
  seedDefaultData: vi.fn(),
  resetStoreForDemo: vi.fn(),
}));

vi.mock("../runtime/taskBrowserSessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/taskBrowserSessions.js")>();
  return { ...actual, createTaskBrowserSession: vi.fn(), getTaskBrowserSessionForReuse: vi.fn() };
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { seedTestData, resetStore, IDS } from "./helpers.js";
import { routeRoutes } from "../routes/routes.js";
import { skillRoutes } from "../routes/skills.js";
import { routes, skills, publishedSkillVersions, installedSkills, MOCK_USER_ID, newId } from "../store/index.js";
import type { AegisRoute, Skill } from "@aegis/types";

const NOW = "2026-05-25T00:00:00.000Z";

function makeApprovedRoute(overrides: Partial<AegisRoute> = {}): AegisRoute {
  return {
    route_id: newId("route"),
    version: "1.0.0",
    created_at: NOW,
    last_verified_at: NOW,
    creator_aegis_id: "aid_user_001",
    trust_tier: "aegis_scanned",
    domain: "demo.test.local",
    workflow_name: "Test Workflow",
    workflow_description: "A test workflow.",
    risk_level: "low",
    required_permissions: ["browse"],
    allowed_actions: ["browse"],
    forbidden_actions: [],
    approval_gates: [],
    confidence_threshold: 0.7,
    steps: [],
    run_count: 0,
    success_rate: 0,
    incident_count: 0,
    marketplace_status: "pending_review",
    ...overrides,
  };
}

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  await server.register(routeRoutes);
  await server.register(skillRoutes);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  resetStore();
  seedTestData();
});

// ─── Publish flow ─────────────────────────────────────────────────────────────

describe("POST /api/routes/:routeId/review — publish creates snapshot", () => {
  it("creates a PublishedSkillVersion when route is approved", async () => {
    const route = makeApprovedRoute();
    routes.set(route.route_id, route);

    const res = await server.inject({
      method: "POST",
      url: `/api/routes/${route.route_id}/review`,
      payload: { decision: "approved" },
    });
    expect(res.statusCode).toBe(200);

    const newSkill = Array.from(skills.values()).find(
      (s) => s.route_id === route.route_id
    );
    expect(newSkill).toBeDefined();
    expect(newSkill!.listing_status).toBe("active");

    const snapshot = Array.from(publishedSkillVersions.values()).find(
      (v) => v.skill_id === newSkill!.skill_id
    );
    expect(snapshot).toBeDefined();
    expect(snapshot!.route_id).toBe(route.route_id);
    expect(snapshot!.workflow_name).toBe(route.workflow_name);
    expect(snapshot!.domain).toBe(route.domain);
    expect(Array.isArray(snapshot!.steps)).toBe(true);
  });

  it("copies preview_assets and replay_assets into snapshot", async () => {
    const route = makeApprovedRoute({
      preview_assets: [{ asset_id: "asset_test_1", kind: "start_page", route_id: "route_tmp", url_path: "/", captured_at: NOW, redaction_applied: false, source: "dev_seed" }],
    });
    routes.set(route.route_id, route);

    await server.inject({
      method: "POST",
      url: `/api/routes/${route.route_id}/review`,
      payload: { decision: "approved" },
    });

    const newSkill = Array.from(skills.values()).find(s => s.route_id === route.route_id)!;
    const snapshot = Array.from(publishedSkillVersions.values()).find(
      v => v.skill_id === newSkill.skill_id
    );
    expect(snapshot!.preview_assets).toHaveLength(1);
    expect(snapshot!.preview_assets![0].kind).toBe("start_page");
  });

  it("does not create a snapshot on rejection", async () => {
    const route = makeApprovedRoute();
    routes.set(route.route_id, route);

    await server.inject({
      method: "POST",
      url: `/api/routes/${route.route_id}/review`,
      payload: { decision: "rejected" },
    });

    const newSkill = Array.from(skills.values()).find(s => s.route_id === route.route_id);
    expect(newSkill).toBeUndefined();
    const anySnapshot = Array.from(publishedSkillVersions.values()).find(
      v => v.route_id === route.route_id
    );
    expect(anySnapshot).toBeUndefined();
  });
});

// ─── GET /api/skills/:skillId ─────────────────────────────────────────────────

describe("GET /api/skills/:skillId", () => {
  it("returns 200 with skill and snapshot for a known skill", async () => {
    // Seed a skill and snapshot
    const route = makeApprovedRoute();
    routes.set(route.route_id, route);
    await server.inject({
      method: "POST",
      url: `/api/routes/${route.route_id}/review`,
      payload: { decision: "approved" },
    });
    const newSkill = Array.from(skills.values()).find(s => s.route_id === route.route_id)!;

    const res = await server.inject({
      method: "GET",
      url: `/api/skills/${newSkill.skill_id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.skill_id).toBe(newSkill.skill_id);
    expect(body.data.listing_status).toBe("active");
    expect(body.data.snapshot).not.toBeNull();
    expect(body.data.snapshot.domain).toBe(route.domain);
    expect(Array.isArray(body.data.snapshot.steps)).toBe(true);
  });

  it("returns 404 for an unknown skill_id", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/skills/skill_does_not_exist",
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns installed: true when user has the skill installed", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/skills/${IDS.SKILL_WIKI}`,
    });
    // Install first
    await server.inject({ method: "POST", url: `/api/skills/${IDS.SKILL_WIKI}/install`, payload: {} });

    const res2 = await server.inject({
      method: "GET",
      url: `/api/skills/${IDS.SKILL_WIKI}`,
    });
    expect(res2.statusCode).toBe(200);
    const body = JSON.parse(res2.body);
    expect(body.data.installed).toBe(true);
  });
});

// ─── Route deletion — soft-unlist semantics ───────────────────────────────────

describe("DELETE /api/routes/:routeId — source route deletion", () => {
  async function publishAndGetSkill() {
    const route = makeApprovedRoute();
    routes.set(route.route_id, route);
    await server.inject({
      method: "POST",
      url: `/api/routes/${route.route_id}/review`,
      payload: { decision: "approved" },
    });
    const skill = Array.from(skills.values()).find(s => s.route_id === route.route_id)!;
    return { route, skill };
  }

  it("sets listing_status to unlisted when source route is deleted", async () => {
    const { route, skill } = await publishAndGetSkill();

    const res = await server.inject({
      method: "DELETE",
      url: `/api/routes/${route.route_id}`,
    });
    expect(res.statusCode).toBe(200);

    expect(skills.get(skill.skill_id)!.listing_status).toBe("unlisted");
  });

  it("preserves the PublishedSkillVersion snapshot after route deletion", async () => {
    const { route, skill } = await publishAndGetSkill();
    const snapshotBefore = Array.from(publishedSkillVersions.values()).find(
      v => v.skill_id === skill.skill_id
    );
    expect(snapshotBefore).toBeDefined();

    await server.inject({ method: "DELETE", url: `/api/routes/${route.route_id}` });

    const snapshotAfter = publishedSkillVersions.get(snapshotBefore!.version_id);
    expect(snapshotAfter).toBeDefined();
    expect(snapshotAfter!.workflow_name).toBe(route.workflow_name);
  });

  it("GET /api/skills/:skillId still works after source route deleted", async () => {
    const { route, skill } = await publishAndGetSkill();

    await server.inject({ method: "DELETE", url: `/api/routes/${route.route_id}` });

    const res = await server.inject({ method: "GET", url: `/api/skills/${skill.skill_id}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.listing_status).toBe("unlisted");
    expect(body.data.snapshot).not.toBeNull();
    expect(body.data.snapshot.domain).toBe(route.domain);
  });

  it("deleting a private (unpublished) route does not error and leaves skills unchanged", async () => {
    const privateRoute = makeApprovedRoute({ marketplace_status: "private" });
    routes.set(privateRoute.route_id, privateRoute);
    const skillCountBefore = skills.size;

    const res = await server.inject({
      method: "DELETE",
      url: `/api/routes/${privateRoute.route_id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.deleted).toBe(true);
    expect(skills.size).toBe(skillCountBefore);
  });
});

// ─── Marketplace browse listing ───────────────────────────────────────────────

describe("GET /api/skills — marketplace browse filtering", () => {
  async function publishAndDelete() {
    const route = makeApprovedRoute();
    routes.set(route.route_id, route);
    await server.inject({
      method: "POST",
      url: `/api/routes/${route.route_id}/review`,
      payload: { decision: "approved" },
    });
    const skill = Array.from(skills.values()).find(s => s.route_id === route.route_id)!;
    await server.inject({ method: "DELETE", url: `/api/routes/${route.route_id}` });
    return { route, skill };
  }

  it("excludes unlisted skills from marketplace browse", async () => {
    const { skill } = await publishAndDelete();

    const res = await server.inject({ method: "GET", url: "/api/skills" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const found = body.data.find((s: any) => s.skill_id === skill.skill_id);
    expect(found).toBeUndefined();
  });

  it("keeps active skills visible in marketplace browse", async () => {
    const res = await server.inject({ method: "GET", url: "/api/skills" });
    const body = JSON.parse(res.body);
    expect(body.data.some((s: any) => s.skill_id === IDS.SKILL_WIKI)).toBe(true);
  });

  it("includes unlisted installed skills when ?installed=true", async () => {
    const { skill } = await publishAndDelete();
    // Install the skill (it still exists in skills Map, just unlisted)
    installedSkills.set("inskill_test_1", {
      installed_skill_id: "inskill_test_1",
      skill_id: skill.skill_id,
      user_id: MOCK_USER_ID,
      installed_at: NOW,
      enabled: true,
    });

    const res = await server.inject({ method: "GET", url: "/api/skills?installed=true" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const found = body.data.find((s: any) => s.skill_id === skill.skill_id);
    expect(found).toBeDefined();
  });
});

// ─── POST /api/routes/:routeId/publish — direct publish ──────────────────────

describe("POST /api/routes/:routeId/publish", () => {
  it("returns 422 for an unverified (draft) route", async () => {
    const route = makeApprovedRoute({ trust_tier: "unverified_draft", marketplace_status: undefined });
    routes.set(route.route_id, route);

    const res = await server.inject({
      method: "POST",
      url: `/api/routes/${route.route_id}/publish`,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("ROUTE_NOT_VERIFIED");
  });

  it("creates Skill + PublishedSkillVersion for a verified route", async () => {
    const route = makeApprovedRoute({ trust_tier: "aegis_scanned", marketplace_status: undefined });
    routes.set(route.route_id, route);

    const res = await server.inject({
      method: "POST",
      url: `/api/routes/${route.route_id}/publish`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.skill_id).toBeTruthy();
    expect(body.data.route.marketplace_status).toBe("approved");

    const skill = skills.get(body.data.skill_id);
    expect(skill).toBeDefined();
    expect(skill!.listing_status).toBe("active");
    expect(skill!.route_id).toBe(route.route_id);

    const snapshot = Array.from(publishedSkillVersions.values()).find(v => v.skill_id === skill!.skill_id);
    expect(snapshot).toBeDefined();
    expect(snapshot!.workflow_name).toBe(route.workflow_name);
  });

  it("re-lists a previously unlisted skill when republishing", async () => {
    const route = makeApprovedRoute({ trust_tier: "aegis_scanned", marketplace_status: undefined });
    routes.set(route.route_id, route);

    // First publish
    await server.inject({ method: "POST", url: `/api/routes/${route.route_id}/publish`, payload: {} });
    const skill = Array.from(skills.values()).find(s => s.route_id === route.route_id)!;

    // Unlist it
    await server.inject({ method: "POST", url: `/api/skills/${skill.skill_id}/unlist`, payload: {} });
    expect(skills.get(skill.skill_id)!.listing_status).toBe("unlisted");

    // Re-publish
    await server.inject({ method: "POST", url: `/api/routes/${route.route_id}/publish`, payload: {} });
    expect(skills.get(skill.skill_id)!.listing_status).toBe("active");
  });

  it("returns 404 for unknown route", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/routes/route_does_not_exist/publish",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /api/routes/:routeId/skill ───────────────────────────────────────────

describe("GET /api/routes/:routeId/skill", () => {
  it("returns 404 before the route is published", async () => {
    const route = makeApprovedRoute({ trust_tier: "aegis_scanned", marketplace_status: undefined });
    routes.set(route.route_id, route);

    const res = await server.inject({
      method: "GET",
      url: `/api/routes/${route.route_id}/skill`,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("NO_LINKED_SKILL");
  });

  it("returns the linked Skill after publish", async () => {
    const route = makeApprovedRoute({ trust_tier: "aegis_scanned", marketplace_status: undefined });
    routes.set(route.route_id, route);

    const publishRes = await server.inject({ method: "POST", url: `/api/routes/${route.route_id}/publish`, payload: {} });
    const publishedSkillId = JSON.parse(publishRes.body).data.skill_id;

    const res = await server.inject({ method: "GET", url: `/api/routes/${route.route_id}/skill` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.skill_id).toBe(publishedSkillId);
    expect(body.data.listing_status).toBe("active");
  });

  it("returns the Skill even after it is unlisted", async () => {
    const route = makeApprovedRoute({ trust_tier: "aegis_scanned", marketplace_status: undefined });
    routes.set(route.route_id, route);
    await server.inject({ method: "POST", url: `/api/routes/${route.route_id}/publish`, payload: {} });
    const skill = Array.from(skills.values()).find(s => s.route_id === route.route_id)!;
    await server.inject({ method: "POST", url: `/api/skills/${skill.skill_id}/unlist`, payload: {} });

    const res = await server.inject({ method: "GET", url: `/api/routes/${route.route_id}/skill` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.listing_status).toBe("unlisted");
  });
});

// ─── POST /api/skills/:skillId/unlist ────────────────────────────────────────

describe("POST /api/skills/:skillId/unlist", () => {
  async function publishRoute(trust_tier: string = "aegis_scanned") {
    const route = makeApprovedRoute({ trust_tier: trust_tier as any, marketplace_status: undefined });
    routes.set(route.route_id, route);
    await server.inject({ method: "POST", url: `/api/routes/${route.route_id}/publish`, payload: {} });
    return Array.from(skills.values()).find(s => s.route_id === route.route_id)!;
  }

  it("sets listing_status to unlisted", async () => {
    const skill = await publishRoute();
    const res = await server.inject({ method: "POST", url: `/api/skills/${skill.skill_id}/unlist`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.listing_status).toBe("unlisted");
    expect(skills.get(skill.skill_id)!.listing_status).toBe("unlisted");
  });

  it("unlisted skill disappears from marketplace browse", async () => {
    const skill = await publishRoute();

    // Confirm it appears in browse before unlist
    const before = await server.inject({ method: "GET", url: "/api/skills" });
    expect(JSON.parse(before.body).data.some((s: any) => s.skill_id === skill.skill_id)).toBe(true);

    await server.inject({ method: "POST", url: `/api/skills/${skill.skill_id}/unlist`, payload: {} });

    const after = await server.inject({ method: "GET", url: "/api/skills" });
    expect(JSON.parse(after.body).data.some((s: any) => s.skill_id === skill.skill_id)).toBe(false);
  });

  it("installed unlisted skill still appears with ?installed=true", async () => {
    const skill = await publishRoute();
    // Install it
    installedSkills.set("inskill_unlist_test", {
      installed_skill_id: "inskill_unlist_test",
      skill_id: skill.skill_id,
      user_id: MOCK_USER_ID,
      installed_at: NOW,
      enabled: true,
    });
    // Unlist
    await server.inject({ method: "POST", url: `/api/skills/${skill.skill_id}/unlist`, payload: {} });

    const res = await server.inject({ method: "GET", url: "/api/skills?installed=true" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.some((s: any) => s.skill_id === skill.skill_id)).toBe(true);
  });

  it("returns 404 for unknown skill_id", async () => {
    const res = await server.inject({ method: "POST", url: "/api/skills/skill_does_not_exist/unlist", payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Publish then marketplace browse ─────────────────────────────────────────

describe("After publish — marketplace browse includes the new skill", () => {
  it("GET /api/skills includes the published skill", async () => {
    const route = makeApprovedRoute({ trust_tier: "aegis_scanned", marketplace_status: undefined });
    routes.set(route.route_id, route);
    const publishRes = await server.inject({ method: "POST", url: `/api/routes/${route.route_id}/publish`, payload: {} });
    const skillId = JSON.parse(publishRes.body).data.skill_id;

    const res = await server.inject({ method: "GET", url: "/api/skills" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.some((s: any) => s.skill_id === skillId)).toBe(true);
  });
});

// ─── Backward compatibility ───────────────────────────────────────────────────

describe("GET /api/skills — backward compat: skill without listing_status", () => {
  it("treats skills missing listing_status field as active", async () => {
    const legacySkill: Skill = {
      skill_id: "skill_legacy_no_status",
      route_id: IDS.ROUTE_WIKI,
      name: "Legacy Skill",
      summary: "No listing_status field.",
      domain: "legacy.test.local",
      risk_level: "low",
      trust_tier: "aegis_scanned",
      required_permissions: [],
      forbidden_actions: [],
      approval_gates: [],
      created_at: NOW,
      published_at: NOW,
      // No listing_status field — simulates pre-migration data
    };
    skills.set(legacySkill.skill_id, legacySkill);

    const res = await server.inject({ method: "GET", url: "/api/skills" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.some((s: any) => s.skill_id === legacySkill.skill_id)).toBe(true);
  });
});
