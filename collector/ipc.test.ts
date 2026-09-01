import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startDaemon } from "./daemon.js";
import { request } from "./ipc.js";
import { getIpcEndpoint } from "./platform.js";

test("daemon accepts ensure, status, finish and prevents duplicate endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-ipc-"));
  const sessionsRoot = join(root, "sessions");
  const stateDirectory = join(root, "state");
  await mkdir(sessionsRoot);
  const sessionId = randomUUID();
  const runId = randomUUID();
  await writeFile(join(sessionsRoot, `${sessionId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`);
  const endpoint = getIpcEndpoint(`test-${process.pid}-${Date.now()}`);
  const server = await startDaemon({ endpoint, stateDirectory, sessionsRoot });
  try {
    const ensured = await request(endpoint, { type: "ensure", agentType: "codex", agentSessionId: sessionId, cospecRunId: runId });
    assert.equal(ensured.ok, true);
    const repeated = await request(endpoint, { type: "ensure", agentType: "codex", agentSessionId: sessionId, cospecRunId: runId });
    assert.equal(repeated.ok, true);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => request(endpoint, { type: "ensure", agentType: "codex" as const, agentSessionId: sessionId, cospecRunId: runId })));
    assert.equal(concurrent.every((response) => response.ok), true);
    await assert.rejects(startDaemon({ endpoint, stateDirectory, sessionsRoot }));
    const status = await request(endpoint, { type: "status" });
    assert.equal(status.ok, true);
    const finished = await request(endpoint, { type: "finish", cospecRunId: runId, status: "completed" });
    assert.equal(finished.ok, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
