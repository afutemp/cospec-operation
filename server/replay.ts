import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DurableChunkRepository } from "./durable-repository.js";
import { ParserRegistry } from "./parser-registry.js";

export class ReplayService {
  private readonly inflight = new Map<string, Promise<Record<string, unknown>>>();
  constructor(private readonly repository: DurableChunkRepository, private readonly registry: ParserRegistry) {}

  async replayRun(runId: string, targetVersion: string): Promise<Record<string, unknown>> {
    const key = `${runId}:${targetVersion}`;
    const current = this.inflight.get(key);
    if (current) return current;
    const work = this.replayInternal(runId, targetVersion).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private async replayInternal(runId: string, targetVersion: string): Promise<Record<string, unknown>> {
    const parser = this.registry.get(targetVersion);
    const chunks = this.repository.runChunks(runId);
    const existing = this.repository.replayJob(runId, targetVersion);
    if (existing) return existing;
    const job = this.repository.startReplay(runId, targetVersion, chunks.length);
    const jobId = String(job.job_id);
    if (chunks.length === 0) {
      this.repository.failReplay(jobId, 0, "run_not_found");
      return this.repository.replayJob(runId, targetVersion)!;
    }
    let completed = 0;
    try {
      for (const chunk of chunks) {
        const bytes = await readFile(chunk.rawPath);
        if (createHash("sha256").update(bytes).digest("hex") !== chunk.sha256) throw new Error("raw_hash_mismatch");
        const result = parser(bytes, chunk.sourceType);
        if (result.status !== "completed" && result.status !== "completed_with_errors") throw new Error("parser_failed");
        this.repository.saveReplayResult(chunk.uploadId, result);
        completed += 1;
      }
      this.repository.completeReplay(jobId, runId, targetVersion, completed);
    } catch (error) {
      const code = error instanceof Error ? error.message : "replay_failed";
      this.repository.failReplay(jobId, completed, code);
    }
    return this.repository.replayJob(runId, targetVersion)!;
  }
}
