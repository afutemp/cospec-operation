import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { ArtifactState, CollectorState } from "./types.js";

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

interface ManifestArtifact { kind?: string; role?: string; path?: string; sha256?: string; size_bytes?: number }
interface ManifestAttempt { attempt_id?: string; status?: string; recorded_at?: string; artifacts?: ManifestArtifact[] }

export async function syncManifestArtifacts(state: CollectorState, runId: string, manifestPath: string, stateDirectory: string): Promise<{ queued: number; known: number; rejected: number }> {
  if (!state.runs[runId]) throw new Error("run_not_found");
  let manifest: any;
  try { manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8")); }
  catch { throw new Error("artifact_manifest_unreadable"); }
  if (manifest?.run_id !== runId || !manifest.products || typeof manifest.products !== "object") throw new Error("artifact_manifest_invalid");
  state.artifacts ??= {};
  let queued = 0; let known = 0; let rejected = 0;
  for (const [skill, product] of Object.entries(manifest.products as Record<string, any>)) {
    for (const attempt of (product?.attempts ?? []) as ManifestAttempt[]) {
      if (attempt.status !== "done" || !attempt.attempt_id || !Array.isArray(attempt.artifacts)) continue;
      for (let index = 0; index < attempt.artifacts.length; index += 1) {
        const artifact: ManifestArtifact = attempt.artifacts[index]!;
        if (artifact.kind !== "file" || !artifact.path || !artifact.sha256) continue;
        const key = `${runId}:${skill}:${attempt.attempt_id}:${index}:${artifact.sha256}`;
        const existing = state.artifacts[key];
        if (existing && existing.status !== "rejected") { known += 1; continue; }
        if (existing && ["artifact_too_large", "artifact_size_invalid"].includes(existing.error ?? "")) { known += 1; continue; }
        const metadata = {
          schema_version: "0.1.0" as const, upload_id: randomUUID(), cospec_run_id: runId,
          skill, attempt_id: attempt.attempt_id, artifact_index: index, artifact_role: artifact.role ?? product.role ?? "unknown",
          file_name: basename(artifact.path), logical_path: logicalPath(manifest.cwd, artifact.path, skill), content_type: contentType(artifact.path),
          size_bytes: Number(artifact.size_bytes), sha256: artifact.sha256,
          created_at: validDate(attempt.recorded_at) ? attempt.recorded_at! : new Date().toISOString(),
        };
        const rejectedState = (error: string): ArtifactState => ({ key, metadata, spoolPath: "", status: "rejected", error });
        if (!Number.isSafeInteger(metadata.size_bytes) || metadata.size_bytes <= 0 || metadata.size_bytes > MAX_ARTIFACT_BYTES) {
          state.artifacts[key] = rejectedState(metadata.size_bytes > MAX_ARTIFACT_BYTES ? "artifact_too_large" : "artifact_size_invalid"); rejected += 1; continue;
        }
        try {
          const info = await lstat(artifact.path);
          if (!info.isFile() || info.size !== metadata.size_bytes) throw new Error("artifact_changed");
          const bytes = await readFile(artifact.path);
          if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw new Error("artifact_changed");
          const spoolPath = join(stateDirectory, "artifact-spool", `${metadata.sha256}.bin`);
          await writeSpool(spoolPath, bytes);
          state.artifacts[key] = { key, metadata, spoolPath, status: "pending" };
          queued += 1;
        } catch (error) {
          state.artifacts[key] = rejectedState(error instanceof Error && error.message === "artifact_changed" ? "artifact_changed" : "artifact_unreadable"); rejected += 1;
        }
      }
    }
  }
  return { queued, known, rejected };
}

async function writeSpool(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = await readFile(path);
    if (createHash("sha256").update(existing).digest("hex") !== createHash("sha256").update(bytes).digest("hex")) throw new Error("artifact_spool_conflict");
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function contentType(path: string): string {
  return ({ ".md": "text/markdown", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".json": "application/json" } as Record<string, string>)[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function logicalPath(cwd: unknown, path: string, skill: string): string {
  if (typeof cwd === "string") {
    const candidate = relative(resolve(cwd), resolve(path)).split(sep).join("/");
    if (candidate.startsWith("outputs/") && !candidate.split("/").includes("..")) return candidate;
  }
  return `outputs/${skill}/${basename(path)}`;
}

function validDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
