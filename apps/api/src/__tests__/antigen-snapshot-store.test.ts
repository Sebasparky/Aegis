/**
 * Antigen Snapshot Store — unit tests.
 *
 * Pure in-memory tests: no server, no browser. Builds AntigenSnapshotCandidate
 * fixtures and asserts the store/boundary invariants:
 * - ag_* ref assignment, snapshot ids
 * - internal records carry boxes; external view strips them
 * - user-scoped lookup
 * - per-snapshot ref namespace (two snapshots both have ag_1)
 * - expiry deletion
 * - empty candidate list → valid empty snapshot
 * - forbidden fields never leak via the external view
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { AntigenSnapshotCandidate } from "../runtime/antigenSnapshotRuntime.js";
import {
  ANTIGEN_SNAPSHOT_TTL_MS,
  createAntigenSnapshotRecord,
  getAntigenSnapshot,
  getAntigenSnapshotElement,
  listAntigenSnapshotElements,
  isAntigenSnapshotExpired,
  deleteExpiredAntigenSnapshots,
  deleteAntigenSnapshotsForSession,
  resolveAntigenRefForSession,
  toExternalAntigenSnapshotElement,
  clearAntigenSnapshotStoreForTests,
} from "../runtime/antigenSnapshotStore.js";

const USER = "user_001";
const OTHER_USER = "user_999";

function makeCandidate(overrides: Partial<AntigenSnapshotCandidate> = {}): AntigenSnapshotCandidate {
  return {
    index: 0,
    tag: "a",
    kind: "link",
    role: "link",
    name: "TERTIAL, Work lamp, light blue",
    normalized_name: "tertial work lamp light blue",
    id: null,
    href: "https://www.ikea.com/us/en/p/tertial-work-lamp-light-blue-70504295/?ref=nav",
    href_path: "/us/en/p/tertial-work-lamp-light-blue-70504295/",
    visible: true,
    enabled: true,
    typeable: false,
    clickable: true,
    box: { x: 12, y: 34, width: 220, height: 48 },
    ...overrides,
  };
}

function createFor(
  candidates: AntigenSnapshotCandidate[],
  opts: { user_id?: string; now?: Date; url?: string | null; browser_session_id?: string } = {},
) {
  const sessionId = opts.browser_session_id ?? "tbsess_store_001";
  return createAntigenSnapshotRecord({
    browser_session_id: sessionId,
    browser_runtime_id: sessionId,
    user_id: opts.user_id ?? USER,
    url: opts.url ?? "https://www.ikea.com/us/en/search/?q=desk%20lamp",
    title: null,
    candidates,
    now: opts.now,
  });
}

beforeEach(() => {
  clearAntigenSnapshotStoreForTests();
});

describe("createAntigenSnapshotRecord", () => {
  it("creates a snapshot with an Antigen-owned snapshot_id and correct count", () => {
    const { snapshot } = createFor([makeCandidate(), makeCandidate({ name: "Add to bag", kind: "button", role: "button", href: null, href_path: null })]);
    expect(snapshot.snapshot_id).toMatch(/^snap_/);
    expect(snapshot.element_count).toBe(2);
    expect(snapshot.url).toBe("https://www.ikea.com/us/en/search/?q=desk%20lamp");
    expect(snapshot.title).toBeNull();
    expect(getAntigenSnapshot(snapshot.snapshot_id, USER)).toEqual(snapshot);
  });

  it("assigns sequential ag_1, ag_2, ag_3 refs", () => {
    const { elements } = createFor([makeCandidate(), makeCandidate(), makeCandidate()]);
    expect(elements.map((e) => e.ref)).toEqual(["ag_1", "ag_2", "ag_3"]);
  });

  it("stores internal bounding boxes on element records", () => {
    const { snapshot, elements } = createFor([makeCandidate({ box: { x: 5, y: 6, width: 7, height: 8 } })]);
    expect(elements[0].box).toEqual({ x: 5, y: 6, width: 7, height: 8 });
    const stored = getAntigenSnapshotElement(snapshot.snapshot_id, "ag_1", USER);
    expect(stored?.box).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });

  it("sets expires_at to created_at + TTL", () => {
    const now = new Date("2026-06-02T12:00:00.000Z");
    const { snapshot } = createFor([makeCandidate()], { now });
    expect(snapshot.created_at).toBe(now.toISOString());
    expect(new Date(snapshot.expires_at).getTime() - now.getTime()).toBe(ANTIGEN_SNAPSHOT_TTL_MS);
  });

  it("creates a valid empty snapshot for an empty candidate list", () => {
    const { snapshot, elements } = createFor([]);
    expect(snapshot.element_count).toBe(0);
    expect(elements).toEqual([]);
    expect(listAntigenSnapshotElements(snapshot.snapshot_id, USER)).toEqual([]);
  });
});

describe("lookup", () => {
  it("resolves an element by snapshot_id + ref", () => {
    const { snapshot } = createFor([makeCandidate({ name: "Search", kind: "input" })]);
    const el = getAntigenSnapshotElement(snapshot.snapshot_id, "ag_1", USER);
    expect(el?.name).toBe("Search");
    expect(el?.kind).toBe("input");
  });

  it("scopes lookups by user_id", () => {
    const { snapshot } = createFor([makeCandidate()], { user_id: USER });
    expect(getAntigenSnapshot(snapshot.snapshot_id, OTHER_USER)).toBeUndefined();
    expect(getAntigenSnapshotElement(snapshot.snapshot_id, "ag_1", OTHER_USER)).toBeUndefined();
    expect(listAntigenSnapshotElements(snapshot.snapshot_id, OTHER_USER)).toEqual([]);
    // Correct user still resolves.
    expect(getAntigenSnapshot(snapshot.snapshot_id, USER)).toBeDefined();
  });
});

describe("ref namespace is per-snapshot", () => {
  it("two independent snapshots (distinct sessions) can each contain ag_1", () => {
    // Distinct sessions so both survive the same-session cleanup invariant.
    const a = createFor([makeCandidate({ name: "A" })], { browser_session_id: "session_1" });
    const b = createFor([makeCandidate({ name: "B" })], { browser_session_id: "session_2" });
    expect(a.snapshot.snapshot_id).not.toBe(b.snapshot.snapshot_id);
    expect(getAntigenSnapshotElement(a.snapshot.snapshot_id, "ag_1", USER)?.name).toBe("A");
    expect(getAntigenSnapshotElement(b.snapshot.snapshot_id, "ag_1", USER)?.name).toBe("B");
  });
});

describe("expiry", () => {
  it("isAntigenSnapshotExpired reflects the TTL window", () => {
    const now = new Date("2026-06-02T12:00:00.000Z");
    const { snapshot } = createFor([makeCandidate()], { now });
    expect(isAntigenSnapshotExpired(snapshot, now)).toBe(false);
    const later = new Date(now.getTime() + ANTIGEN_SNAPSHOT_TTL_MS + 1);
    expect(isAntigenSnapshotExpired(snapshot, later)).toBe(true);
  });

  it("deleteExpiredAntigenSnapshots removes expired snapshots and returns the count", () => {
    const now = new Date("2026-06-02T12:00:00.000Z");
    const { snapshot } = createFor([makeCandidate()], { now });
    const later = new Date(now.getTime() + ANTIGEN_SNAPSHOT_TTL_MS + 1);
    expect(deleteExpiredAntigenSnapshots(later)).toBe(1);
    expect(getAntigenSnapshot(snapshot.snapshot_id, USER)).toBeUndefined();
  });

  it("does not delete still-fresh snapshots", () => {
    const now = new Date("2026-06-02T12:00:00.000Z");
    const { snapshot } = createFor([makeCandidate()], { now });
    expect(deleteExpiredAntigenSnapshots(now)).toBe(0);
    expect(getAntigenSnapshot(snapshot.snapshot_id, USER)).toBeDefined();
  });
});

describe("session cleanup semantics", () => {
  // Invariant: after createAntigenSnapshotRecord(...), at most one active snapshot
  // remains per browser_session_id + user_id. Expired snapshots and prior
  // same-session/user snapshots are deleted before the new one is stored.

  it("a second snapshot for the same session+user deletes the first", () => {
    const a = createFor([makeCandidate({ name: "A" })]);
    const b = createFor([
      makeCandidate({ name: "B1" }),
      makeCandidate({ name: "B2", kind: "button", role: "button", href: null, href_path: null }),
    ]);

    expect(a.snapshot.snapshot_id).not.toBe(b.snapshot.snapshot_id);
    // A is gone, including its elements.
    expect(getAntigenSnapshot(a.snapshot.snapshot_id, USER)).toBeUndefined();
    expect(listAntigenSnapshotElements(a.snapshot.snapshot_id, USER)).toEqual([]);
    // B is the latest active snapshot and keeps its own ref namespace.
    expect(getAntigenSnapshot(b.snapshot.snapshot_id, USER)).toBeDefined();
    expect(getAntigenSnapshotElement(b.snapshot.snapshot_id, "ag_1", USER)?.name).toBe("B1");
    expect(getAntigenSnapshotElement(b.snapshot.snapshot_id, "ag_2", USER)?.name).toBe("B2");
  });

  it("keeps different browser sessions (same user) isolated", () => {
    const a = createFor([makeCandidate({ name: "A" })], { browser_session_id: "session_1" });
    const b = createFor([makeCandidate({ name: "B" })], { browser_session_id: "session_2" });
    expect(getAntigenSnapshot(a.snapshot.snapshot_id, USER)).toBeDefined();
    expect(getAntigenSnapshot(b.snapshot.snapshot_id, USER)).toBeDefined();
  });

  it("keeps different users (same session) isolated and user-scoped", () => {
    const a = createFor([makeCandidate({ name: "A" })], { user_id: USER });
    const b = createFor([makeCandidate({ name: "B" })], { user_id: OTHER_USER });
    // Both survive — creating B for OTHER_USER must not delete A for USER.
    expect(getAntigenSnapshot(a.snapshot.snapshot_id, USER)).toBeDefined();
    expect(getAntigenSnapshot(b.snapshot.snapshot_id, OTHER_USER)).toBeDefined();
    // Cross-user access is denied either direction.
    expect(getAntigenSnapshot(a.snapshot.snapshot_id, OTHER_USER)).toBeUndefined();
    expect(getAntigenSnapshot(b.snapshot.snapshot_id, USER)).toBeUndefined();
  });

  it("deletes a globally-expired snapshot when a new snapshot is created", () => {
    const t0 = new Date("2026-06-02T12:00:00.000Z");
    // Old snapshot on a DIFFERENT session, so it is removed by the expiry sweep
    // (not the same-session sweep).
    const old = createFor([makeCandidate({ name: "old" })], { browser_session_id: "session_old", now: t0 });
    const t1 = new Date(t0.getTime() + ANTIGEN_SNAPSHOT_TTL_MS + 1);
    const fresh = createFor([makeCandidate({ name: "fresh" })], { browser_session_id: "session_new", now: t1 });

    expect(getAntigenSnapshot(old.snapshot.snapshot_id, USER)).toBeUndefined();
    expect(getAntigenSnapshot(fresh.snapshot.snapshot_id, USER)).toBeDefined();
  });

  it("deleteAntigenSnapshotsForSession returns an accurate count and only removes matching session+user", () => {
    const target = createFor([makeCandidate()], { browser_session_id: "session_1", user_id: USER });
    const otherSession = createFor([makeCandidate()], { browser_session_id: "session_2", user_id: USER });
    const otherUser = createFor([makeCandidate()], { browser_session_id: "session_1", user_id: OTHER_USER });

    expect(deleteAntigenSnapshotsForSession("session_1", USER)).toBe(1);
    expect(getAntigenSnapshot(target.snapshot.snapshot_id, USER)).toBeUndefined();
    // Other session and other user are untouched.
    expect(getAntigenSnapshot(otherSession.snapshot.snapshot_id, USER)).toBeDefined();
    expect(getAntigenSnapshot(otherUser.snapshot.snapshot_id, OTHER_USER)).toBeDefined();
    // A second call finds nothing left to remove.
    expect(deleteAntigenSnapshotsForSession("session_1", USER)).toBe(0);
  });

  it("an empty snapshot still replaces a prior snapshot for the same session+user", () => {
    const a = createFor([makeCandidate({ name: "A" })]);
    const empty = createFor([]);
    expect(getAntigenSnapshot(a.snapshot.snapshot_id, USER)).toBeUndefined();
    expect(getAntigenSnapshot(empty.snapshot.snapshot_id, USER)).toBeDefined();
    expect(empty.snapshot.element_count).toBe(0);
  });

  it("retires the prior snapshot's ag_1 while the new snapshot's ag_1 resolves", () => {
    const first = createFor([makeCandidate({ name: "first-1" })]);
    const second = createFor([makeCandidate({ name: "second-1" })]);
    // Same session+user: first is gone, second owns its own ag_1.
    expect(getAntigenSnapshotElement(first.snapshot.snapshot_id, "ag_1", USER)).toBeUndefined();
    expect(getAntigenSnapshotElement(second.snapshot.snapshot_id, "ag_1", USER)?.name).toBe("second-1");
  });
});

describe("external view", () => {
  it("omits the box and full href; keeps safe semantic metadata", () => {
    const { elements } = createFor([makeCandidate()]);
    const ext = toExternalAntigenSnapshotElement(elements[0]);
    expect(ext).toEqual({
      ref: "ag_1",
      kind: "link",
      role: "link",
      name: "TERTIAL, Work lamp, light blue",
      state: { visible: true, enabled: true, clickable: true, typeable: false },
      hints: { href_path: "/us/en/p/tertial-work-lamp-light-blue-70504295/" },
    });
    expect(Object.keys(ext)).not.toContain("box");
    expect(Object.keys(ext)).not.toContain("href");
  });

  it("returns empty hints when there is no href_path", () => {
    const { elements } = createFor([makeCandidate({ kind: "button", role: "button", href: null, href_path: null, name: "Add to bag" })]);
    expect(toExternalAntigenSnapshotElement(elements[0]).hints).toEqual({});
  });

  it("never leaks forbidden fields via the external view", () => {
    const { elements } = createFor([
      makeCandidate(),
      makeCandidate({ kind: "button", role: "button", href: null, href_path: null, name: "Add to bag" }),
    ]);
    const serialized = JSON.stringify(elements.map(toExternalAntigenSnapshotElement));
    const FORBIDDEN = [
      "\"box\"", "\"x\":", "\"y\":", "\"width\"", "\"height\"", "center",
      "cdp_url", "user_data_dir", "profile_key", "pass_id", "secret_ref",
      "storageState", "selector",
    ];
    for (const f of FORBIDDEN) {
      expect(serialized).not.toContain(f);
    }
    // href_path (a safe path) is allowed; the full href / origin / query is not.
    expect(serialized).not.toContain("https://www.ikea.com");
    expect(serialized).not.toContain("ref=nav");
  });
});

describe("resolveAntigenRefForSession (Phase 4A)", () => {
  const SESSION = "tbsess_store_001";

  it("resolves the active snapshot element by session/user/ref with its box", () => {
    createFor([
      makeCandidate({ name: "Shopping bag" }),
      makeCandidate({ kind: "button", role: "button", name: "Ok", box: { x: 100, y: 200, width: 80, height: 40 } }),
    ]);

    const res = resolveAntigenRefForSession(SESSION, USER, "ag_2");
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.element.ref).toBe("ag_2");
    expect(res.element.name).toBe("Ok");
    // Internal box is available to the resolver (handed to the click path).
    expect(res.element.box).toEqual({ x: 100, y: 200, width: 80, height: 40 });
  });

  it("does not resolve a ref for a different session", () => {
    createFor([makeCandidate()], { browser_session_id: SESSION });
    expect(resolveAntigenRefForSession("tbsess_other", USER, "ag_1").status).toBe("no_snapshot");
  });

  it("does not resolve a ref for a different user", () => {
    createFor([makeCandidate()], { browser_session_id: SESSION, user_id: USER });
    expect(resolveAntigenRefForSession(SESSION, OTHER_USER, "ag_1").status).toBe("no_snapshot");
  });

  it("returns expired when the active snapshot is past its TTL", () => {
    const t0 = new Date("2026-06-02T00:00:00.000Z");
    createFor([makeCandidate()], { browser_session_id: SESSION, now: t0 });
    const later = new Date(t0.getTime() + ANTIGEN_SNAPSHOT_TTL_MS + 1);
    expect(resolveAntigenRefForSession(SESSION, USER, "ag_1", later).status).toBe("expired");
  });

  it("returns ref_not_found for a missing ref in a live snapshot", () => {
    createFor([makeCandidate()], { browser_session_id: SESSION });
    expect(resolveAntigenRefForSession(SESSION, USER, "ag_99").status).toBe("ref_not_found");
  });

  it("does not mutate the external view (box stays internal only)", () => {
    createFor([makeCandidate({ name: "Ok" })], { browser_session_id: SESSION });
    const res = resolveAntigenRefForSession(SESSION, USER, "ag_1");
    if (res.status !== "ok") throw new Error("expected ok");
    const external = toExternalAntigenSnapshotElement(res.element);
    expect(JSON.stringify(external)).not.toContain("box");
  });
});
