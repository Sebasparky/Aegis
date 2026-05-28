import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Config ───────────────────────────────────────────────────────────────────

function getProfilesBaseDir(): string {
  return process.env.AEGIS_BROWSER_PROFILES_DIR ?? join(homedir(), ".aegis", "browser-profiles");
}

// ─── Profile key derivation ───────────────────────────────────────────────────

/**
 * Derives a stable, opaque 16-hex-char key from (userId, delegationId?).
 * The key never appears in agent responses — it is used only for filesystem paths.
 * Same inputs always produce the same key. Different scopes produce different keys.
 * Without delegationId, produces a stable user-scoped key.
 */
export function computeProfileKey(userId: string, delegationId?: string): string {
  const input = delegationId ? `${userId}:${delegationId}` : userId;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * Returns the absolute path for a persistent profile directory given a profile key.
 * Format: $AEGIS_BROWSER_PROFILES_DIR/<profileKey>
 */
export function getPersistentProfileDir(profileKey: string): string {
  return join(getProfilesBaseDir(), profileKey);
}

// ─── Existence check ──────────────────────────────────────────────────────────

/** Returns true if a persistent profile directory already exists for the given key. */
export function persistentProfileExists(profileKey: string): boolean {
  return existsSync(getPersistentProfileDir(profileKey));
}

// ─── Directory creation ───────────────────────────────────────────────────────

/**
 * Ensures the persistent profile directory and its Default/ subdirectory exist.
 * Idempotent. Returns the profile root path.
 * Creates Default/ so launchChrome's Preferences write works without an extra mkdir.
 */
export function ensurePersistentProfileDir(profileKey: string): string {
  const dir = getPersistentProfileDir(profileKey);
  mkdirSync(join(dir, "Default"), { recursive: true });
  return dir;
}
