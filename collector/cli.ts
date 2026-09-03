#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startDaemon } from "./daemon.js";
import { request } from "./ipc.js";
import { getIpcEndpoint } from "./platform.js";
import type { AgentType, CollectorCommand, CommandResponse, WorkflowKind } from "./types.js";

const COLLECTOR_VERSION = "0.1.0";
const PROTOCOL_VERSION = 1;

const [command, ...args] = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

async function sendWithAutostart(message: CollectorCommand): Promise<void> {
  const endpoint = getIpcEndpoint();
  try { print(await request(endpoint, message)); return; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ECONNREFUSED" && code !== "ENOENT") throw error;
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "daemon"], {
    detached: true, stdio: "ignore", windowsHide: true,
    env: process.env,
  });
  child.unref();
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try { print(await request(endpoint, message)); return; }
    catch (error) { lastError = error; }
  }
  throw lastError ?? new Error("collector_start_timeout");
}

function print(response: CommandResponse): void {
  const { collectorVersion, protocolVersion, ...payload } = response;
  process.stdout.write(`${JSON.stringify({
    ...payload,
    ...(collectorVersion !== undefined ? { collector_version: collectorVersion } : {}),
    ...(protocolVersion !== undefined ? { protocol_version: protocolVersion } : {}),
  }, null, 2)}\n`);
  if (!response.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (command === "daemon") { await startDaemon(); return; }
  if (command === "ensure") {
    const agentType = agentTypeOption(option("agent") ?? "codex");
    const environmentSessionId = agentType === "claude_code" ? process.env.CLAUDE_SESSION_ID : process.env.CODEX_SESSION_ID;
    const agentSessionId = uuid(option("session-id") ?? environmentSessionId ?? required("session-id"), "session-id");
    const cospecRunId = uuid(option("run-id") ?? randomUUID(), "run-id");
    const employeeId = option("employee-id"); const displayName = option("display-name"); const proposerDept = option("proposer-dept");
    if ((employeeId && !displayName) || (!employeeId && displayName)) throw new Error("invalid_option:actor");
    if (employeeId && (!/^[A-Za-z0-9._-]{1,64}$/.test(employeeId) || displayName!.length > 100 || /[\u0000-\u001f]/.test(displayName!) || (proposerDept !== undefined && (!proposerDept || proposerDept.length > 200 || /[\u0000-\u001f]/.test(proposerDept))))) throw new Error("invalid_option:actor");
    await sendWithAutostart({
      type: "ensure", agentType,
      agentSessionId,
      cospecRunId,
      workflowKind: workflowKindOption(option("workflow-kind") ?? "custom"), workflowName: option("workflow-name") ?? "unknown",
      ...(employeeId ? { actor: { employeeId, displayName: displayName!, ...(proposerDept ? { proposerDept } : {}) } } : {}),
    });
    return;
  }
  if (command === "event") {
    const eventType = required("event-type") as "stage_started" | "stage_finished";
    if (!["stage_started", "stage_finished"].includes(eventType)) throw new Error("invalid_option:event-type");
    const runId = uuid(required("run-id"), "run-id"); const stage = required("stage");
    const statusValue = option("status");
    await sendWithAutostart({ type: "event", event: { schema_version: "0.1.0", event_id: required("event-id"), cospec_run_id: runId,
      event_type: eventType, occurred_at: option("occurred-at") ?? new Date().toISOString(), stage,
      ...(statusValue ? { status: stageStatus(statusValue) } : {}) } }); return;
  }
  if (command === "finish") {
    const status = finishStatus(option("status") ?? "completed");
    await sendWithAutostart({ type: "finish", cospecRunId: uuid(required("run-id"), "run-id"), status });
    return;
  }
  if (command === "sync-artifacts") {
    await sendWithAutostart({ type: "sync_artifacts", cospecRunId: uuid(required("run-id"), "run-id"), manifestPath: required("manifest") });
    return;
  }
  if (command === "status" || command === "shutdown" || command === "scan") {
    await sendWithAutostart({ type: command });
    return;
  }
  throw new Error("usage: cospec-telemetry <ensure|event|sync-artifacts|finish|scan|status|shutdown> [options]");
}

function workflowKindOption(value: string): WorkflowKind { if (["large", "small", "custom"].includes(value)) return value as WorkflowKind; throw new Error("invalid_option:workflow-kind"); }

function agentTypeOption(value: string): AgentType {
  if (value === "codex" || value === "claude_code") return value;
  throw new Error("invalid_option:agent");
}

function finishStatus(value: string): "completed" | "failed" | "interrupted" {
  if (value === "completed" || value === "failed" || value === "interrupted") return value;
  throw new Error("invalid_option:status");
}
function stageStatus(value: string): "completed" | "failed" | "interrupted" | "skipped" {
  if (value === "skipped") return value;
  return finishStatus(value);
}

function uuid(value: string, name: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return value;
  throw new Error(`invalid_option:${name}`);
}

main().catch((error: unknown) => {
  print({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    collectorVersion: COLLECTOR_VERSION,
    protocolVersion: PROTOCOL_VERSION,
  });
});
