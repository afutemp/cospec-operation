import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

export const TARGET_CHUNK_BYTES = 5 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 10 * 1024 * 1024;

export interface JsonlChunk {
  bytes: Buffer;
  startOffset: number;
  endOffset: number;
  byteCount: number;
  lineCount: number;
  sha256: string;
}

export async function readNextChunk(path: string, offset: number, maximumEndOffset?: number): Promise<JsonlChunk | null> {
  const before = await stat(path, { bigint: true });
  if (BigInt(offset) > before.size) throw new Error("source_truncated");
  const boundedSize = maximumEndOffset === undefined ? before.size : BigInt(Math.min(Number(before.size), maximumEndOffset));
  const available = Math.min(Number(boundedSize - BigInt(offset)), MAX_CHUNK_BYTES);
  if (available === 0) return null;
  const handle = await open(path, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(available);
    const result = await handle.read(buffer, 0, available, offset);
    buffer = buffer.subarray(0, result.bytesRead);
  } finally { await handle.close(); }

  const preferred = buffer.subarray(0, Math.min(buffer.length, TARGET_CHUNK_BYTES)).lastIndexOf(0x0a);
  let boundary = preferred >= 0 ? preferred + 1 : buffer.indexOf(0x0a, Math.min(buffer.length, TARGET_CHUNK_BYTES)) + 1;
  if (boundary === 0) {
    if (buffer.length === MAX_CHUNK_BYTES) throw new Error("line_too_large");
    return null;
  }
  buffer = buffer.subarray(0, boundary);
  const after = await stat(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size > after.size) throw new Error("source_changed_during_read");
  return {
    bytes: buffer, startOffset: offset, endOffset: offset + buffer.length,
    byteCount: buffer.length, lineCount: buffer.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0),
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}
