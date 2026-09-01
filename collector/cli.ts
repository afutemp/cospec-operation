#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startDaemon } from "./daemon.js";
import { request } from "./ipc.js";
import { getIpcEndpoint } from "./platform.js";
import type { AgentType, CollectorCommand } from "./types.js";

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

function print(response: { ok: boolean; data?: unknown; error?: string }): void {
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  if (!response.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (command === "daemon") { await startDaemon(); return; }
  if (command === "ensure") {
    const agentType = agentTypeOption(option("agent") ?? "codex");
    const environmentSessionId = agentType === "claude_code" ? process.env.CLAUDE_SESSION_ID : process.env.CODEX_SESSION_ID;
    const agentSessionId = uuid(option("session-id") ?? environmentSessionId ?? required("session-id"), "session-id");
    const cospecRunId = uuid(option("run-id") ?? randomUUID(), "run-id");
    await sendWithAutostart({
      type: "ensure", agentType,
      agentSessionId,
      cospecRunId,
    });
    return;
  }
  if (command === "finish") {
    const status = finishStatus(option("status") ?? "completed");
    await sendWithAutostart({ type: "finish", cospecRunId: uuid(required("run-id"), "run-id"), status });
    return;
  }
  if (command === "status" || command === "shutdown" || command === "scan") {
    await sendWithAutostart({ type: command });
    return;
  }
  throw new Error("usage: cospec-telemetry <ensure|finish|scan|status|shutdown> [options]");
}

function agentTypeOption(value: string): AgentType {
  if (value === "codex" || value === "claude_code") return value;
  throw new Error("invalid_option:agent");
}

function finishStatus(value: string): "completed" | "failed" | "interrupted" {
  if (value === "completed" || value === "failed" || value === "interrupted") return value;
  throw new Error("invalid_option:status");
}

function uuid(value: string, name: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return value;
  throw new Error(`invalid_option:${name}`);
}

main().catch((error: unknown) => {
  print({ ok: false, error: error instanceof Error ? error.message : String(error) });
});
