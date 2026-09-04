import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createIngestApp } from "../server/app.js";
import { DurableChunkRepository } from "../server/durable-repository.js";

interface CliResult { ok: boolean; data?: unknown; error?: string; collector_version?: string; protocol_version?: number }

test("CLI rejects invalid integration parameters with structured JSON and nonzero exit", async () => {
  const invalidAgent = await cliFailure(["ensure", "--agent", "other", "--session-id", randomUUID(), "--run-id", randomUUID()], process.env);
  assert.equal(invalidAgent.result.error, "invalid_option:agent");
  assert.equal(invalidAgent.result.protocol_version, 1);
  assert.notEqual(invalidAgent.code, 0);
  const invalidStatus = await cliFailure(["finish", "--run-id", randomUUID(), "--status", "other"], process.env);
  assert.equal(invalidStatus.result.error, "invalid_option:status");
  const invalidRun = await cliFailure(["finish", "--run-id", "not-a-uuid"], process.env);
  assert.equal(invalidRun.result.error, "invalid_option:run-id");
});

test("daemon restart preserves multiple open Runs until each receives an explicit finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-restart-recovery-"));
  const sessionsRoot = join(root, "sessions");
  const stateDirectory = join(root, "state");
  const firstSessionId = randomUUID();
  const secondSessionId = randomUUID();
  const pendingSessionId = randomUUID();
  const firstRunId = randomUUID();
  const secondRunId = randomUUID();
  const pendingRunId = randomUUID();
  const namespace = `restart-${process.pid}-${Date.now()}`;
  await mkdir(sessionsRoot, { recursive: true });
  for (const sessionId of [firstSessionId, secondSessionId]) {
    await writeFile(join(sessionsRoot, `rollout-${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cli_version: "0.150.1" } })}\n`);
  }
  const env = { ...process.env, CODEX_SESSIONS_ROOT: sessionsRoot, COSPEC_TELEMETRY_STATE_DIR: stateDirectory,
    COSPEC_TELEMETRY_NAMESPACE: namespace };
  try {
    const firstEnsure = await cli(["ensure", "--agent", "codex", "--session-id", firstSessionId, "--run-id", firstRunId], env);
    const firstStartOffset = (firstEnsure.data as { startOffset: number }).startOffset;
    await cli(["ensure", "--agent", "codex", "--session-id", pendingSessionId, "--run-id", pendingRunId], env);
    await cli(["shutdown"], env);
    await cli(["ensure", "--agent", "codex", "--session-id", secondSessionId, "--run-id", secondRunId], env);
    const resumedFirst = await cli(["ensure", "--agent", "codex", "--session-id", firstSessionId, "--run-id", firstRunId], env);
    assert.equal((resumedFirst.data as { status: string }).status, "open");
    assert.equal((resumedFirst.data as { startOffset: number }).startOffset, firstStartOffset);
    let recovered = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    assert.equal(recovered.runs[firstRunId].status, "open");
    assert.equal(recovered.runs[secondRunId].status, "open");
    assert.equal(recovered.runs[pendingRunId].status, "pending");

    await cli(["finish", "--run-id", firstRunId, "--status", "completed"], env);
    recovered = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    assert.equal(recovered.runs[firstRunId].status, "completed");
    assert.equal(recovered.runs[secondRunId].status, "open");

    await cli(["finish", "--run-id", secondRunId, "--status", "interrupted"], env);
    recovered = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8"));
    assert.equal(recovered.runs[secondRunId].status, "interrupted");
  } finally {
    await cli(["shutdown"], env).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI, daemon and local mock receiver support complete-line incremental resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-integration-"));
  const sessionsRoot = join(root, "sessions");
  const stateDirectory = join(root, "state");
  const sessionId = randomUUID();
  const runId = randomUUID();
  const namespace = `e2e-${process.pid}-${Date.now()}`;
  const sessionPath = join(sessionsRoot, `rollout-${sessionId}.jsonl`);
  await mkdir(sessionsRoot, { recursive: true });
  const beforeRun = `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cli_version: "0.150.1" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "ordinary_before_run" } })}\n`;
  await writeFile(sessionPath, beforeRun);

  const env = {
    ...process.env,
    CODEX_SESSIONS_ROOT: sessionsRoot,
    COSPEC_TELEMETRY_STATE_DIR: stateDirectory,
    COSPEC_TELEMETRY_NAMESPACE: namespace,
    COSPEC_TELEMETRY_SCAN_INTERVAL_MS: "50",
  };

  try {
    const ensured = await cli(["ensure", "--agent", "codex", "--session-id", sessionId, "--run-id", runId], env);
    assert.equal(ensured.ok, true);
    const firstPayload = `${JSON.stringify({ type: "event_msg", payload: { type: "workflow_started" } })}\n`;
    await appendFile(sessionPath, firstPayload);
    await waitFor(async () => {
      try { return Object.values((await state(stateDirectory)).files)[0]?.confirmedOffset === Buffer.byteLength(beforeRun) + Buffer.byteLength(firstPayload); }
      catch { return false; }
    });
    const firstState = await state(stateDirectory);
    const file = Object.values(firstState.files)[0]!;
    assert.equal(file.confirmedOffset, Buffer.byteLength(beforeRun) + Buffer.byteLength(firstPayload));

    await cli(["shutdown"], env);
    await appendFile(sessionPath, '{"type":"event_msg","payload":');
    const restarted = await cli(["ensure", "--agent", "codex", "--session-id", sessionId, "--run-id", runId], env);
    assert.equal(restarted.ok, true);
    await cli(["scan"], env);
    assert.equal(Object.values((await state(stateDirectory)).files)[0]!.confirmedOffset, file.confirmedOffset);

    const completion = '{"type":"turn_complete"}}\n';
    await appendFile(sessionPath, completion);
    await cli(["scan"], env);
    const finalState = await state(stateDirectory);
    assert.equal(Object.values(finalState.files)[0]!.confirmedOffset, Buffer.byteLength(beforeRun) + Buffer.byteLength(firstPayload) + Buffer.byteLength('{"type":"event_msg","payload":') + Buffer.byteLength(completion));

    const metadataFiles = (await readdir(join(stateDirectory, "outbox"))).filter((name) => name.endsWith(".metadata.json")).sort((a, b) => metadataStart(a) - metadataStart(b));
    assert.equal(metadataFiles.length, 2);
    const firstMetadata = JSON.parse(await readFile(join(stateDirectory, "outbox", metadataFiles[0]!), "utf8"));
    const secondMetadata = JSON.parse(await readFile(join(stateDirectory, "outbox", metadataFiles[1]!), "utf8"));
    assert.equal(firstMetadata.file.start_offset, Buffer.byteLength(beforeRun));
    assert.equal(secondMetadata.file.start_offset, firstMetadata.file.end_offset);
    assert.equal(secondMetadata.file.previous_chunk_sha256, firstMetadata.file.sha256);
    assert.equal(secondMetadata.source_version, "0.150.1");

    const finished = await cli(["finish", "--run-id", runId, "--status", "completed"], env);
    assert.equal((finished.data as { status: string }).status, "completed");
    assert.equal((finished.data as { endOffset: number }).endOffset, Object.values(finalState.files)[0]!.confirmedOffset);
    await appendFile(sessionPath, `${JSON.stringify({ type: "event_msg", payload: { type: "ordinary_after_run" } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const afterFinish = await state(stateDirectory);
    assert.equal(Object.values(afterFinish.files)[0]!.confirmedOffset, Object.values(finalState.files)[0]!.confirmedOffset);
    assert.equal((await readdir(join(stateDirectory, "outbox"))).filter((name) => name.endsWith(".metadata.json")).length, 2);
  } finally {
    await cli(["shutdown"], env).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge query detail travels through CLI, daemon and HTTP storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-knowledge-e2e-"));
  const sessionsRoot = join(root, "sessions"); const stateDirectory = join(root, "state");
  const sessionId = randomUUID(); const runId = randomUUID(); await mkdir(sessionsRoot, { recursive: true });
  await writeFile(join(sessionsRoot, `rollout-${sessionId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cli_version: "0.150.1" } })}\n`);
  const payloadPath = join(root, "query.json");
  const detail = { question: "国产域控支持哪些能力？", answer: "支持批量加域。[KB-1]", hits: [{ path: "03/能力.md", excerpt: "支持批量加域" }], citations: [{ id: "KB-1", path: "03/能力.md" }] };
  await writeFile(payloadPath, JSON.stringify(detail));
  const repository = await DurableChunkRepository.open(join(root, "server"));
  const app = await createIngestApp({ bearerToken: "unused", repository, queryRepository: repository });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const env = { ...process.env, CODEX_SESSIONS_ROOT: sessionsRoot, COSPEC_TELEMETRY_STATE_DIR: stateDirectory,
    COSPEC_TELEMETRY_NAMESPACE: `knowledge-${process.pid}-${Date.now()}`, COSPEC_TELEMETRY_SERVER_URL: address };
  try {
    await cli(["ensure", "--agent", "codex", "--session-id", sessionId, "--run-id", runId], env);
    await cli(["knowledge-query", "--run-id", runId, "--query-id", "q1", "--kb-name", "desktop-cloud", "--kb-revision", "sha256:abc",
      "--query-status", "completed", "--query-source", "workflow", "--hit-count", "1", "--citation-count", "1", "--warning-count", "0", "--payload-file", payloadPath], env);
    await waitFor(async () => repository.getRunEvents(runId).some((event) => event.event_type === "knowledge_query_finished"));
    const event = repository.getRunEvents(runId).find((item) => item.event_type === "knowledge_query_finished");
    assert.deepEqual(event?.query_detail, detail);
  } finally {
    await cli(["shutdown"], env).catch(() => undefined); await app.close(); repository.close(); await rm(root, { recursive: true, force: true });
  }
});

test("single-file Collector freezes, uploads, lists and downloads a manifest artifact through durable HTTP storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-artifact-e2e-")); const sessionsRoot = join(root, "sessions"); const stateDirectory = join(root, "state");
  const sessionId = randomUUID(); const runId = randomUUID(); const token = "artifact-e2e-token"; await mkdir(sessionsRoot, { recursive: true });
  await writeFile(join(sessionsRoot, `rollout-${sessionId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cli_version: "0.150.1" } })}\n`);
  const artifactPath = join(root, "tr1用户需求文档_评审版.md"); const bytes = Buffer.from("# 国产化域控评审版\n"); await writeFile(artifactPath, bytes);
  const manifestPath = join(root, "manifest.json"); await writeFile(manifestPath, JSON.stringify({ run_id: runId, products: { "tr1-requirements-spec": { role: "tr1_deliverable", attempts: [{ attempt_id: "attempt-final", status: "done", recorded_at: new Date().toISOString(), artifacts: [{ kind: "file", role: "tr1_deliverable", path: artifactPath, size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] }] } } }));
  const repository = await DurableChunkRepository.open(join(root, "server")); const app = await createIngestApp({ bearerToken: token, repository, queryRepository: repository });
  const address = await app.listen({ host: "127.0.0.1", port: 0 }); const env = { ...process.env, CODEX_SESSIONS_ROOT: sessionsRoot, COSPEC_TELEMETRY_STATE_DIR: stateDirectory, COSPEC_TELEMETRY_NAMESPACE: `artifact-${process.pid}-${Date.now()}`, COSPEC_TELEMETRY_SERVER_URL: address, COSPEC_TELEMETRY_BEARER_TOKEN: token };
  try {
    await cli(["ensure", "--agent", "codex", "--session-id", sessionId, "--run-id", runId], env);
    const synced = await cli(["sync-artifacts", "--run-id", runId, "--manifest", manifestPath], env); assert.deepEqual(synced.data, { queued: 1, known: 0, rejected: 0 });
    await cli(["finish", "--run-id", runId, "--status", "completed"], env);
    const list = await fetch(`${address}/api/v1/runs/${runId}/artifacts`, { headers: { authorization: `Bearer ${token}` } }); const items = (await list.json() as { items: Array<{ upload_id: string; file_name: string }> }).items;
    assert.equal(items.length, 1); assert.equal(items[0]?.file_name, "tr1用户需求文档_评审版.md");
    const download = await fetch(`${address}/api/v1/artifacts/${items[0]!.upload_id}/download`, { headers: { authorization: `Bearer ${token}` } }); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    const collectorState = await state(stateDirectory) as any; assert.equal((Object.values(collectorState.artifacts) as any[])[0]?.status, "uploaded");
  } finally { await cli(["shutdown"], env).catch(() => undefined); await app.close(); repository.close(); await rm(root, { recursive: true, force: true }); }
});

function metadataStart(name: string): number {
  const match = /-(\d+)-(\d+)\.metadata\.json$/.exec(name);
  if (!match) throw new Error(`unexpected metadata filename: ${name}`);
  return Number(match[1]);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition_timeout");
}

async function state(directory: string): Promise<{
  files: Record<string, { confirmedOffset: number }>;
}> {
  return JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
}

async function cli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), "dist", "collector", "cli.js"), ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) { reject(new Error(stderr || stdout || `CLI exited ${code}`)); return; }
      try { resolve(JSON.parse(stdout) as CliResult); }
      catch { reject(new Error(`invalid CLI output: ${stdout}`)); }
    });
  });
}

async function cliFailure(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; result: CliResult }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), "dist", "collector", "cli.js"), ...args], { env });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.once("error", reject);
    child.once("exit", (code) => {
      try { resolve({ code, result: JSON.parse(stdout) as CliResult }); }
      catch { reject(new Error(`invalid CLI failure output: ${stdout}`)); }
    });
  });
}
