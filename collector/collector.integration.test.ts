import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

interface CliResult { ok: boolean; data?: unknown; error?: string }

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
