import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIngestApp } from "../server/app.js";
import { DurableChunkRepository } from "../server/durable-repository.js";
import { ParserWorker } from "../server/parser-worker.js";
import { startDaemon } from "./daemon.js";
import { HttpChunkReceiver } from "./http-receiver.js";
import { request } from "./ipc.js";
import type { CollectorState } from "./types.js";

test("one daemon sends concurrent Codex and Claude Code runs through real HTTP without crossing boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-multi-e2e-"));
  const codexRoot = join(root, "codex");
  const claudeRoot = join(root, "claude", "-project");
  const stateDirectory = join(root, "state");
  const storageRoot = join(root, "storage");
  await mkdir(codexRoot, { recursive: true });
  await mkdir(claudeRoot, { recursive: true });
  const codexSessionId = randomUUID();
  const claudeSessionId = randomUUID();
  const codexRunId = randomUUID();
  const claudeRunId = randomUUID();
  const codexPath = join(codexRoot, `${codexSessionId}.jsonl`);
  const claudePath = join(claudeRoot, `${claudeSessionId}.jsonl`);
  await writeFile(codexPath, `${JSON.stringify({ type: "session_meta", payload: { id: codexSessionId, cli_version: "0.150.1" } })}\n`);
  await writeFile(claudePath, `${JSON.stringify({ type: "user", sessionId: claudeSessionId, version: "2.1.220" })}\n`);

  const repository = await DurableChunkRepository.open(storageRoot);
  const token = "multi-source-test-token";
  const app = await createIngestApp({ bearerToken: token, repository, queryRepository: repository });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const endpoint = `\0cospec-multi-e2e-${process.pid}-${Date.now()}`;
  let daemon = await startDaemon({ endpoint, stateDirectory, sessionsRoot: codexRoot,
    claudeCodeSessionsRoot: join(root, "claude"), receiver: new HttpChunkReceiver({ baseUrl: address, bearerToken: token }), scanIntervalMs: 60_000 });
  try {
    assert.equal((await request(endpoint, { type: "ensure", agentType: "codex", agentSessionId: codexSessionId, cospecRunId: codexRunId, workflowKind: "large", workflowName: "large-requirement-workflow", actor: { employeeId: "63027", displayName: "测试规划员", proposerDept: "研发体系/工程技术部" } })).ok, true);
    assert.equal((await request(endpoint, { type: "ensure", agentType: "claude_code", agentSessionId: claudeSessionId, cospecRunId: claudeRunId })).ok, true);
    await appendFile(codexPath, '{"type":"event_msg","timestamp":"2026-09-01T01:00:00Z"}\n');
    await appendFile(claudePath, `${JSON.stringify({ type: "assistant", sessionId: claudeSessionId, version: "2.1.220", timestamp: "2026-09-01T02:00:00Z" })}\n`);
    const scanned = await request(endpoint, { type: "scan" });
    assert.equal(scanned.ok, true);
    await new ParserWorker(repository).runPending();
    assert.equal(repository.getRun(codexRunId)?.sourceType, "codex_jsonl");
    assert.deepEqual(repository.getRun(codexRunId)?.typeCounts, { event_msg: 1 });
    assert.equal(repository.getRun(claudeRunId)?.sourceType, "claude_code_jsonl");
    assert.deepEqual(repository.getRun(claudeRunId)?.typeCounts, { assistant: 1 });
    assert.equal((await request(endpoint, { type: "event", event: { schema_version: "0.1.0", event_id: `${codexRunId}:stage-1:start`, cospec_run_id: codexRunId, event_type: "stage_started", occurred_at: new Date().toISOString(), stage: "large-step-1" } })).ok, true);
    assert.equal((await request(endpoint, { type: "scan" })).ok, true);

    assert.equal((await request(endpoint, { type: "finish", cospecRunId: codexRunId, status: "completed" })).ok, true);
    assert.equal((await request(endpoint, { type: "finish", cospecRunId: claudeRunId, status: "completed" })).ok, true);
    await appendFile(codexPath, '{"type":"event_msg","payload":{"after":true}}\n');
    await appendFile(claudePath, `${JSON.stringify({ type: "assistant", sessionId: claudeSessionId, payload: { after: true } })}\n`);
    assert.deepEqual((await request(endpoint, { type: "scan" })).data, { chunks: 0, bytes: 0 });
    assert.equal((await repository.getRunChunks(codexRunId)).length, 1);
    assert.equal((await repository.getRunChunks(claudeRunId)).length, 1);
    assert.deepEqual(repository.getRunEvents(codexRunId).map((event) => event.event_type), ["run_started", "stage_started", "run_finished"]);
    assert.equal((repository.getWorkflowSummary().by_kind as Record<string, number>).large, 1);
    const people = repository.getWorkflowSummary().people as { unique_people: number; identified_runs: number; items: Array<Record<string, unknown>> };
    assert.equal(people.unique_people, 1);
    assert.equal(people.identified_runs, 2);
    assert.deepEqual(people.items[0], { employee_id: "63027", display_name: "测试规划员", proposer_dept: "研发体系/工程技术部", runs: 2 });
    assert.deepEqual((repository.getWorkflowSummary().by_proposer_dept as Record<string, number>), { "研发体系/工程技术部": 2 });

    await close(daemon);
    daemon = await startDaemon({ endpoint, stateDirectory, sessionsRoot: codexRoot,
      claudeCodeSessionsRoot: join(root, "claude"), receiver: new HttpChunkReceiver({ baseUrl: address, bearerToken: token }), scanIntervalMs: 60_000 });
    const restarted = (await request(endpoint, { type: "status" })).data as CollectorState;
    assert.equal(Object.keys(restarted.runs).length, 2);
    assert.equal(Object.values(restarted.runs).every((run) => run.status === "completed"), true);
  } finally {
    await close(daemon);
    await app.close();
    repository.close();
  }
});

function close(server: import("node:net").Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
