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
    JSON.stringify({ type: "assistant", sessionId: "session", version: "2.1.220", timestamp: "2026-09-01T01:00:01Z",
      message: { role: "assistant", model: "claude-test", usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { secret: "private" } }] } }),
    JSON.stringify({ type: "user", sessionId: "session", timestamp: "2026-09-01T01:00:02Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: true, content: "private output" }] } }),
    JSON.stringify({ type: "future-claude-type", sessionId: "session" }),
  ].join("\n") + "\n");
  const result = parseClaudeCodeJsonl(bytes);
  assert.equal(result.validLines, 5);
  assert.equal(result.unknownTypeLines, 1);
  assert.deepEqual(result.typeCounts, { "queue-operation": 1, user: 2, assistant: 1, "future-claude-type": 1 });
  assert.equal(result.firstTimestamp, "2026-09-01T01:00:00Z");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(result.messageFacts.map((fact) => fact.role), ["user", "assistant", "user"]);
  assert.deepEqual(result.tokenUsageFacts[0], { recordIndex: 3, timestamp: "2026-09-01T01:00:01Z", model: "claude-test",
    inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 4, cacheWriteOrCreationInputTokens: 2,
    reasoningOutputTokens: null, reportedTotalTokens: null });
  assert.deepEqual(result.toolCallFacts[0], { recordIndex: 3, itemIndex: 0, timestamp: "2026-09-01T01:00:01Z", callId: "tool-1", toolName: "Read" });
  assert.deepEqual(result.toolResultFacts[0], { recordIndex: 4, itemIndex: 0, timestamp: "2026-09-01T01:00:02Z", callId: "tool-1", status: "failure", failureCode: "explicit_is_error" });
});

test("Codex facts retain resource metadata and only direct tool failure evidence", () => {
  const bytes = Buffer.from([
    JSON.stringify({ type: "response_item", timestamp: "2026-09-01T01:00:00Z", payload: { type: "message", role: "user", content: "private" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-09-01T01:00:01Z", payload: { type: "token_count", info: { last_token_usage: {
      input_tokens: 20, output_tokens: 5, cached_input_tokens: 7, cache_write_input_tokens: 1, reasoning_output_tokens: 2, total_tokens: 25 } } } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-09-01T01:00:02Z", payload: { type: "custom_tool_call", call_id: "call-1", name: "exec", input: "private args" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-09-01T01:00:03Z", payload: { type: "custom_tool_call_output", call_id: "call-1", output: [{ exit_code: 2, output: "private output" }] } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-09-01T01:00:04Z", payload: { type: "custom_tool_call_output", call_id: "call-unknown", output: "unstructured private" } }),
  ].join("\n") + "\n");
  const result = parseCodexJsonl(bytes);
  assert.equal(result.messageFacts.length, 1);
  assert.equal(result.tokenUsageFacts[0]?.reportedTotalTokens, 25);
  assert.equal(result.toolCallFacts[0]?.toolName, "exec");
  assert.deepEqual(result.toolResultFacts.map((fact) => fact.status), ["failure", "unknown"]);
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

test("worker persists versioned facts and exposes Run-level metric inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-parser-facts-"));
  const bytes = Buffer.from([
    JSON.stringify({ type: "assistant", timestamp: "2026-09-01T01:00:00Z", message: { role: "assistant", model: "claude-test",
      usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 3 }, content: [
        { type: "tool_use", id: "tool-1", name: "Bash", input: "private" },
        { type: "tool_use", id: "tool-without-result", name: "Read", input: "private" },
      ] } }),
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:00:01Z", message: { role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: false, content: "private" }] } }),
  ].join("\n") + "\n");
  const value = metadata(bytes);
  value.source_type = "claude_code_jsonl";
  value.source_version = "2.1.220";
  value.environment.agent_type = "claude_code";
  value.environment.agent_version = "2.1.220";
  const repository = await DurableChunkRepository.open(root);
  await repository.accept(value, bytes);
  await new ParserWorker(repository).runPending();
  const facts = repository.getRunFacts(value.cospec_run_id)! as {
    messages: { total: number; byRole: Record<string, number> };
    tokens: Record<string, number | null>; tools: Record<string, number | null>;
    attribution: { skill: string }; interval: { semantics: string };
  };
  assert.deepEqual(facts.messages, { total: 2, byRole: { assistant: 1, user: 1 } });
  assert.equal(facts.tokens.input_tokens, 11);
  assert.equal(facts.tokens.cache_read_input_tokens, 3);
  assert.equal(facts.tokens.reported_total_tokens, null);
  assert.deepEqual(facts.tools, { calls: 2, successes: 1, failures: 0, determined_results: 1, unknown_results: 1, status_coverage: 0.5,
    byTool: {
      Bash: { calls: 1, successes: 1, failures: 0, unknown_results: 0, determined_results: 1, status_coverage: 1 },
      Read: { calls: 1, successes: 0, failures: 0, unknown_results: 1, determined_results: 0, status_coverage: 0 },
    } });
  assert.equal(facts.attribution.skill, "unavailable");
  assert.equal(facts.interval.semantics, "host_record_span");
  assert.equal(JSON.stringify(facts).includes("private"), false);
  repository.close();
});

test("Run facts pair tool calls and direct failures across raw chunk boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-cross-chunk-facts-"));
  const runId = randomUUID();
  const sourceFileId = randomUUID();
  const firstBytes = Buffer.from(`${JSON.stringify({ type: "assistant", timestamp: "2026-09-01T01:00:00Z",
    message: { role: "assistant", content: [{ type: "tool_use", id: "cross-call", name: "Bash", input: "private" }] } })}\n`);
  const first = metadata(firstBytes, runId, 100, null, sourceFileId);
  first.source_type = "claude_code_jsonl"; first.environment.agent_type = "claude_code";
  const secondBytes = Buffer.from(`${JSON.stringify({ type: "user", timestamp: "2026-09-01T01:00:01Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "cross-call", is_error: true, content: "private" }] } })}\n`);
  const second = metadata(secondBytes, runId, first.file.end_offset, first.file.sha256, sourceFileId);
  second.source_type = "claude_code_jsonl"; second.environment.agent_type = "claude_code";
  const repository = await DurableChunkRepository.open(root);
  await repository.accept(first, firstBytes);
  await repository.accept(second, secondBytes);
  await new ParserWorker(repository).runPending();
  const tools = (repository.getRunFacts(runId) as { tools: { byTool: Record<string, Record<string, number>> } }).tools;
  assert.deepEqual(tools.byTool.Bash, { calls: 1, successes: 0, failures: 1, unknown_results: 0, determined_results: 1, status_coverage: 1 });
  assert.equal(JSON.stringify(repository.getRunFacts(runId)).includes("private"), false);
  repository.close();
});

function metadata(bytes: Buffer, runId = randomUUID(), startOffset = 100, previousHash: string | null = null, sourceFileId = randomUUID()): ChunkMetadata {
  const now = new Date().toISOString();
  return {
    schema_version: "0.1.0", upload_id: randomUUID(), cospec_run_id: runId,
    source_type: "codex_jsonl", source_version: "0.150.1", agent_session_id: randomUUID(),
    collected_at: now, collector_version: "0.1.0",
    file: {
      source_file_id: sourceFileId, generation: 1, path_hint: "redacted.jsonl",
      start_offset: startOffset, end_offset: startOffset + bytes.length, byte_count: bytes.length,
      line_count: bytes.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0),
      sha256: createHash("sha256").update(bytes).digest("hex"), previous_chunk_sha256: previousHash, ends_with_newline: true,
    },
    environment: {
      captured_at: now, agent_type: "codex", agent_version: "0.150.1", os_platform: "linux", os_arch: "x64",
      cospec_plugin_version: "1.1.79", timezone: "UTC",
    },
  };
}
