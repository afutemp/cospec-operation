import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChunkMetadata } from "../collector/types.js";
import { DurableChunkRepository } from "./durable-repository.js";
import { parseCodexJsonl } from "./parser.js";
import { ParserRegistry } from "./parser-registry.js";
import { ParserWorker } from "./parser-worker.js";
import { ReplayService } from "./replay.js";

test("Run replay switches atomically on completed_with_errors and keeps old version on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-replay-"));
  const repository = await DurableChunkRepository.open(root);
  const runId = randomUUID();
  const first = Buffer.from('{"type":"event_msg"}\n');
  const second = Buffer.from('{"broken":\n');
  const firstMetadata = metadata(first, runId, 100, null);
  await repository.accept(firstMetadata, first);
  await repository.accept(metadata(second, runId, firstMetadata.file.end_offset, firstMetadata.file.sha256, firstMetadata.file.source_file_id), second);
  await new ParserWorker(repository).runPending();
  assert.equal(repository.activeParserVersion(runId), "0.5.1");

  const successRegistry = new ParserRegistry({ "0.6.0": (bytes) => parseCodexJsonl(bytes, "0.6.0") });
  const service = new ReplayService(repository, successRegistry);
  const completed = await service.replayRun(runId, "0.6.0");
  assert.equal(completed.status, "completed");
  assert.equal(repository.activeParserVersion(runId), "0.6.0");
  assert.deepEqual(await service.replayRun(runId, "0.6.0"), completed);

  let attempts = 0;
  const failureRegistry = new ParserRegistry({ "0.7.0": (bytes) => {
    attempts += 1;
    if (attempts === 2) throw new Error("parser_failed");
    return parseCodexJsonl(bytes, "0.7.0");
  } });
  const failed = await new ReplayService(repository, failureRegistry).replayRun(runId, "0.7.0");
  assert.equal(failed.status, "failed");
  assert.equal(failed.completed_chunks, 1);
  assert.equal(repository.activeParserVersion(runId), "0.6.0");
  assert.deepEqual(await new ReplayService(repository, failureRegistry).replayRun(runId, "0.7.0"), failed);
  assert.equal(attempts, 2);
  await assert.rejects(new ReplayService(repository, new ParserRegistry()).replayRun(runId, "9.9.9"), /parser_version_not_installed/);
  repository.close();
});

function metadata(bytes: Buffer, runId: string, start: number, previous: string | null, sourceFileId: string = randomUUID()): ChunkMetadata {
  const now = new Date().toISOString();
  return {
    schema_version: "0.1.0", upload_id: randomUUID(), cospec_run_id: runId,
    source_type: "codex_jsonl", source_version: "0.150.1", agent_session_id: randomUUID(), collected_at: now, collector_version: "0.1.0",
    file: { source_file_id: sourceFileId, generation: 1, path_hint: "x.jsonl", start_offset: start,
      end_offset: start + bytes.length, byte_count: bytes.length, line_count: 1,
      sha256: createHash("sha256").update(bytes).digest("hex"), previous_chunk_sha256: previous, ends_with_newline: true },
    environment: { captured_at: now, agent_type: "codex", agent_version: "0.150.1", os_platform: "linux", os_arch: "x64", cospec_plugin_version: "1", timezone: "UTC" },
  };
}
