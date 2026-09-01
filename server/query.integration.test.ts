import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChunkMetadata } from "../collector/types.js";
import { createIngestApp } from "./app.js";
import { DurableChunkRepository } from "./durable-repository.js";
import { parseCodexJsonl } from "./parser.js";
import { ParserRegistry } from "./parser-registry.js";
import { ParserWorker } from "./parser-worker.js";
import { ReplayService } from "./replay.js";

const TOKEN = "query-test-token";

test("health endpoints expose only process and repository readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-health-"));
  const repository = await DurableChunkRepository.open(root);
  const app = await createIngestApp({ bearerToken: TOKEN, repository, queryRepository: repository });
  try {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { status: "ok" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { status: "ready" });
    assert.equal(live.body.includes(TOKEN) || live.body.includes(root), false);
    assert.equal(ready.body.includes(TOKEN) || ready.body.includes(root), false);
    const page = await app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] ?? "", /text\/html/);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.match(page.body, /Cospec/);
    const routeFallback = await app.inject({ method: "GET", url: "/runs/example" });
    assert.match(routeFallback.headers["content-type"] ?? "", /text\/html/);
    const missingAsset = await app.inject({ method: "GET", url: "/assets/removed-build.js" });
    assert.equal(missingAsset.statusCode, 404);
    assert.doesNotMatch(missingAsset.headers["content-type"] ?? "", /text\/html/);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/v1/not-found" })).json(), { error: "not_found" });
  } finally { await app.close(); repository.close(); }
});

test("read-only query API returns active-version summaries without content or paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-query-"));
  const repository = await DurableChunkRepository.open(root);
  const runId = randomUUID();
  const sourceFileId = randomUUID();
  const firstBytes = Buffer.from('{"type":"event_msg","timestamp":"2026-09-01T01:00:00Z","payload":{"private":"DO_NOT_RETURN"}}\n');
  const first = metadata(firstBytes, runId, sourceFileId, 500, null);
  await repository.accept(first, firstBytes);
  const secondBytes = Buffer.from('{"type":"future_type","timestamp":"2026-09-01T02:00:00Z"}\n');
  await repository.accept(metadata(secondBytes, runId, sourceFileId, first.file.end_offset, first.file.sha256), secondBytes);
  await new ParserWorker(repository).runPending();
  await new ReplayService(repository, new ParserRegistry({ "0.3.0": (bytes) => parseCodexJsonl(bytes, "0.3.0") })).replayRun(runId, "0.3.0");

  const app = await createIngestApp({ bearerToken: TOKEN, repository, queryRepository: repository });
  try {
    const headers = { authorization: `Bearer ${TOKEN}` };
    const list = await app.inject({ method: "GET", url: "/api/v1/runs?limit=1&offset=0", headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().total, 1);
    assert.equal(list.json().items[0].runId, runId);

    const detail = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().agentType, "codex");
    assert.equal(detail.json().sourceVersion, "0.150.1");
    assert.equal(detail.json().activeParserVersion, "0.3.0");
    assert.equal(detail.json().totalLines, 2);
    assert.deepEqual(detail.json().typeCounts, { event_msg: 1, future_type: 1 });
    assert.equal(detail.body.includes("DO_NOT_RETURN"), false);
    assert.equal(detail.body.includes(root), false);

    const chunks = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/chunks`, headers });
    assert.equal(chunks.json().items.length, 2);
    assert.equal(chunks.json().items.every((item: { rawPresent: boolean }) => item.rawPresent), true);
    assert.equal(chunks.body.includes(root), false);
    assert.equal(chunks.body.includes("private.jsonl"), false);

    const replays = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/replays`, headers });
    assert.equal(replays.json().items[0].targetVersion, "0.3.0");
    assert.equal(replays.json().items[0].status, "completed");

    const facts = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/facts`, headers });
    assert.equal(facts.statusCode, 200);
    assert.equal(facts.json().parserVersion, "0.3.0");
    assert.equal(facts.json().messages.total, 0);
    assert.equal(facts.json().attribution.skill, "unavailable");
    assert.equal(facts.body.includes("DO_NOT_RETURN"), false);

    assert.equal((await app.inject({ method: "GET", url: "/api/v1/runs" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/facts` })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/runs?limit=0", headers })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/runs/${randomUUID()}`, headers })).statusCode, 404);
  } finally { await app.close(); repository.close(); }
});

test("query API returns an empty paginated list", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-query-empty-"));
  const repository = await DurableChunkRepository.open(root);
  const app = await createIngestApp({ bearerToken: TOKEN, repository, queryRepository: repository });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/runs", headers: { authorization: `Bearer ${TOKEN}` } });
    assert.deepEqual(response.json(), { items: [], total: 0, limit: 20, offset: 0 });
  } finally { await app.close(); repository.close(); }
});

test("run usage summary reports coverage and supports agent, version, model and time filters", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-run-usage-"));
  const repository = await DurableChunkRepository.open(root);
  const claudeRun = randomUUID();
  const claudeBytes = Buffer.from([
    JSON.stringify({ type: "assistant", timestamp: "2026-08-30T01:00:00Z", message: {
      role: "assistant", model: "claude-test", usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 },
      content: [{ type: "tool_use", id: "summary-tool", name: "Read" }] } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-08-30T01:00:01Z", message: {
      role: "assistant", model: "claude-alt", usage: { input_tokens: 6, output_tokens: 2 }, content: [] } }),
    JSON.stringify({ type: "user", timestamp: "2026-08-30T01:00:02Z", message: {
      role: "user", content: [{ type: "tool_result", tool_use_id: "summary-tool", is_error: false }] } }),
  ].join("\n") + "\n");
  const claude = metadata(claudeBytes, claudeRun, randomUUID(), 0, null);
  const terminalId = randomUUID();
  claude.environment.anonymous_terminal_id = terminalId;
  claude.source_type = "claude_code_jsonl"; claude.source_version = "2.1.220";
  claude.environment.agent_type = "claude_code"; claude.environment.agent_version = "2.1.220";
  claude.file.line_count = 3;
  await repository.accept(claude, claudeBytes);

  const codexRun = randomUUID();
  const codexBytes = Buffer.from(`${JSON.stringify({ type: "event_msg", timestamp: "2026-09-01T01:00:00Z", payload: {
    type: "token_count", info: { last_token_usage: { input_tokens: 20, output_tokens: 5 } } } })}\n`);
  const codex = metadata(codexBytes, codexRun, randomUUID(), 0, null);
  codex.environment.anonymous_terminal_id = terminalId;
  codex.environment.cospec_plugin_version = "1.1.80";
  await repository.accept(codex, codexBytes);

  const missingRun = randomUUID();
  const missingBytes = Buffer.from('{"type":"future_type"}\n');
  await repository.accept(metadata(missingBytes, missingRun, randomUUID(), 0, null), missingBytes);
  await new ParserWorker(repository).runPending();

  const app = await createIngestApp({ bearerToken: TOKEN, repository, queryRepository: repository });
  try {
    const headers = { authorization: `Bearer ${TOKEN}` };
    const response = await app.inject({ method: "GET", url: "/api/v1/summaries/run-usage", headers });
    assert.equal(response.statusCode, 200);
    const summary = response.json();
    assert.equal(summary.runs.total, 3);
    assert.deepEqual(summary.runs.byAgent, { claude_code: 1, codex: 2 });
    assert.deepEqual(summary.terminals, { active_anonymous_terminals: 1, runs_with_terminal_id: 2,
      runs_missing_terminal_id: 1, run_coverage: 2 / 3 });
    assert.deepEqual(summary.runs.byCospecPluginVersion, { "1": 2, "1.1.80": 1 });
    assert.deepEqual(summary.cospecPluginVersions.byVersion["1.1.80"], { runs: 1, active_anonymous_terminals: 1,
      runs_with_terminal_id: 1, runs_missing_terminal_id: 0 });
    assert.deepEqual(summary.cospecPluginVersions.byVersion["1"], { runs: 2, active_anonymous_terminals: 1,
      runs_with_terminal_id: 1, runs_missing_terminal_id: 1 });
    assert.equal(summary.messages.total, 3);
    assert.equal(summary.messages.runs_with_data, 1);
    assert.equal(summary.messages.runs_missing_data, 2);
    assert.equal(summary.tokens.input_tokens, 36);
    assert.equal(summary.tokens.runs_with_data, 2);
    assert.equal(summary.tokens.run_coverage, 2 / 3);
    assert.deepEqual(summary.tokens.field_run_coverage.cache_read_input_tokens,
      { runs_with_data: 1, runs_missing_data: 2, run_coverage: 1 / 3 });
    assert.deepEqual(summary.models.byModel["claude-test"], { observations: 1,
      input_samples: 1, output_samples: 1, cache_read_samples: 1, cache_write_samples: 0, reasoning_samples: 0, reported_total_samples: 0,
      input_tokens: 10, output_tokens: 4,
      cache_read_input_tokens: 3, cache_write_or_creation_input_tokens: null, reasoning_output_tokens: null,
      reported_total_tokens: null, runs: 1 });
    assert.equal(summary.models.byModel["claude-alt"].runs, 1);
    assert.equal(summary.models.runs_missing_data, 2);
    assert.deepEqual(summary.resourceDistribution.overall.run_span_ms,
      { runs_with_data: 2, runs_missing_data: 1, run_coverage: 2 / 3, average: 1000, p50: 0, p90: 2000 });
    assert.deepEqual(summary.resourceDistribution.overall.input_tokens_per_run,
      { runs_with_data: 2, runs_missing_data: 1, run_coverage: 2 / 3, average: 18, p50: 16, p90: 20 });
    assert.deepEqual(summary.resourceDistribution.overall.tool_wall_clock_ms_per_run,
      { runs_with_data: 3, runs_missing_data: 0, run_coverage: 1, average: 2000 / 3, p50: 0, p90: 2000 });
    assert.equal(summary.resourceDistribution.byAgent.claude_code.runs, 1);
    assert.equal(summary.resourceDistribution.byAgentVersion["claude_code@2.1.220"].runs, 1);
    assert.equal(summary.resourceDistribution.byModel["claude-test"].runs, 1);
    assert.equal(summary.resourceDistribution.byModel["claude-alt"].runs, 1);

    const filtered = await app.inject({ method: "GET",
      url: "/api/v1/summaries/run-usage?agentType=claude_code&agentVersion=2.1.220&model=claude-test&from=2026-08-30T00:00:00Z&to=2026-08-30T23:59:59Z", headers });
    assert.equal(filtered.statusCode, 200);
    assert.equal(filtered.json().runs.total, 1);
    assert.equal(filtered.json().terminals.active_anonymous_terminals, 1);
    const pluginFiltered = await app.inject({ method: "GET", url: "/api/v1/summaries/run-usage?cospecPluginVersion=1.1.80", headers });
    assert.equal(pluginFiltered.statusCode, 200);
    assert.equal(pluginFiltered.json().runs.total, 1);
    assert.deepEqual(filtered.json().runs.byAgent, { claude_code: 1 });
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/summaries/run-usage?agentType=other", headers })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/summaries/run-usage?unknown=x", headers })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/summaries/run-usage?cospecPluginVersion=${"x".repeat(201)}`, headers })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/summaries/run-usage" })).statusCode, 401);
  } finally { await app.close(); repository.close(); }
});

test("subagent summary excludes legacy runs and reports usage, resources and shares", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-subagent-summary-"));
  const repository = await DurableChunkRepository.open(root);
  const claudeRun = randomUUID(); const claudeRootSession = randomUUID(); const childSession = "child-agent";
  const mainBytes = Buffer.from(`${JSON.stringify({ type: "user", timestamp: "2026-09-01T01:00:00Z",
    message: { role: "user", content: "private" } })}\n`);
  const main = metadata(mainBytes, claudeRun, randomUUID(), 0, null);
  main.source_type = "claude_code_jsonl"; main.environment.agent_type = "claude_code";
  main.agent_session_id = claudeRootSession;
  main.session = { role: "main", root_agent_session_id: claudeRootSession, parent_agent_session_id: null };
  await repository.accept(main, mainBytes);
  const childBytes = Buffer.from([
    JSON.stringify({ type: "assistant", timestamp: "2026-09-01T01:00:01Z", message: { role: "assistant", model: "child-model",
      usage: { input_tokens: 4, output_tokens: 1 }, content: [{ type: "tool_use", id: "child-tool", name: "Read" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-09-01T01:00:02Z", message: { role: "user",
      content: [{ type: "tool_result", tool_use_id: "child-tool", is_error: false }] } }),
  ].join("\n") + "\n");
  const child = metadata(childBytes, claudeRun, randomUUID(), 0, null);
  child.source_type = "claude_code_jsonl"; child.environment.agent_type = "claude_code"; child.agent_session_id = childSession;
  child.session = { role: "subagent", root_agent_session_id: claudeRootSession, parent_agent_session_id: claudeRootSession };
  await repository.accept(child, childBytes);

  const codexRun = randomUUID(); const codexBytes = Buffer.from(`${JSON.stringify({ type: "response_item", timestamp: "2026-09-01T02:00:00Z",
    payload: { type: "message", role: "user", content: "private" } })}\n`);
  const codex = metadata(codexBytes, codexRun, randomUUID(), 0, null);
  codex.session = { role: "main", root_agent_session_id: codex.agent_session_id, parent_agent_session_id: null };
  await repository.accept(codex, codexBytes);

  const legacyBytes = Buffer.from('{"type":"event_msg","timestamp":"2026-09-01T03:00:00Z"}\n');
  await repository.accept(metadata(legacyBytes, randomUUID(), randomUUID(), 0, null), legacyBytes);
  await new ParserWorker(repository).runPending();
  const app = await createIngestApp({ bearerToken: TOKEN, repository, queryRepository: repository });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/summaries/run-usage",
      headers: { authorization: `Bearer ${TOKEN}` } });
    const subagents = response.json().subagents;
    assert.equal(subagents.eligible_runs, 2);
    assert.equal(subagents.excluded_legacy_runs, 1);
    assert.equal(subagents.runs_with_subagents, 1);
    assert.equal(subagents.runs_without_subagents, 1);
    assert.equal(subagents.usage_rate, 0.5);
    assert.deepEqual(subagents.sessions.per_run,
      { runs_with_data: 2, runs_missing_data: 0, run_coverage: 1, average: 0.5, p50: 0, p90: 1 });
    assert.equal(subagents.sessions.total, 1);
    assert.equal(subagents.messages.total, 2);
    assert.equal(subagents.input_tokens.total, 4);
    assert.equal(subagents.tools.calls, 1);
    assert.equal(subagents.tools.wall_clock_ms_per_run.p90, 1000);
    assert.equal(subagents.resource_share.messages.p90, 2 / 3);
    assert.equal(subagents.resource_share.input_tokens.p50, 1);
    assert.equal(subagents.byAgent.claude_code.runs_with_subagents, 1);
    assert.equal(subagents.byAgent.codex.runs_without_subagents, 1);
    assert.equal(subagents.byModel["child-model"].sessions.total, 1);
  } finally { await app.close(); repository.close(); }
});

function metadata(bytes: Buffer, runId: string, sourceFileId: string, start: number, previous: string | null): ChunkMetadata {
  const now = new Date().toISOString();
  return {
    schema_version: "0.1.0", upload_id: randomUUID(), cospec_run_id: runId,
    source_type: "codex_jsonl", source_version: "0.150.1", agent_session_id: randomUUID(), collected_at: now, collector_version: "0.1.0",
    file: { source_file_id: sourceFileId, generation: 1, path_hint: "/private/private.jsonl", start_offset: start,
      end_offset: start + bytes.length, byte_count: bytes.length, line_count: 1,
      sha256: createHash("sha256").update(bytes).digest("hex"), previous_chunk_sha256: previous, ends_with_newline: true },
    environment: { captured_at: now, agent_type: "codex", agent_version: "0.150.1", os_platform: "linux", os_arch: "x64", cospec_plugin_version: "1", timezone: "UTC" },
  };
}
