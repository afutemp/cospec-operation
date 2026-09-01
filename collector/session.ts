import { createReadStream } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentType } from "./types.js";

export interface LocatedSession { path: string; completeOffset: number; identity: string; sourceVersion: string }
export interface LocatedSubagent extends LocatedSession {
  agentSessionId: string; parentAgentSessionId: string; agentPath: string | null;
}

export async function locateCodexSession(root: string, sessionId: string): Promise<LocatedSession | null> {
  const candidates = await jsonlFiles(root);
  const preferred = candidates.filter((path) => path.includes(sessionId));
  for (const path of [...preferred, ...candidates.filter((item) => !preferred.includes(item))]) {
    const first = await firstLine(path);
    if (!first) continue;
    try {
      const record = JSON.parse(first) as { type?: string; payload?: { id?: string; cli_version?: string } };
      if (record.type !== "session_meta" || record.payload?.id !== sessionId) continue;
      const info = await stat(path, { bigint: true });
      return {
        path: await realpath(path),
        completeOffset: await lastCompleteLineOffset(path, Number(info.size)),
        identity: `${info.dev}:${info.ino}:${info.birthtimeNs}`,
        sourceVersion: record.payload.cli_version ?? "unknown",
      };
    } catch { continue; }
  }
  return null;
}

export async function locateClaudeCodeSession(root: string, sessionId: string): Promise<LocatedSession | null> {
  const candidates = (await jsonlFiles(root)).filter((path) => path.endsWith(`/${sessionId}.jsonl`) || path.endsWith(`\\${sessionId}.jsonl`));
  for (const path of candidates) {
    const sample = await firstBytes(path);
    let matched = false;
    let sourceVersion = "unknown";
    for (const line of sample.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as { sessionId?: unknown; version?: unknown };
        if (record.sessionId !== sessionId) continue;
        matched = true;
        if (typeof record.version === "string" && record.version) sourceVersion = record.version;
      } catch { continue; }
    }
    if (!matched) continue;
    const info = await stat(path, { bigint: true });
    return {
      path: await realpath(path),
      completeOffset: await lastCompleteLineOffset(path, Number(info.size)),
      identity: `${info.dev}:${info.ino}:${info.birthtimeNs}`,
      sourceVersion,
    };
  }
  return null;
}

export async function locateSubagents(agentType: AgentType, root: string, rootSessionId: string, mainPath: string,
  startOffset: number, endOffset: number): Promise<LocatedSubagent[]> {
  return agentType === "codex"
    ? locateCodexSubagents(root, rootSessionId, mainPath, startOffset, endOffset)
    : locateClaudeSubagents(root, rootSessionId, mainPath, startOffset, endOffset);
}

async function locateCodexSubagents(root: string, rootSessionId: string, mainPath: string, start: number, end: number): Promise<LocatedSubagent[]> {
  const directPaths = await codexSpawnPaths(mainPath, start, end);
  const catalog: Array<LocatedSubagent & { parentThreadId: string }> = [];
  for (const path of await jsonlFiles(root)) {
    const first = await firstLine(path); if (!first) continue;
    try {
      const record = JSON.parse(first) as { type?: string; payload?: Record<string, unknown> };
      const payload = record.payload;
      if (record.type !== "session_meta" || !payload || typeof payload.id !== "string" || typeof payload.parent_thread_id !== "string" ||
          typeof payload.agent_path !== "string" || typeof payload.source !== "object" || payload.source === null || !("subagent" in payload.source)) continue;
      const located = await locatedFile(path, typeof payload.cli_version === "string" ? payload.cli_version : "unknown");
      catalog.push({ ...located, agentSessionId: payload.id, parentAgentSessionId: payload.parent_thread_id,
        parentThreadId: payload.parent_thread_id, agentPath: payload.agent_path });
    } catch { continue; }
  }
  const selected = new Map<string, LocatedSubagent>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of catalog) {
      if (selected.has(item.agentSessionId)) continue;
      if (directPaths.has(item.agentPath ?? "") || selected.has(item.parentThreadId)) {
        selected.set(item.agentSessionId, item); changed = true;
      }
    }
  }
  return [...selected.values()];
}

async function locateClaudeSubagents(root: string, rootSessionId: string, mainPath: string, start: number, end: number): Promise<LocatedSubagent[]> {
  const catalog = new Map<string, LocatedSession>();
  for (const path of await jsonlFiles(root)) {
    if (!path.includes("subagents")) continue;
    const sample = await firstBytes(path); let agentId: string | null = null; let version = "unknown"; let matchesRoot = false;
    for (const line of sample.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.sessionId === rootSessionId) matchesRoot = true;
        if (typeof record.agentId === "string") agentId = record.agentId;
        if (typeof record.version === "string") version = record.version;
      } catch { continue; }
      if (agentId && matchesRoot && version !== "unknown") break;
    }
    if (agentId && matchesRoot) catalog.set(agentId, await locatedFile(path, version));
  }
  const queue: Array<{ id: string; parent: string }> = [...await claudeSpawnIds(mainPath, start, end)].map((id) => ({ id, parent: rootSessionId }));
  const selected = new Map<string, LocatedSubagent>();
  while (queue.length) {
    const next = queue.shift()!; if (selected.has(next.id)) continue;
    const located = catalog.get(next.id); if (!located) continue;
    selected.set(next.id, { ...located, agentSessionId: next.id, parentAgentSessionId: next.parent, agentPath: `agent-${next.id}` });
    for (const child of await claudeSpawnIds(located.path, 0, located.completeOffset)) queue.push({ id: child, parent: next.id });
  }
  return [...selected.values()];
}

async function codexSpawnPaths(path: string, start: number, end: number): Promise<Set<string>> {
  const calls = new Set<string>(); const paths = new Set<string>();
  for await (const record of records(path, start, end)) {
    const payload = object(record.payload); if (record.type !== "response_item" || !payload) continue;
    if ((payload.type === "function_call" || payload.type === "custom_tool_call") && payload.name === "spawn_agent" && typeof payload.call_id === "string") calls.add(payload.call_id);
    if ((payload.type === "function_call_output" || payload.type === "custom_tool_call_output") && typeof payload.call_id === "string" && calls.has(payload.call_id) && typeof payload.output === "string") {
      try { const value = object(JSON.parse(payload.output)); if (value && typeof value.task_name === "string") paths.add(value.task_name); } catch { continue; }
    }
  }
  return paths;
}

async function claudeSpawnIds(path: string, start: number, end: number): Promise<Set<string>> {
  const ids = new Set<string>();
  for await (const record of records(path, start, end)) {
    const result = object(record.toolUseResult);
    if (result && typeof result.agentId === "string") ids.add(result.agentId);
  }
  return ids;
}

async function* records(path: string, start: number, end: number): AsyncGenerator<Record<string, unknown>> {
  if (end <= start) return;
  const input = createReadStream(path, { start, end: end - 1, encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try { const value = JSON.parse(line); if (object(value)) yield value; } catch { continue; }
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function locatedFile(path: string, sourceVersion: string): Promise<LocatedSession> {
  const info = await stat(path, { bigint: true });
  return { path: await realpath(path), completeOffset: await lastCompleteLineOffset(path, Number(info.size)),
    identity: `${info.dev}:${info.ino}:${info.birthtimeNs}`, sourceVersion };
}

async function jsonlFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(entry.parentPath, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function firstLine(path: string): Promise<string | null> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) return null;
    return buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
  } finally { await handle.close(); }
}

async function firstBytes(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

export async function lastCompleteLineOffset(path: string, size?: number): Promise<number> {
  const fileSize = size ?? Number((await stat(path)).size);
  if (fileSize === 0) return 0;
  const handle = await open(path, "r");
  try {
    const step = 64 * 1024;
    let end = fileSize;
    while (end > 0) {
      const start = Math.max(0, end - step);
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      const newline = buffer.lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      end = start;
    }
    return 0;
  } finally { await handle.close(); }
}
