import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface InstallationIdentity {
  schemaVersion: 1;
  anonymousTerminalId: string;
  createdAt: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TerminalIdentityStore {
  readonly path: string;

  constructor(private readonly stateDirectory: string) {
    this.path = join(stateDirectory, "installation.json");
  }

  async getOrCreate(): Promise<string> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isInstallationIdentity(parsed)) throw new Error("invalid_terminal_identity");
      return parsed.anonymousTerminalId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as Error).message !== "invalid_terminal_identity" && !(error instanceof SyntaxError)) throw error;
      return this.create();
    }
  }

  private async create(): Promise<string> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const identity: InstallationIdentity = {
      schemaVersion: 1,
      anonymousTerminalId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
    return identity.anonymousTerminalId;
  }
}

function isInstallationIdentity(value: unknown): value is InstallationIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<InstallationIdentity>;
  return identity.schemaVersion === 1 && typeof identity.anonymousTerminalId === "string" &&
    UUID_PATTERN.test(identity.anonymousTerminalId) && typeof identity.createdAt === "string" && Number.isFinite(Date.parse(identity.createdAt));
}
