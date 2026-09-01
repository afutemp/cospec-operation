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
    const agentType = (option("agent") ?? "codex") as AgentType;
    await sendWithAutostart({
      type: "ensure", agentType,
      agentSessionId: option("session-id") ?? process.env.CODEX_SESSION_ID ?? required("session-id"),
      cospecRunId: option("run-id") ?? randomUUID(),
    });
    return;
  }
  if (command === "finish") {
    const status = (option("status") ?? "completed") as "completed" | "failed" | "interrupted";
    await sendWithAutostart({ type: "finish", cospecRunId: required("run-id"), status });
    return;
  }
  if (command === "status" || command === "shutdown" || command === "scan") {
    await sendWithAutostart({ type: command });
    return;
  }
  throw new Error("usage: cospec-telemetry <ensure|finish|scan|status|shutdown> [options]");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
