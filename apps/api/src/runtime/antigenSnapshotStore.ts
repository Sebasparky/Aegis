/**
 * Antigen Snapshot Store — in-memory snapshot + element records (v1, increment 2).
 *
 * Phase 1 (antigenSnapshotRuntime.ts) extracts visible interactive DOM candidates
 * from a live page over CDP. This module turns a candidate list into an
 * Antigen-owned snapshot:
 *
 *   candidates → assign ag_* refs → store internal records (WITH boxes)
 *              → expose a safe external view (WITHOUT boxes)
 *
 * Boundary preserved here (asserted in tests):
 * - Internal element records DO carry bounding boxes (Antigen needs them later
 *   for revalidation before click/type). They are never exposed to agents.
 * - The external view (`toExternalAntigenSnapshotElement`) omits box/coordinates
 *   and any non-path href; it carries only safe semantic metadata.
 * - Records are scoped by user_id; getters return nothing for a mismatched user.
 * - Refs (`ag_1`, `ag_2`, …) are sequential PER snapshot, not globally unique —
 *   two snapshots may both contain `ag_1`.
 *
 * v1 is in-memory only. No persistence, no audit logging, no receipts. This
 * module deliberately does NOT resolve refs for click/type — that is a later
 * phase.
 */

import type {
  AntigenCandidateKind,
  AntigenSnapshotCandidate,
  AntigenSnapshotContext,
} from "./antigenSnapshotRuntime.js";
import { newId } from "../store/index.js";

// ─── TTL ─────────────────────────────────────────────────────────────────────

/** Default snapshot lifetime. Boxes go stale fast (scroll, layout, navigation). */
export const ANTIGEN_SNAPSHOT_TTL_MS = 10_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AntigenSnapshotRecord {
  snapshot_id: string;
  browser_session_id: string;
  browser_runtime_id: string;
  user_id: string;
  url: string | null;
  title: string | null;
  created_at: string;
  expires_at: string;
  element_count: number;
}

/**
 * Full internal record for one element. Carries the bounding box — internal
 * only, never exposed to the agent. No selector hints, secret refs, cdp/profile
 * data, or raw values are stored.
 */
export interface AntigenSnapshotElementRecord {
  snapshot_id: string;
  ref: string; // "ag_1", "ag_2", …
  browser_session_id: string;
  browser_runtime_id: string;
  user_id: string;

  tag: string;
  kind: AntigenCandidateKind;
  role: string | null;
  name: string;
  normalized_name: string;
  id: string | null;
  href: string | null;
  href_path: string | null;

  visible: boolean;
  enabled: boolean;
  typeable: boolean;
  clickable: boolean;

  box: { x: number; y: number; width: number; height: number };

  /**
   * Bounded disambiguation context (internal record carries `nearby_text`
   * too; only `label`/`section` are ever exposed externally).
   */
  context?: AntigenSnapshotContext;

  created_at: string;
  expires_at: string;
}

/** Agent-facing element view — NO box/coordinates, NO full href. */
export interface ExternalAntigenSnapshotElement {
  ref: string;
  kind: AntigenCandidateKind;
  role: string | null;
  name: string;
  state: {
    visible: boolean;
    enabled: boolean;
    clickable: boolean;
    typeable: boolean;
  };
  hints: {
    href_path?: string;
  };
  /** Agent-facing context — label/section only; never `nearby_text`. */
  context?: { label?: string; section?: string };
}

// ─── In-memory store ─────────────────────────────────────────────────────────

interface StoredSnapshot {
  snapshot: AntigenSnapshotRecord;
  elementsByRef: Map<string, AntigenSnapshotElementRecord>;
}

const snapshots = new Map<string, StoredSnapshot>();

// ─── Create ──────────────────────────────────────────────────────────────────

export interface CreateAntigenSnapshotParams {
  browser_session_id: string;
  /**
   * The agent-facing runtime id as requested. By convention this equals
   * browser_session_id (the runtime endpoints alias one to the other), but it is
   * preserved as-requested rather than re-derived.
   */
  browser_runtime_id: string;
  user_id: string;
  url: string | null;
  title: string | null;
  candidates: AntigenSnapshotCandidate[];
  /** Injectable clock for deterministic tests. Defaults to now. */
  now?: Date;
}

/**
 * Assigns ag_* refs to candidates, builds internal element records (with boxes),
 * stores them, and returns the snapshot record plus the element array. An empty
 * candidate list produces a valid empty snapshot.
 */
export function createAntigenSnapshotRecord(params: CreateAntigenSnapshotParams): {
  snapshot: AntigenSnapshotRecord;
  elements: AntigenSnapshotElementRecord[];
} {
  const now = params.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ANTIGEN_SNAPSHOT_TTL_MS).toISOString();
  const snapshotId = newId("snap");

  // Store-cleanup invariant: after this call, at most one active snapshot remains
  // per browser_session_id + user_id. First drop globally-expired snapshots, then
  // drop any prior snapshot for THIS session+user before storing the fresh one.
  // (Other sessions/users are untouched.)
  deleteExpiredAntigenSnapshots(now);
  deleteAntigenSnapshotsForSession(params.browser_session_id, params.user_id);

  const elements: AntigenSnapshotElementRecord[] = params.candidates.map((c, i) => ({
    snapshot_id: snapshotId,
    ref: `ag_${i + 1}`,
    browser_session_id: params.browser_session_id,
    browser_runtime_id: params.browser_runtime_id,
    user_id: params.user_id,

    tag: c.tag,
    kind: c.kind,
    role: c.role,
    name: c.name,
    normalized_name: c.normalized_name,
    id: c.id,
    href: c.href,
    href_path: c.href_path,

    visible: c.visible,
    enabled: c.enabled,
    typeable: c.typeable,
    clickable: c.clickable,

    box: { x: c.box.x, y: c.box.y, width: c.box.width, height: c.box.height },

    context: c.context,

    created_at: createdAt,
    expires_at: expiresAt,
  }));

  const snapshot: AntigenSnapshotRecord = {
    snapshot_id: snapshotId,
    browser_session_id: params.browser_session_id,
    browser_runtime_id: params.browser_runtime_id,
    user_id: params.user_id,
    url: params.url,
    title: params.title,
    created_at: createdAt,
    expires_at: expiresAt,
    element_count: elements.length,
  };

  const elementsByRef = new Map<string, AntigenSnapshotElementRecord>();
  for (const el of elements) elementsByRef.set(el.ref, el);
  snapshots.set(snapshotId, { snapshot, elementsByRef });

  return { snapshot, elements };
}

// ─── Lookup (user-scoped) ────────────────────────────────────────────────────

export function getAntigenSnapshot(snapshotId: string, userId: string): AntigenSnapshotRecord | undefined {
  const stored = snapshots.get(snapshotId);
  if (!stored || stored.snapshot.user_id !== userId) return undefined;
  return stored.snapshot;
}

export function getAntigenSnapshotElement(
  snapshotId: string,
  ref: string,
  userId: string,
): AntigenSnapshotElementRecord | undefined {
  const stored = snapshots.get(snapshotId);
  if (!stored || stored.snapshot.user_id !== userId) return undefined;
  return stored.elementsByRef.get(ref);
}

export function listAntigenSnapshotElements(
  snapshotId: string,
  userId: string,
): AntigenSnapshotElementRecord[] {
  const stored = snapshots.get(snapshotId);
  if (!stored || stored.snapshot.user_id !== userId) return [];
  return [...stored.elementsByRef.values()];
}

// ─── Session-scoped ref resolution (Phase 4A) ───────────────────────────────

/**
 * Result of resolving an `ag_*` ref against the active snapshot for a
 * session+user. The box lives only on `element` (internal) and is never
 * surfaced to agents — callers read `element.box` solely to hand it to the
 * realistic pointer click path.
 */
export type AntigenRefResolution =
  | { status: "ok"; element: AntigenSnapshotElementRecord }
  | { status: "no_snapshot" }
  | { status: "expired" }
  | { status: "ref_not_found" };

/**
 * Resolves an `ag_*` ref to its internal element record using the single active
 * snapshot for the given browser_session_id + user_id. The Phase 3.5 invariant
 * guarantees at most one active snapshot per session+user, so scanning the
 * in-memory map is safe. This is exact-ref resolution only — no scoring, no
 * fuzzy matching, no text rediscovery.
 */
export function resolveAntigenRefForSession(
  browserSessionId: string,
  userId: string,
  ref: string,
  now?: Date,
): AntigenRefResolution {
  let stored: StoredSnapshot | undefined;
  for (const s of snapshots.values()) {
    if (
      s.snapshot.browser_session_id === browserSessionId &&
      s.snapshot.user_id === userId
    ) {
      stored = s;
      break;
    }
  }
  if (!stored) return { status: "no_snapshot" };
  if (isAntigenSnapshotExpired(stored.snapshot, now)) return { status: "expired" };

  const element = stored.elementsByRef.get(ref);
  if (!element) return { status: "ref_not_found" };
  return { status: "ok", element };
}

// ─── Freshness ───────────────────────────────────────────────────────────────

export function isAntigenSnapshotExpired(snapshot: AntigenSnapshotRecord, now?: Date): boolean {
  const ts = (now ?? new Date()).getTime();
  return ts > new Date(snapshot.expires_at).getTime();
}

/** Deletes all expired snapshots. Returns the number removed. */
export function deleteExpiredAntigenSnapshots(now?: Date): number {
  const ref = now ?? new Date();
  let removed = 0;
  for (const [id, stored] of snapshots) {
    if (isAntigenSnapshotExpired(stored.snapshot, ref)) {
      snapshots.delete(id);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Deletes every stored snapshot (and its elements) for a given
 * browser_session_id + user_id. Returns the number of snapshots removed.
 *
 * Used to enforce the "at most one active snapshot per session+user" invariant
 * before storing a fresh snapshot (see createAntigenSnapshotRecord). Scoped to a
 * single session+user — snapshots for other sessions or other users are left
 * untouched, preserving cross-session and cross-user isolation. Because a stored
 * snapshot carries its elements with it, deleting the entry drops the elements too.
 */
export function deleteAntigenSnapshotsForSession(browserSessionId: string, userId: string): number {
  let removed = 0;
  for (const [id, stored] of snapshots) {
    if (
      stored.snapshot.browser_session_id === browserSessionId &&
      stored.snapshot.user_id === userId
    ) {
      snapshots.delete(id);
      removed += 1;
    }
  }
  return removed;
}

// ─── External view ───────────────────────────────────────────────────────────

/** Box-stripping conversion to the agent-facing element shape. */
export function toExternalAntigenSnapshotElement(
  el: AntigenSnapshotElementRecord,
): ExternalAntigenSnapshotElement {
  const out: ExternalAntigenSnapshotElement = {
    ref: el.ref,
    kind: el.kind,
    role: el.role,
    name: el.name,
    state: {
      visible: el.visible,
      enabled: el.enabled,
      clickable: el.clickable,
      typeable: el.typeable,
    },
    hints: el.href_path ? { href_path: el.href_path } : {},
  };
  // Agent-facing context: label/section only — `nearby_text` stays internal.
  if (el.context && (el.context.label || el.context.section)) {
    const ctx: { label?: string; section?: string } = {};
    if (el.context.label) ctx.label = el.context.label;
    if (el.context.section) ctx.section = el.context.section;
    out.context = ctx;
  }
  return out;
}

// ─── Test support ────────────────────────────────────────────────────────────

export function clearAntigenSnapshotStoreForTests(): void {
  snapshots.clear();
}
