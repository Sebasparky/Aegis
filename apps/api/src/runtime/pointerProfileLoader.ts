import fs from "fs";
import path from "path";
import type { PointerTrace } from "./pointerTraceTemplates.js";

interface PointerProfile {
  traces: PointerTrace[];
}

const PROFILE_FILENAME =
  "dev-artifacts/pointer-traces/sebastian_pointer_profile_v1.json";

export function resolveProfilePath(): string | null {
  const envPath = process.env.ANTIGEN_POINTER_PROFILE_PATH;
  if (envPath !== undefined) {
    const trimmed = envPath.trim();
    if (trimmed === "" || trimmed === "false") return null;
    return trimmed;
  }
  // Try cwd directly, then two levels up (apps/api → repo root), then one level up.
  const candidates = [
    path.resolve(process.cwd(), PROFILE_FILENAME),
    path.resolve(process.cwd(), "../..", PROFILE_FILENAME),
    path.resolve(process.cwd(), "..", PROFILE_FILENAME),
  ];
  return (
    candidates.find((c) => {
      try {
        return fs.existsSync(c);
      } catch {
        return false;
      }
    }) ?? null
  );
}

export function loadPointerTraces(): PointerTrace[] {
  const filePath = resolveProfilePath();
  if (filePath === null) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PointerProfile;
    if (!Array.isArray(parsed?.traces)) return [];
    return parsed.traces;
  } catch {
    // File missing or invalid JSON — silent; Bézier fallback remains active.
    return [];
  }
}

const LOADED_TRACES: PointerTrace[] = loadPointerTraces();

if (
  process.env.ANTIGEN_CDP_DIAGNOSTICS === "true" ||
  process.env.ANTIGEN_POINTER_DEBUG_OVERLAY === "true"
) {
  const filePath = resolveProfilePath();
  const purposes = [...new Set(LOADED_TRACES.map((t) => t.purpose))];
  const distances = LOADED_TRACES.map((t) => t.distance_px);
  console.log("[PointerProfile] loaded", {
    enabled: LOADED_TRACES.length > 0,
    file_path: filePath ?? "(not found)",
    trace_count: LOADED_TRACES.length,
    purposes,
    distance_range:
      distances.length > 0
        ? { min: Math.min(...distances), max: Math.max(...distances) }
        : null,
  });
}

export function getLoadedPointerTraces(): PointerTrace[] {
  return LOADED_TRACES;
}
