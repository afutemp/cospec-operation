import { open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

export interface LocatedSession { path: string; completeOffset: number; identity: string; sourceVersion: string }

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
