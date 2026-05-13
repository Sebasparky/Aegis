import { mkdirSync, unlinkSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

export const ARTIFACTS_DIR = join(dirname(__filename), "../../.aegis-artifacts/workspaces");

export const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/plain",
  "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export const ALLOWED_EXTENSIONS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".txt", ".csv", ".json", ".docx",
]);

export const FILE_MAX_BYTES = 10 * 1024 * 1024; // 10MB

export function sanitizeFilename(raw: string): string {
  const cleaned = raw
    .replace(/[/\\]/g, "_")
    .replace(/\0/g, "")
    .replace(/^\.+/, "")
    .replace(/[^\w.\-]/g, "_")
    .slice(0, 200)
    .trim();
  if (!cleaned) throw new Error("Invalid filename");
  return cleaned;
}

export function getArtifactFilePath(workspaceId: string, artifactId: string, safeFilename: string): string {
  return join(ARTIFACTS_DIR, workspaceId, `${artifactId}-${safeFilename}`);
}

export function ensureArtifactDir(workspaceId: string): void {
  mkdirSync(join(ARTIFACTS_DIR, workspaceId), { recursive: true });
}

export function deleteArtifactFile(localPath: string): void {
  try { unlinkSync(localPath); } catch { /* best-effort */ }
}

export function getFileExtension(filename: string): string {
  return extname(filename).toLowerCase();
}
