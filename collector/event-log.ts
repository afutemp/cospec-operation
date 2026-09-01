import { mkdir, rename, stat, unlink, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CollectorLogEvent {
  at: string;
  level: "info" | "warn" | "error";
  event: string;
  code?: string;
  cospec_run_id?: string;
  source_file_id?: string;
  chunks?: number;
  bytes?: number;
  consecutive_failures?: number;
}

export class CollectorEventLog {
  readonly path: string;

  constructor(
    stateDirectory: string,
    private readonly maximumBytes = 5 * 1024 * 1024,
    private readonly retainedFiles = 2,
  ) {
    this.path = join(stateDirectory, "logs", "collector.jsonl");
  }

  async write(event: Omit<CollectorLogEvent, "at"> & { at?: string }): Promise<void> {
    const line = `${JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() })}\n`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await this.rotateIfNeeded(Buffer.byteLength(line));
    await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let currentBytes = 0;
    try { currentBytes = (await stat(this.path)).size; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (currentBytes === 0 || currentBytes + incomingBytes <= this.maximumBytes) return;
    for (let index = this.retainedFiles; index >= 1; index -= 1) {
      const target = `${this.path}.${index}`;
      if (index === this.retainedFiles) await unlink(target).catch(ignoreMissing);
      const source = index === 1 ? this.path : `${this.path}.${index - 1}`;
      await rename(source, target).catch(ignoreMissing);
    }
  }
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
