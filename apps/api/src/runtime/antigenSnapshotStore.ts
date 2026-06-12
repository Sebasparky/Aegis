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
  AntigenRawValueMeta,
  AntigenOverlayInfo,
  AntigenOverlayType,
} from "./antigenSnapshotRuntime.js";
import { isHumanVerificationEnabled } from "./humanVerificationState.js";
import { newId } from "../store/index.js";

// ─── TTL ─────────────────────────────────────────────────────────────────────

/**
 * Wall-clock backstop for a snapshot's refs. This is a generous, generic upper
 * bound for an active browsing session — NOT the primary staleness mechanism.
 * Real staleness is enforced DOM-truthfully by (1) Phase 4B known-box
 * revalidation on every click/type, (2) snapshot superseding (a new snapshot
 * drops the prior one for the session+user), and (3) the live-URL guard
 * (isAntigenPageChanged). The wall-clock TTL only bounds how long a box may sit
 * before a forced re-snapshot; it must be long enough to survive ordinary agent
 * reasoning between snapshot and action, so it does not fire merely because the
 * agent spent a few seconds thinking.
 */
export const ANTIGEN_SNAPSHOT_TTL_MS = 90_000;

/**
 * Live-URL guard for Antigen refs. Returns true when the live page URL differs
 * from the snapshot URL in a way that should invalidate stored boxes, so a ref
 * from page A can never be acted on after navigating to page B — independent of
 * the wall-clock TTL.
 *
 * Normalization (generic, not site-specific):
 *  - Hash (#fragment) is ignored — in-page anchors do not move layout boxes.
 *  - A single trailing slash on the path is tolerated ("/a" == "/a/").
 *  - Origin (protocol + host + port) and path ARE significant.
 *  - The query is significant by its DECODED parameter multiset, not its raw
 *    string — checkout/search/SPA flows encode navigation state in the query,
 *    so a genuine parameter change counts as a page change. Equivalent encodings
 *    ("+" vs "%20", percent-encoded Unicode) and parameter order are NOT changes;
 *    duplicate params are preserved as a multiset (?a=1&a=2 differs from ?a=1).
 *
 * Conservative no-op cases (returns false, never blocks): missing snapshot URL
 * or missing live URL. Phase 4B revalidation still guards element identity in
 * those cases, so we do not over-block on incomparable inputs.
 */
export function isAntigenPageChanged(
  snapshotUrl: string | null | undefined,
  liveUrl: string | null | undefined,
): boolean {
  if (!snapshotUrl || !liveUrl) return false;
  if (snapshotUrl === liveUrl) return false;

  const norm = (raw: string): { origin: string; path: string; query: string } | null => {
    try {
      const u = new URL(raw);
      let path = u.pathname;
      if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
      // Compare the query by its decoded parameter multiset, not the raw string.
      // URLSearchParams decodes "+" and "%20" to a space and resolves percent-encoded
      // Unicode, so equivalent encodings collapse to the same value. Sorting the
      // [key, value] pairs makes parameter order insignificant while preserving
      // duplicate params as a multiset; re-encoding each component canonicalizes the
      // form and avoids "&"/"=" delimiter ambiguity in the comparison signature.
      const entries = [...u.searchParams.entries()];
      entries.sort((x, y) =>
        x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0,
      );
      const query = entries
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      return { origin: u.origin, path, query };
    } catch {
      return null;
    }
  };

  const a = norm(snapshotUrl);
  const b = norm(liveUrl);

  // If either URL is unparseable, fall back to a hash-stripped, trailing-slash
  // tolerant string compare and fail closed on any remaining difference.
  if (!a || !b) {
    const strip = (s: string) => s.replace(/#.*$/, "").replace(/\/+$/, "");
    return strip(snapshotUrl) !== strip(liveUrl);
  }

  return a.origin !== b.origin || a.path !== b.path || a.query !== b.query;
}

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

  /**
   * Bounding box — internal only, never exposed. `x`/`y` are viewport-relative
   * (realistic pointer click); `doc_x`/`doc_y` are document-space (for
   * scroll-to-ref recovery of an offscreen ref).
   */
  box: { x: number; y: number; width: number; height: number; doc_x?: number; doc_y?: number };

  /**
   * Bounded disambiguation context (internal record carries `nearby_text`
   * too; only `label`/`section` are ever exposed externally).
   */
  context?: AntigenSnapshotContext;

  /**
   * Redacted current-value metadata for field-like elements (skip-aware exact
   * fill). Sensitive fields already carry only present/length/flags here; the
   * external view re-enforces that boundary.
   */
  value_meta?: AntigenRawValueMeta;

  /**
   * Active-overlay membership (modal/dialog/popover/toast/drawer/top-layer). The
   * internal record keeps `in_inert`/`bg_hidden`/`background` for page-map
   * demotion; the external view strips them.
   */
  overlay?: AntigenOverlayInfo;

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
  /**
   * Agent-facing current-value metadata. For sensitive fields ONLY
   * `present`/`length`/`required`/`readonly`/`invalid`/`sensitive` appear —
   * `text`/`selected_value`/`selected_text`/`validation_message` are omitted.
   */
  value?: {
    present?: boolean;
    /** Value is only a mask/placeholder template, not a real value. When true, `present` is false. */
    placeholder_only?: boolean;
    length?: number;
    text?: string;
    selected_value?: string | null;
    selected_text?: string | null;
    checked?: boolean;
    required?: boolean;
    readonly?: boolean;
    invalid?: boolean;
    validation_message?: string;
    sensitive: boolean;
  };
  /**
   * Active-overlay membership, agent-facing. Present only for real overlay
   * members (background-behind-modal markers are dropped). Internal ranking
   * signals (`in_inert`/`bg_hidden`/`background`) are NEVER surfaced; `is_primary`
   * is filled by the endpoint from the page map's primary-action set.
   */
  overlay?: {
    overlay_type: AntigenOverlayType;
    blocking: boolean;
    modal_title?: string;
    is_dismiss?: boolean;
    is_primary?: boolean;
    /**
     * The overlay is a human-verification challenge (Human Presence Relay).
     * Classification only — the internal control marker (`hv_control`) and all
     * geometry stay internal.
     */
    human_verification?: true;
    hv_challenge_type?: string;
  };
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

    box: {
      x: c.box.x,
      y: c.box.y,
      width: c.box.width,
      height: c.box.height,
      doc_x: c.box.doc_x,
      doc_y: c.box.doc_y,
    },

    context: c.context,
    value_meta: c.value_meta,
    overlay: c.overlay,

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
  | {
      status: "ok";
      element: AntigenSnapshotElementRecord;
      /** Snapshot-time page URL — the "expected" side of the live-URL guard. */
      snapshot_url: string | null;
      snapshot_id: string;
    }
  | { status: "no_snapshot" }
  | {
      /**
       * The snapshot exceeded its wall-clock TTL. The element record may still be
       * present (the snapshot has not been GC'd yet): when it is, `element` +
       * `snapshot_url` + `snapshot_id` are populated so a flag-gated TTL-expiry
       * recovery can re-run the FULL safety stack (action gate, live-URL guard,
       * Phase 4B, logical-recovery eligibility) and, only on success, refresh the
       * lease. The box on `element` is never surfaced to agents. When the ref is
       * not in the snapshot at all, these fields are omitted and the caller must
       * fail closed.
       */
      status: "expired";
      element?: AntigenSnapshotElementRecord;
      snapshot_url?: string | null;
      snapshot_id?: string;
    }
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
  if (isAntigenSnapshotExpired(stored.snapshot, now)) {
    // TTL-expired but not yet GC'd: carry the element (when the ref is still in
    // the snapshot) so a flag-gated recovery can re-validate against the live
    // page. Time alone never authorizes the action — the safety stack does.
    const expiredElement = stored.elementsByRef.get(ref);
    if (!expiredElement) return { status: "expired" };
    return {
      status: "expired",
      element: expiredElement,
      snapshot_url: stored.snapshot.url,
      snapshot_id: stored.snapshot.snapshot_id,
    };
  }

  const element = stored.elementsByRef.get(ref);
  if (!element) return { status: "ref_not_found" };
  return {
    status: "ok",
    element,
    snapshot_url: stored.snapshot.url,
    snapshot_id: stored.snapshot.snapshot_id,
  };
}

/**
 * Extends the lease on a snapshot and all its elements by another full TTL
 * window from `now`. Called ONLY after an expired ref has been semantically
 * re-validated and its action successfully dispatched (flag-gated), so an
 * actively-used ref in a live flow stays alive while idle refs still GC at the
 * TTL. Never resurrects a ref that failed validation — the caller gates on a
 * successful realistic* result before invoking this. Returns false when the
 * snapshot is absent or owned by another user.
 */
export function refreshAntigenSnapshotLease(
  snapshotId: string,
  userId: string,
  now?: Date,
): boolean {
  const stored = snapshots.get(snapshotId);
  if (!stored || stored.snapshot.user_id !== userId) return false;
  const expiresAt = new Date(
    (now ?? new Date()).getTime() + ANTIGEN_SNAPSHOT_TTL_MS,
  ).toISOString();
  stored.snapshot.expires_at = expiresAt;
  for (const element of stored.elementsByRef.values()) {
    element.expires_at = expiresAt;
  }
  return true;
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
  // Agent-facing current-value metadata. SENSITIVE BOUNDARY: when the field is
  // sensitive, only present/length/flags are emitted — never text, selected
  // value/text, or validation message (those would echo a credential value).
  const vm = el.value_meta;
  if (vm) {
    const sensitive = vm.sensitive === true;
    const value: NonNullable<ExternalAntigenSnapshotElement["value"]> = { sensitive };
    if (typeof vm.value_present === "boolean") value.present = vm.value_present;
    if (typeof vm.value_length === "number") value.length = vm.value_length;
    if (vm.value_placeholder_only === true) value.placeholder_only = true;
    if (typeof vm.checked === "boolean") value.checked = vm.checked;
    if (vm.required === true) value.required = true;
    if (vm.readonly === true) value.readonly = true;
    if (vm.aria_invalid === true) value.invalid = true;
    if (!sensitive) {
      if (typeof vm.value === "string") value.text = vm.value;
      if (typeof vm.selected_value === "string") value.selected_value = vm.selected_value;
      if (typeof vm.selected_text === "string") value.selected_text = vm.selected_text;
      if (typeof vm.validation_message === "string") value.validation_message = vm.validation_message;
    }
    out.value = value;
  }
  // Active-overlay membership. SAFETY: only real memberships are surfaced —
  // background-behind-modal markers (`background`) are dropped, and the internal
  // ranking flags `in_inert`/`bg_hidden` never reach the agent. `modal_title` is
  // accessible-name-derived and value-free by construction.
  const ov = el.overlay;
  if (ov && ov.background !== true) {
    const overlay: NonNullable<ExternalAntigenSnapshotElement["overlay"]> = {
      overlay_type: ov.overlay_type,
      blocking: ov.blocking === true,
    };
    if (typeof ov.modal_title === "string" && ov.modal_title) overlay.modal_title = ov.modal_title;
    if (ov.is_dismiss === true) overlay.is_dismiss = true;
    // Human-verification classification (flag-gated so flag-off output is
    // byte-identical). `hv_control` is targeting metadata and NEVER copied.
    if (isHumanVerificationEnabled() && ov.human_verification === true) {
      overlay.human_verification = true;
      overlay.hv_challenge_type = ov.hv_challenge_type ?? "unknown_human_verification";
    }
    out.overlay = overlay;
  }
  return out;
}

// ─── Test support ────────────────────────────────────────────────────────────

export function clearAntigenSnapshotStoreForTests(): void {
  snapshots.clear();
}
