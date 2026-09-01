import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChunkMetadata } from "../collector/types.js";
import { DurableChunkRepository } from "./durable-repository.js";
import { parseClaudeCodeJsonl, parseCodexJsonl } from "./parser.js";
import { ParserWorker } from "./parser-worker.js";

test("minimal parser counts valid, invalid and unknown records without retaining content", () => {
  const first = `${JSON.stringify({ type: "event_msg", timestamp: "2026-09-01T01:00:00Z", payload: { secret: "not retained" } })}\n`;
  const invalid = '{"broken":\n';
  const unknown = `${JSON.stringify({ type: "future_record", timestamp: "2026-09-01T02:00:00Z" })}\n`;
  const result = parseCodexJsonl(Buffer.from(first + invalid + unknown));
  assert.equal(result.status, "completed_with_errors");
  assert.deepEqual({ total: result.totalLines, valid: result.validLines, invalid: result.invalidLines, unknown: result.unknownTypeLines },
    { total: 3, valid: 2, invalid: 1, unknown: 1 });
  assert.deepEqual(result.typeCounts, { event_msg: 1, future_record: 1 });
  assert.equal(result.firstTimestamp, "2026-09-01T01:00:00Z");
  assert.equal(result.lastTimestamp, "2026-09-01T02:00:00Z");
  assert.deepEqual(result.diagnostics, [{ line: 2, byteOffset: Buffer.byteLength(first), code: "invalid_json" }]);
  assert.equal(JSON.stringify(result).includes("not retained"), false);
});

test("Claude Code parser recognizes current control and message types without retaining content", () => {
  const bytes = Buffer.from([
    JSON.stringify({ type: "queue-operation", sessionId: "session", content: "not retained" }),
    JSON.stringify({ type: "user", sessionId: "session", version: "2.1.220", timestamp: "2026-09-01T01:00:00Z", message: { content: "private" } }),
    JSON.stringify({ type: "assistant", sessionId: "session", version: "2.1.220", timestamp: "2026-09-01T01:00:01Z" }),
    JSON.stringify({ type: "future-claude-type", sessionId: "session" }),
  ].join("\n") + "\n");
  const result = parseClaudeCodeJsonl(bytes);
  assert.equal(result.validLines, 4);
  assert.equal(result.unknownTypeLines, 1);
  assert.deepEqual(result.typeCounts, { "queue-operation": 1, user: 1, assistant: 1, "future-claude-type": 1 });
  assert.equal(result.firstTimestamp, "2026-09-01T01:00:00Z");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("worker persists versioned result and remains idempotent across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-parser-worker-"));
  const bytes = Buffer.from('{"type":"event_msg","timestamp":"2026-09-01T00:00:00Z"}\n{"bad":\n');
  const value = metadata(bytes);
  let repository = await DurableChunkRepository.open(root);
  await repository.accept(value, bytes);
  assert.deepEqual(await new ParserWorker(repository).runPending(), { completed: 1, failed: 0 });
  assert.equal(repository.pendingChunks().length, 0);
  assert.equal(repository.parseResultCount(), 1);
  const row = repository.parseResults()[0]!;
  assert.equal(row.status, "completed_with_errors");
  assert.equal(row.total_lines, 2);
  assert.equal(String(row.diagnostics_json).includes("bad"), false);
  repository.close();

  repository = await DurableChunkRepository.open(root);
  assert.deepEqual(await new ParserWorker(repository).runPending(), { completed: 0, failed: 0 });
  assert.equal(repository.parseResultCount(), 1);
  repository.close();
});

test("worker marks a modified immutable raw block as failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-parser-hash-"));
  const bytes = Buffer.from('{"type":"event_msg"}\n');
  const repository = await DurableChunkRepository.open(root);
  await repository.accept(metadata(bytes), bytes);
  const pending = repository.pendingChunks()[0]!;
  await writeFile(pending.rawPath, '{"tampered":true}\n');
  assert.deepEqual(await new ParserWorker(repository).runPending(), { completed: 0, failed: 1 });
  assert.equal(repository.parseResults()[0]?.status, "failed");
  assert.match(String(repository.parseResults()[0]?.diagnostics_json), /raw_hash_mismatch/);
  repository.close();
});

function metadata(bytes: Buffer): ChunkMetadata {
  const now = new Date().toISOString();
  return {
    schema_version: "0.1.0", upload_id: randomUUID(), cospec_run_id: randomUUID(),
    source_type: "codex_jsonl", source_version: "0.150.1", agent_session_id: randomUUID(),
    collected_at: now, collector_version: "0.1.0",
    file: {
      source_file_id: randomUUID(), generation: 1, path_hint: "redacted.jsonl",
      start_offset: 100, end_offset: 100 + bytes.length, byte_count: bytes.length,
      line_count: bytes.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0),
      sha256: createHash("sha256").update(bytes).digest("hex"), previous_chunk_sha256: null, ends_with_newline: true,
    },
    environment: {
      captured_at: now, agent_type: "codex", agent_version: "0.150.1", os_platform: "linux", os_arch: "x64",
      cospec_plugin_version: "1.1.79", timezone: "UTC",
    },
  };
}
