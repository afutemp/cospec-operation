import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DurableChunkRepository } from "./durable-repository.js";
import { PARSER_VERSION, parseSourceJsonl } from "./parser.js";

export class ParserWorker {
  constructor(private readonly repository: DurableChunkRepository) {}

  async runPending(): Promise<{ completed: number; failed: number }> {
    let completed = 0;
    let failed = 0;
    const touchedRuns = new Set<string>();
    for (const chunk of this.repository.pendingChunks()) {
      touchedRuns.add(chunk.runId);
      try {
        const bytes = await readFile(chunk.rawPath);
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (hash !== chunk.sha256) throw new ParseInfrastructureError("raw_hash_mismatch");
        this.repository.saveParseResult(chunk.uploadId, parseSourceJsonl(bytes, chunk.sourceType));
        completed += 1;
      } catch (error) {
        const code = error instanceof ParseInfrastructureError
          ? error.message
          : (error as NodeJS.ErrnoException).code === "ENOENT" ? "raw_file_missing" : "raw_read_failed";
        this.repository.saveParseFailure(chunk.uploadId, PARSER_VERSION, code);
        failed += 1;
      }
    }
    for (const runId of touchedRuns) this.repository.activateRunIfFullyParsed(runId, PARSER_VERSION);
    return { completed, failed };
  }
}

class ParseInfrastructureError extends Error {}
