import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, join } from "node:path";
import { readNextChunk } from "./chunk.js";
import { JsonStateStore } from "./state.js";
import type { ChunkMetadata, CollectorState, FileState, RunBinding } from "./types.js";

export interface ChunkReceiver { accept(metadata: ChunkMetadata, bytes: Buffer): Promise<void> }

export class FileOutboxReceiver implements ChunkReceiver {
  constructor(private readonly directory: string) {}
  async accept(metadata: ChunkMetadata, bytes: Buffer): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const base = `${metadata.file.source_file_id}-${metadata.file.generation}-${metadata.file.start_offset}-${metadata.file.end_offset}`;
    const dataPath = join(this.directory, `${base}.jsonl`);
    const metadataPath = join(this.directory, `${base}.metadata.json`);
    await atomicWrite(dataPath, bytes);
    await atomicWrite(metadataPath, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));
  }
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
}

export class CollectorScanner {
  constructor(private readonly store: JsonStateStore, private readonly receiver: ChunkReceiver) {}

  async scan(): Promise<{ chunks: number; bytes: number }> {
    const state = await this.store.load();
    let chunks = 0;
    let bytes = 0;
    for (const file of Object.values(state.files)) {
      const run = collectibleRun(state, file);
      if (!run) continue;
      const info = await stat(file.canonicalPath, { bigint: true });
      const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}`;
      if (identity !== file.observedFileIdentity || BigInt(file.confirmedOffset) > info.size) {
        const code = identity !== file.observedFileIdentity ? "source_rotated" : "source_truncated";
        resetGeneration(file, identity, code);
        await this.store.save(state);
      }
      while (true) {
        const maximumEnd = run.status === "open" ? undefined : run.endOffset ?? undefined;
        if (maximumEnd !== undefined && file.confirmedOffset >= maximumEnd) break;
        const chunk = await readNextChunk(file.canonicalPath, file.confirmedOffset, maximumEnd);
        if (!chunk) break;
        const metadata = file.pendingUpload ?? metadataFor(file, run, chunk);
        if (metadata.file.start_offset !== chunk.startOffset || metadata.file.end_offset !== chunk.endOffset || metadata.file.sha256 !== chunk.sha256) {
          throw new Error("source_changed_during_retry");
        }
        if (!file.pendingUpload) {
          file.pendingUpload = metadata;
          await this.store.save(state);
        }
        await this.receiver.accept(metadata, chunk.bytes);
        file.confirmedOffset = chunk.endOffset;
        file.previousChunkSha256 = chunk.sha256;
        file.pendingUpload = null;
        await this.store.save(state);
        chunks += 1;
        bytes += chunk.byteCount;
      }
    }
    return { chunks, bytes };
  }
}

function resetGeneration(file: FileState, identity: string, code: "source_truncated" | "source_rotated"): void {
  file.generation += 1;
  file.confirmedOffset = 0;
  file.previousChunkSha256 = null;
  file.observedFileIdentity = identity;
  file.pendingUpload = null;
  file.lastDiagnostic = { code, observedAt: new Date().toISOString() };
}

function metadataFor(file: FileState, run: RunBinding, chunk: Awaited<ReturnType<typeof readNextChunk>> & {}): ChunkMetadata {
  const now = new Date().toISOString();
  return {
    schema_version: "0.1.0", upload_id: randomUUID(), cospec_run_id: run.cospecRunId, source_type: "codex_jsonl",
    source_version: file.sourceVersion, agent_session_id: file.agentSessionId,
    collected_at: now, collector_version: "0.1.0",
    file: {
      source_file_id: file.sourceFileId, generation: file.generation,
      path_hint: basename(file.canonicalPath), start_offset: chunk.startOffset,
      end_offset: chunk.endOffset, byte_count: chunk.byteCount, line_count: chunk.lineCount,
      sha256: chunk.sha256, previous_chunk_sha256: file.previousChunkSha256, ends_with_newline: true,
    },
    environment: {
      captured_at: now, agent_type: "codex", agent_version: file.sourceVersion,
      os_platform: supportedPlatform(), os_arch: arch(),
      cospec_plugin_version: process.env.COSPEC_PLUGIN_VERSION ?? "unknown",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    },
  };
}

function collectibleRun(state: CollectorState, file: FileState): RunBinding | undefined {
  return Object.values(state.runs).find((run) => {
    if (run.sourceFileId !== file.sourceFileId) return false;
    if (run.status === "open") return true;
    return run.endOffset !== null && file.confirmedOffset < run.endOffset;
  });
}

function supportedPlatform(): "linux" | "darwin" | "win32" {
  const value = platform();
  if (value === "linux" || value === "darwin" || value === "win32") return value;
  throw new Error(`unsupported_platform:${value}`);
}
