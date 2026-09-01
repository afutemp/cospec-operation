import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startDaemon } from "./daemon.js";
import { request } from "./ipc.js";
import type { ChunkReceiver } from "./scanner.js";
import type { CollectorState } from "./types.js";

test("daemon persists failure, logs retries and recovery, and retains diagnostics across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-observability-"));
  const sessionsRoot = join(root, "sessions");
  const stateDirectory = join(root, "state");
  const sessionId = randomUUID();
  const runId = randomUUID();
  const sessionPath = join(sessionsRoot, `${sessionId}.jsonl`);
  const endpoint = `\0cospec-observability-${process.pid}-${Date.now()}`;
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(sessionPath, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`);
  let failing = true;
  const receiver: ChunkReceiver = { async accept() { if (failing) throw new Error("upload_network_error"); } };
  let server = await startDaemon({ endpoint, stateDirectory, sessionsRoot, receiver });
  try {
    await request(endpoint, { type: "ensure", agentType: "codex", agentSessionId: sessionId, cospecRunId: runId });
    await appendFile(sessionPath, '{"type":"event_msg"}\n');
    await waitFor(async () => diagnostics(stateDirectory).then((value) => (value.consecutiveFailures ?? 0) >= 2));
    const failed = await request(endpoint, { type: "status" });
    const failedDiagnostics = (failed.data as CollectorState).diagnostics!;
    assert.equal(failedDiagnostics.lastError?.stage, "upload");
    assert.equal(failedDiagnostics.lastError?.code, "upload_network_error");
    assert.ok(failedDiagnostics.lastError?.cospecRunId);

    failing = false;
    await waitFor(async () => diagnostics(stateDirectory).then((value) => value.consecutiveFailures === 0 && value.recoveredAt !== null));
    const content = await readFile(join(stateDirectory, "logs", "collector.jsonl"), "utf8");
    assert.match(content, /"event":"scan_failed"/);
    assert.match(content, /"event":"scan_recovered"/);
    assert.match(content, /"event":"chunks_uploaded"/);
    assert.equal(content.includes(sessionPath), false);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = await startDaemon({ endpoint, stateDirectory, sessionsRoot, receiver });
    const restarted = await request(endpoint, { type: "status" });
    assert.ok((restarted.data as CollectorState).diagnostics?.lastSuccessAt);
    assert.equal((restarted.data as CollectorState).diagnostics?.consecutiveFailures, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function diagnostics(directory: string): Promise<NonNullable<CollectorState["diagnostics"]>> {
  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as CollectorState;
  return state.diagnostics ?? { lastScanAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastError: null, recoveredAt: null };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition_timeout");
}
