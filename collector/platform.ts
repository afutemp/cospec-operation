import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

function userKey(): string {
  const source = process.getuid ? String(process.getuid()) : userInfo().username;
  return createHash("sha256").update(source).digest("hex").slice(0, 12);
}

export function getIpcEndpoint(namespace = process.env.COSPEC_TELEMETRY_NAMESPACE ?? "default"): string {
  const key = `${userKey()}-${namespace.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\cospec-telemetry-${key}`
    : `\0cospec-telemetry-${key}`;
}

export function getStateDirectory(): string {
  if (process.env.COSPEC_TELEMETRY_STATE_DIR) return process.env.COSPEC_TELEMETRY_STATE_DIR;
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "CospecTelemetry");
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "cospec-telemetry");
}

export function getCodexSessionsRoot(): string {
  return process.env.CODEX_SESSIONS_ROOT ?? join(homedir(), ".codex", "sessions");
}
