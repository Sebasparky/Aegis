import fs from "fs";
import path from "path";
import type { PointerTrace } from "./pointerTraceTemplates.js";

interface PointerProfile {
  traces: PointerTrace[];
}

function loadPointerTraces(): PointerTrace[] {
  const envPath = process.env.ANTIGEN_POINTER_PROFILE_PATH;
  // Empty string → disabled; Bézier fallback remains active.
  if (envPath !== undefined && envPath.trim() === "") return [];
  const filePath =
    envPath ??
    path.resolve(
      process.cwd(),
      "dev-artifacts/pointer-traces/sebastian_pointer_profile_v1.json",
    );
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PointerProfile;
    if (!Array.isArray(parsed?.traces)) return [];
    return parsed.traces;
  } catch {
    // File missing or invalid — silent; Bézier fallback remains active.
    return [];
  }
}

const LOADED_TRACES: PointerTrace[] = loadPointerTraces();

export function getLoadedPointerTraces(): PointerTrace[] {
  return LOADED_TRACES;
}
