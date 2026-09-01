import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CollectorState } from "./types.js";

export const emptyState = (): CollectorState => ({ schemaVersion: 1, files: {}, runs: {} });

export class JsonStateStore {
  readonly path: string;
  constructor(stateDirectory: string) { this.path = join(stateDirectory, "state.json"); }

  async load(): Promise<CollectorState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isCollectorState(parsed)) throw new Error("invalid collector state");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async save(state: CollectorState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function isCollectorState(value: unknown): value is CollectorState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<CollectorState>;
  return state.schemaVersion === 1 && !!state.files && typeof state.files === "object" && !!state.runs && typeof state.runs === "object";
}
