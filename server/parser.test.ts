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
    JSON.stringify({ type: "user", isMeta: true, sessionId: "session", timestamp: "2026-09-01T01:00:03Z",
      message: { role: "user", content: [{ type: "text", text: "private Skill instructions" }] } }),
    JSON.stringify({ type: "future-claude-type", sessionId: "session" }),
  ].join("\n") + "\n");
  const result = parseClaudeCodeJsonl(bytes);
  assert.equal(result.validLines, 6);
  assert.equal(result.unknownTypeLines, 1);
  assert.deepEqual(result.typeCounts, { "queue-operation": 1, user: 3, assistant: 1, "future-claude-type": 1 });
  assert.equal(result.firstTimestamp, "2026-09-01T01:00:00Z");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(result.messageFacts.map((fact) => fact.role), ["user", "assistant", "user", "user"]);
  assert.deepEqual(result.tokenUsageFacts[0], { recordIndex: 3, timestamp: "2026-09-01T01:00:01Z", model: "claude-test",
    inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 4, cacheWriteOrCreationInputTokens: 2,
    reasoningOutputTokens: null, reportedTotalTokens: null });
  assert.deepEqual(result.toolCallFacts[0], { recordIndex: 3, itemIndex: 0, timestamp: "2026-09-01T01:00:01Z", callId: "tool-1", toolName: "Read" });
  assert.deepEqual(result.toolResultFacts[0], { recordIndex: 4, itemIndex: 0, timestamp: "2026-09-01T01:00:02Z", callId: "tool-1", status: "failure", failureCode: "explicit_is_error" });
  assert.deepEqual(result.turnEventFacts, [
    { recordIndex: 2, itemIndex: 0, timestamp: "2026-09-01T01:00:00Z", kind: "user_prompt" },
  ]);
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
  assert.deepEqual(result.turnEventFacts, [
    { recordIndex: 1, itemIndex: 0, timestamp: "2026-09-01T01:00:00Z", kind: "user_prompt" },
  ]);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("Codex parser recognizes output_text as an Agent message boundary", () => {
  const result = parseCodexJsonl(Buffer.from([
    JSON.stringify({ type: "response_item", timestamp: "2026-09-01T01:00:10Z", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: "请确认" }] } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-09-01T01:01:10Z", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: "确认" }] } }),
  ].join("\n") + "\n"));
  assert.deepEqual(result.turnEventFacts, [
    { recordIndex: 1, itemIndex: 0, timestamp: "2026-09-01T01:00:10Z", kind: "agent_message" },
    { recordIndex: 2, itemIndex: 0, timestamp: "2026-09-01T01:01:10Z", kind: "user_prompt" },
  ]);
});

test("parsers extract only exact Skill markers from tool results", () => {
  const claude = parseClaudeCodeJsonl(Buffer.from([
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:00:00Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "start", is_error: false, content: "[COSPEC:SKILL:START:product-planning-requirement-clarification:a083c4d6]" },
    ] } }),
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:02:12.716Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "end", is_error: false, content: "prefix\n[COSPEC:SKILL:END:product-planning-requirement-clarification:a083c4d6:OK]\nsuffix" },
      { type: "tool_result", tool_use_id: "source", is_error: false, content: "return `[COSPEC:SKILL:START:${skill}:${id}]`;" },
    ] } }),
  ].join("\n") + "\n"));
  assert.deepEqual(claude.skillMarkerFacts, [
    { recordIndex: 1, itemIndex: 0, markerIndex: 0, timestamp: "2026-09-01T01:00:00Z", phase: "start", skill: "product-planning-requirement-clarification", executionId: "a083c4d6", status: null },
    { recordIndex: 2, itemIndex: 0, markerIndex: 0, timestamp: "2026-09-01T01:02:12.716Z", phase: "end", skill: "product-planning-requirement-clarification", executionId: "a083c4d6", status: "ok" },
  ]);
  assert.deepEqual(claude.turnEventFacts, []);

  const codex = parseCodexJsonl(Buffer.from([
    JSON.stringify({ type: "response_item", timestamp: "2026-09-01T02:00:00Z", payload: { type: "function_call_output", call_id: "one", output: { output: "[COSPEC:SKILL:START:user-journey-design:1234abcd]\n" } } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-09-01T02:01:00Z", payload: { type: "function_call_output", call_id: "two", output: [{ output: "[COSPEC:SKILL:END:user-journey-design:1234abcd:FAILED]" }] } }),
  ].join("\n") + "\n"));
  assert.deepEqual(codex.skillMarkerFacts.map(({ phase, skill, executionId, status }) => ({ phase, skill, executionId, status })), [
    { phase: "start", skill: "user-journey-design", executionId: "1234abcd", status: null },
    { phase: "end", skill: "user-journey-design", executionId: "1234abcd", status: "failed" },
  ]);
  assert.deepEqual(codex.turnEventFacts, []);
});

test("parsers extract compactions and only explicit context window limits", () => {
  const codex = parseCodexJsonl(Buffer.from([
    JSON.stringify({ type: "event_msg", timestamp: "2026-09-01T01:00:00Z", payload: { type: "token_count", info: {
      model_context_window: 258400, last_token_usage: { input_tokens: 10 } } } }),
    JSON.stringify({ type: "compacted", timestamp: "2026-09-01T01:00:01Z", payload: { message: "private" } }),
  ].join("\n") + "\n"));
  assert.deepEqual(codex.contextWindowFacts, [{ recordIndex: 1, timestamp: "2026-09-01T01:00:00Z", contextWindowTokens: 258400 }]);
  assert.deepEqual(codex.compactionFacts, [{ recordIndex: 2, timestamp: "2026-09-01T01:00:01Z", trigger: "unknown", preTokens: null, postTokens: null }]);

  const claude = parseClaudeCodeJsonl(Buffer.from([
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-09-01T02:00:00Z", compactMetadata: { trigger: "auto", preTokens: 229490, postTokens: 9493 } }),
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-09-01T03:00:00Z", compactMetadata: { trigger: "manual", preTokens: 575478, postTokens: 9301 } }),
    JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "private duplicate marker" } }),
  ].join("\n") + "\n"));
  assert.deepEqual(claude.compactionFacts, [
    { recordIndex: 1, timestamp: "2026-09-01T02:00:00Z", trigger: "auto", preTokens: 229490, postTokens: 9493 },
    { recordIndex: 2, timestamp: "2026-09-01T03:00:00Z", trigger: "manual", preTokens: 575478, postTokens: 9301 },
  ]);
  assert.deepEqual(claude.contextWindowFacts, []);
});

test("Run facts expose compaction counts and context limit availability", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-context-facts-"));
  const bytes = Buffer.from([
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { model_context_window: 258400 } } }),
    JSON.stringify({ type: "compacted", payload: {} }),
  ].join("\n") + "\n");
  const value = metadata(bytes);
  const repository = await DurableChunkRepository.open(root);
  await repository.accept(value, bytes);
  await new ParserWorker(repository).runPending();
  const context = (repository.getRunFacts(value.cospec_run_id) as { context: Record<string, any> }).context;
  assert.deepEqual(context.compactions, { total: 1, byTrigger: { auto: 0, manual: 0, unknown: 1 }, withTokenDelta: 0 });
  assert.deepEqual(context.window, { observed: true, latestTokens: 258400, observedValues: [258400], source: "jsonl_explicit_field" });
  repository.close();
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
    duration: { measured_calls: 1, unknown_calls: 1, invalid_intervals: 0, coverage: 0.5,
      accumulated_ms: 1000, wall_clock_ms: 1000, p50_ms: 1000, p90_ms: 1000, semantics: "call_to_result_timestamp" },
    byTool: {
      Bash: { calls: 1, successes: 1, failures: 0, unknown_results: 0, determined_results: 1, status_coverage: 1,
        duration: { measured_calls: 1, unknown_calls: 0, invalid_intervals: 0, coverage: 1,
          accumulated_ms: 1000, wall_clock_ms: 1000, p50_ms: 1000, p90_ms: 1000, semantics: "call_to_result_timestamp" } },
      Read: { calls: 1, successes: 0, failures: 0, unknown_results: 1, determined_results: 0, status_coverage: 0,
        duration: { measured_calls: 0, unknown_calls: 1, invalid_intervals: 0, coverage: 0,
          accumulated_ms: 0, wall_clock_ms: 0, p50_ms: null, p90_ms: null, semantics: "call_to_result_timestamp" } },
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
  const tools = (repository.getRunFacts(runId) as { tools: { byTool: Record<string, Record<string, unknown>> } }).tools;
  assert.deepEqual(tools.byTool.Bash, { calls: 1, successes: 0, failures: 1, unknown_results: 0, determined_results: 1, status_coverage: 1,
    duration: { measured_calls: 1, unknown_calls: 0, invalid_intervals: 0, coverage: 1,
      accumulated_ms: 1000, wall_clock_ms: 1000, p50_ms: 1000, p90_ms: 1000, semantics: "call_to_result_timestamp" } });
  assert.equal(JSON.stringify(repository.getRunFacts(runId)).includes("private"), false);
  repository.close();
});

test("Run facts pair Skill markers across chunks and keep incomplete executions visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-skill-duration-facts-"));
  const runId = randomUUID(); const sourceFileId = randomUUID();
  const firstBytes = Buffer.from([
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:00:00.000Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "one", is_error: false, content: "[COSPEC:SKILL:START:requirement:a083c4d6]" },
    ] } }),
  ].join("\n") + "\n");
  const first = metadata(firstBytes, runId, 0, null, sourceFileId);
  first.source_type = "claude_code_jsonl"; first.environment.agent_type = "claude_code";
  const secondBytes = Buffer.from([
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:02:12.716Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "two", is_error: false, content: "[COSPEC:SKILL:END:requirement:a083c4d6:OK]" },
    ] } }),
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:03:00.000Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "three", is_error: false, content: "[COSPEC:SKILL:START:journey:1234abcd]" },
    ] } }),
  ].join("\n") + "\n");
  const second = metadata(secondBytes, runId, first.file.end_offset, first.file.sha256, sourceFileId);
  second.source_type = "claude_code_jsonl"; second.environment.agent_type = "claude_code";
  const repository = await DurableChunkRepository.open(root);
  await repository.accept(first, firstBytes); await repository.accept(second, secondBytes);
  await new ParserWorker(repository).runPending();
  const facts = repository.getRunFacts(runId) as { attribution: { skill: string }; skills: Record<string, any> };
  assert.equal(facts.attribution.skill, "explicit_start_end_markers");
  assert.deepEqual({ executions: facts.skills.executions, completed: facts.skills.completed, open: facts.skills.open,
    measured: facts.skills.measured_executions, p50: facts.skills.p50_ms },
    { executions: 2, completed: 1, open: 1, measured: 1, p50: 132716 });
  assert.equal(facts.skills.bySkill.requirement.accumulated_ms, 132716);
  assert.deepEqual({ ...facts.skills.items[0], resources: undefined }, { skill: "requirement", executionId: "a083c4d6", status: "ok",
    startedAt: "2026-09-01T01:00:00.000Z", endedAt: "2026-09-01T01:02:12.716Z",
    durationMs: 132716, elapsedMs: 132716, waitingForUserMs: 0, waitingForUserCount: 0, resources: undefined });
  const summary = repository.getRunUsageSummary({}) as { skills: Record<string, any> };
  assert.equal(summary.skills.executions, 2);
  assert.equal(summary.skills.bySkill.requirement.p50_ms, 132716);
  assert.equal(summary.skills.bySkill.journey.open, 1);
  assert.equal(summary.skills.byDay["2026-09-01"].requirement, 1);
  assert.equal(summary.skills.unique_runs, 1);
  assert.equal(JSON.stringify(facts).includes("tool_use_id"), false);
  repository.close();
});

test("Skill active duration excludes only explicit human reply waits", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-skill-user-wait-"));
  const runId = randomUUID();
  const bytes = Buffer.from([
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:00:00.000Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "start", is_error: false, content: "[COSPEC:SKILL:START:requirement:a083c4d6]" },
    ] } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-09-01T01:00:10.000Z", message: { role: "assistant", content: [
      { type: "text", text: "请确认推荐选项" },
      { type: "tool_use", id: "question", name: "AskUserQuestion" },
    ] } }),
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:00:20.000Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "question", is_error: false, content: "tool result is not a human reply" },
    ] } }),
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:01:10.000Z", message: { role: "user", content: "采用推荐选项" } }),
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:01:20.000Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "end", is_error: false, content: "[COSPEC:SKILL:END:requirement:a083c4d6:OK]" },
    ] } }),
  ].join("\n") + "\n");
  const value = metadata(bytes, runId);
  value.source_type = "claude_code_jsonl"; value.environment.agent_type = "claude_code";
  const repository = await DurableChunkRepository.open(root);
  await repository.accept(value, bytes); await new ParserWorker(repository).runPending();
  const facts = repository.getRunFacts(runId) as { skills: Record<string, any> };
  assert.deepEqual({ ...facts.skills.items[0], resources: undefined }, { skill: "requirement", executionId: "a083c4d6", status: "ok",
    startedAt: "2026-09-01T01:00:00.000Z", endedAt: "2026-09-01T01:01:20.000Z",
    durationMs: 20000, elapsedMs: 80000, waitingForUserMs: 60000, waitingForUserCount: 1, resources: undefined });
  assert.equal(facts.skills.accumulated_ms, 20000);
  assert.equal(facts.skills.elapsed_accumulated_ms, 80000);
  assert.equal(facts.skills.waiting_for_user_accumulated_ms, 60000);
  assert.equal(facts.skills.waiting_for_user_interactions, 1);
  assert.equal(facts.skills.waiting_for_user_p50_ms, 60000);
  assert.equal(facts.skills.no_user_wait_rate, 0);
  repository.close();
});

test("structured Skill events provide intervals while JSONL provides waits and resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-structured-skill-events-"));
  const runId = randomUUID();
  const bytes = Buffer.from([
    JSON.stringify({ type: "assistant", timestamp: "2026-09-01T01:00:10.000Z", message: { role: "assistant", usage: { input_tokens: 10, output_tokens: 2 }, content: [
      { type: "text", text: "请确认" }, { type: "tool_use", id: "question", name: "AskUserQuestion" },
    ] } }),
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:00:20.000Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "question", is_error: false, content: "not a human reply" },
    ] } }),
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:01:10.000Z", message: { role: "user", content: "采用推荐选项" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-09-01T01:01:15.000Z", message: { role: "assistant", usage: { input_tokens: 5, output_tokens: 1 }, content: [] } }),
  ].join("\n") + "\n");
  const value = metadata(bytes, runId); value.source_type = "claude_code_jsonl"; value.environment.agent_type = "claude_code";
  const repository = await DurableChunkRepository.open(root);
  await repository.accept(value, bytes); await new ParserWorker(repository).runPending();
  repository.acceptRunEvent({ schema_version: "0.1.0", event_id: `${runId}:skill:start:1234abcd`, cospec_run_id: runId,
    event_type: "skill_started", occurred_at: "2026-09-01T01:00:00.000Z", skill: "requirement", execution_id: "1234abcd" });
  repository.acceptRunEvent({ schema_version: "0.1.0", event_id: `${runId}:skill:end:1234abcd`, cospec_run_id: runId,
    event_type: "skill_finished", occurred_at: "2026-09-01T01:01:20.000Z", skill: "requirement", execution_id: "1234abcd", status: "completed" });
  const facts = repository.getRunFacts(runId) as { attribution: { skill: string }; skills: Record<string, any> };
  assert.equal(facts.attribution.skill, "structured_skill_events");
  assert.deepEqual({ executions: facts.skills.executions, completed: facts.skills.completed, measured: facts.skills.measured_executions },
    { executions: 1, completed: 1, measured: 1 });
  assert.deepEqual({ durationMs: facts.skills.items[0].durationMs, elapsedMs: facts.skills.items[0].elapsedMs,
    waitingForUserMs: facts.skills.items[0].waitingForUserMs, inputTokens: facts.skills.items[0].resources.self.tokens.input_tokens },
    { durationMs: 20000, elapsedMs: 80000, waitingForUserMs: 60000, inputTokens: 15 });
  repository.close();
});

test("Skill resources expose inclusive and non-duplicated self attribution for nested Skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-nested-skill-resources-")); const runId = randomUUID();
  const marker = (timestamp: string, id: string, value: string) => JSON.stringify({ type: "user", timestamp,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: value }] } });
  const usage = (timestamp: string, input: number, output: number) => JSON.stringify({ type: "assistant", timestamp,
    message: { role: "assistant", usage: { input_tokens: input, output_tokens: output }, content: [] } });
  const bytes = Buffer.from([
    marker("2026-09-01T01:00:00Z", "p-start", "[COSPEC:SKILL:START:parent:11111111]"),
    usage("2026-09-01T01:00:01Z", 10, 2),
    marker("2026-09-01T01:00:02Z", "c-start", "[COSPEC:SKILL:START:child:22222222]"),
    usage("2026-09-01T01:00:03Z", 5, 1),
    JSON.stringify({ type: "assistant", timestamp: "2026-09-01T01:00:04Z", message: { role: "assistant",
      content: [{ type: "tool_use", id: "failed-tool", name: "Bash" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:00:05Z", message: { role: "user",
      content: [{ type: "tool_result", tool_use_id: "failed-tool", is_error: true }] } }),
    marker("2026-09-01T01:00:06Z", "c-end", "[COSPEC:SKILL:END:child:22222222:OK]"),
    usage("2026-09-01T01:00:07Z", 7, 3),
    marker("2026-09-01T01:00:08Z", "p-end", "[COSPEC:SKILL:END:parent:11111111:OK]"),
  ].join("\n") + "\n");
  const value = metadata(bytes, runId); value.source_type = "claude_code_jsonl"; value.environment.agent_type = "claude_code";
  const childBytes = Buffer.from(`${usage("2026-09-01T01:00:03.500Z", 4, 1)}\n`);
  const childMetadata = metadata(childBytes, runId, 0, null, randomUUID()); childMetadata.source_type = "claude_code_jsonl";
  childMetadata.environment.agent_type = "claude_code"; childMetadata.agent_session_id = "child-session";
  childMetadata.session = { role: "subagent", root_agent_session_id: value.agent_session_id, parent_agent_session_id: value.agent_session_id };
  const repository = await DurableChunkRepository.open(root); await repository.accept(value, bytes); await repository.accept(childMetadata, childBytes);
  await new ParserWorker(repository).runPending();
  const skills = (repository.getRunFacts(runId) as { skills: Record<string, any> }).skills;
  const parent = skills.items.find((item: any) => item.skill === "parent"); const child = skills.items.find((item: any) => item.skill === "child");
  assert.equal(parent.resources.inclusive.tokens.input_tokens, 26);
  assert.equal(parent.resources.self.tokens.input_tokens, 17);
  assert.equal(parent.resources.inclusive.tools.failures, 1);
  assert.equal(parent.resources.self.tools.calls, 0);
  assert.equal(child.resources.self.tokens.input_tokens, 9);
  assert.equal(child.resources.self.tools.failures, 1);
  assert.equal(child.resources.self.subagents, 1);
  assert.equal(skills.bySkill.parent.resources.tokens.input_tokens, 17);
  assert.equal(skills.resourceAttribution.attribution_coverage, 1);
  repository.close();
});

test("Run tool durations merge concurrent time and reject reversed intervals", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-tool-duration-facts-"));
  const at = (seconds: number) => `2026-09-01T01:00:${String(seconds).padStart(2, "0")}.000Z`;
  const bytes = Buffer.from([
    JSON.stringify({ type: "assistant", timestamp: at(0), message: { role: "assistant", content: [
      { type: "tool_use", id: "long", name: "Bash" },
    ] } }),
    JSON.stringify({ type: "assistant", timestamp: at(1), message: { role: "assistant", content: [
      { type: "tool_use", id: "inside", name: "Read" },
    ] } }),
    JSON.stringify({ type: "user", timestamp: at(4), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "inside", is_error: false },
    ] } }),
    JSON.stringify({ type: "user", timestamp: at(5), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "long", is_error: false },
    ] } }),
    JSON.stringify({ type: "user", timestamp: at(9), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "reversed", is_error: false },
    ] } }),
    JSON.stringify({ type: "assistant", timestamp: at(10), message: { role: "assistant", content: [
      { type: "tool_use", id: "reversed", name: "Write" },
      { type: "tool_use", id: "missing", name: "Write" },
    ] } }),
  ].join("\n") + "\n");
  const value = metadata(bytes);
  value.source_type = "claude_code_jsonl"; value.environment.agent_type = "claude_code";
  const repository = await DurableChunkRepository.open(root);
  await repository.accept(value, bytes);
  await new ParserWorker(repository).runPending();
  const duration = (repository.getRunFacts(value.cospec_run_id) as { tools: { duration: Record<string, unknown> } }).tools.duration;
  assert.deepEqual(duration, { measured_calls: 2, unknown_calls: 1, invalid_intervals: 1, coverage: 0.5,
    accumulated_ms: 8000, wall_clock_ms: 5000, p50_ms: 3000, p90_ms: 5000, semantics: "call_to_result_timestamp" });
  repository.close();
});

test("Run facts keep subagent parent relation and summarize child resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-subagent-facts-"));
  const runId = randomUUID(); const rootSessionId = randomUUID(); const childSessionId = randomUUID();
  const mainBytes = Buffer.from(`${JSON.stringify({ type: "response_item", timestamp: "2026-09-01T01:00:00Z",
    payload: { type: "message", role: "user", content: "private" } })}\n`);
  const main = metadata(mainBytes, runId, 0, null, randomUUID());
  main.agent_session_id = rootSessionId;
  main.session = { role: "main", root_agent_session_id: rootSessionId, parent_agent_session_id: null };
  const childBytes = Buffer.from([
    JSON.stringify({ type: "response_item", timestamp: "2026-09-01T01:00:01Z", payload: { type: "message", role: "assistant", content: "private" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-09-01T01:00:02Z", payload: { type: "token_count", info: {
      last_token_usage: { input_tokens: 12, output_tokens: 3 } } } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-09-01T01:00:03Z", payload: { type: "function_call", call_id: "child-call", name: "exec" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-09-01T01:00:04Z", payload: { type: "function_call_output", call_id: "child-call", output: "{}" } }),
  ].join("\n") + "\n");
  const child = metadata(childBytes, runId, 0, null, randomUUID());
  child.agent_session_id = childSessionId;
  child.session = { role: "subagent", root_agent_session_id: rootSessionId, parent_agent_session_id: rootSessionId };
  const repository = await DurableChunkRepository.open(root);
  await repository.accept(main, mainBytes); await repository.accept(child, childBytes);
  await new ParserWorker(repository).runPending();
  assert.equal(repository.getRun(runId)?.agentSessionId, rootSessionId);
  const subagents = (repository.getRunFacts(runId) as { subagents: Record<string, any> }).subagents;
  assert.equal(subagents.count, 1);
  assert.equal(subagents.parsed_sessions, 1);
  assert.equal(subagents.max_depth, 1);
  assert.equal(subagents.messages.total, 1);
  assert.equal(subagents.tokens.input_tokens, 12);
  assert.equal(subagents.tools.calls, 1);
  assert.equal(subagents.tools.duration.wall_clock_ms, 1000);
  assert.equal(subagents.sessions[0].agentSessionId, childSessionId);
  assert.equal(subagents.sessions[0].parentAgentSessionId, rootSessionId);
  assert.equal(JSON.stringify(subagents).includes("private"), false);
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
