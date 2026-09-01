import type { Server } from "node:net";
import { getClaudeCodeSessionsRoot, getCodexSessionsRoot, getIpcEndpoint, getStateDirectory } from "./platform.js";
import { listen } from "./ipc.js";
import { RunRegistry } from "./runs.js";
import { JsonStateStore } from "./state.js";
import { CollectorScanner, FileOutboxReceiver, ScanCycleError, type ChunkReceiver } from "./scanner.js";
import { HttpChunkReceiver } from "./http-receiver.js";
import { CollectorEventLog } from "./event-log.js";
import type { CollectorCommand, CollectorDiagnostics, CollectorState, CommandResponse } from "./types.js";

export interface DaemonOptions {
  endpoint?: string;
  stateDirectory?: string;
  sessionsRoot?: string;
  claudeCodeSessionsRoot?: string;
  receiver?: ChunkReceiver;
  scanIntervalMs?: number;
}

export const DEFAULT_SCAN_INTERVAL_MS = 5 * 60 * 1_000;

export async function startDaemon(options: DaemonOptions = {}): Promise<Server> {
  const scanIntervalMs = options.scanIntervalMs ?? scanIntervalFromEnvironment();
  const store = new JsonStateStore(options.stateDirectory ?? getStateDirectory());
  const registry = new RunRegistry({
    codex: options.sessionsRoot ?? getCodexSessionsRoot(),
    claude_code: options.claudeCodeSessionsRoot ?? getClaudeCodeSessionsRoot(),
  });
  const stateDirectory = options.stateDirectory ?? getStateDirectory();
  const receiver = options.receiver ?? (process.env.COSPEC_TELEMETRY_SERVER_URL
    ? new HttpChunkReceiver({
        baseUrl: process.env.COSPEC_TELEMETRY_SERVER_URL,
        bearerToken: requiredEnvironment("COSPEC_TELEMETRY_BEARER_TOKEN"),
      })
    : new FileOutboxReceiver(`${stateDirectory}/outbox`));
  const scanner = new CollectorScanner(store, receiver);
  const eventLog = new CollectorEventLog(stateDirectory);
  let queue = Promise.resolve<unknown>(undefined);
  let server: Server;
  let lastScanAt: string | null = null;

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const operation = queue.then(work, work);
    queue = operation;
    return operation;
  };

  const scan = async () => {
    lastScanAt = new Date().toISOString();
    try {
      const state = await store.load();
      const resolved = await registry.resolvePending(state);
      if (resolved > 0) await store.save(state);
      const result = await scanner.scan();
      const current = await store.load();
      const diagnostics = ensureDiagnostics(current);
      const wasFailing = diagnostics.consecutiveFailures > 0;
      diagnostics.lastScanAt = lastScanAt;
      if (result.chunks > 0) diagnostics.lastSuccessAt = lastScanAt;
      diagnostics.consecutiveFailures = 0;
      diagnostics.lastError = null;
      if (wasFailing) {
        diagnostics.recoveredAt = lastScanAt;
        await eventLog.write({ level: "info", event: "scan_recovered" });
      }
      if (wasFailing || result.chunks > 0) await store.save(current);
      if (result.chunks > 0) await eventLog.write({ level: "info", event: "chunks_uploaded", chunks: result.chunks, bytes: result.bytes });
      return result;
    } catch (error) {
      if (error instanceof ScanCycleError && error.completedChunks > 0) {
        const current = await store.load();
        ensureDiagnostics(current).lastSuccessAt = lastScanAt;
        await store.save(current);
        await eventLog.write({ level: "info", event: "chunks_uploaded", chunks: error.completedChunks, bytes: error.completedBytes });
      }
      await recordFailure(store, eventLog, lastScanAt, error);
      throw error;
    }
  };

  const handle = (command: CollectorCommand): Promise<CommandResponse> => {
    return enqueue(async () => {
      const state = await store.load();
      if (command.type === "status") {
        const diagnostics = ensureDiagnostics(state);
        diagnostics.lastScanAt = lastScanAt ?? diagnostics.lastScanAt;
        return { ok: true, data: state };
      }
      if (command.type === "ensure") {
        const binding = await registry.ensure(state, command.agentType, command.agentSessionId, command.cospecRunId);
        await store.save(state);
        await eventLog.write({ level: "info", event: "run_ensured", cospec_run_id: binding.cospecRunId, ...(binding.sourceFileId ? { source_file_id: binding.sourceFileId } : {}) });
        setImmediate(() => { void enqueue(scan).catch(() => undefined); });
        return { ok: true, data: binding };
      }
      if (command.type === "finish") {
        const binding = await registry.finish(state, command.cospecRunId, command.status);
        await store.save(state);
        await eventLog.write({ level: "info", event: "run_finished", cospec_run_id: binding.cospecRunId, ...(binding.sourceFileId ? { source_file_id: binding.sourceFileId } : {}) });
        await scan();
        return { ok: true, data: binding };
      }
      if (command.type === "scan") return { ok: true, data: await scan() };
      await eventLog.write({ level: "info", event: "daemon_stopping" });
      setImmediate(() => server.close());
      return { ok: true };
    }).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  };
  server = await listen(options.endpoint ?? getIpcEndpoint(), handle);
  await eventLog.write({ level: "info", event: "daemon_started" });
  const scanTimer = setInterval(() => { void enqueue(scan).catch(() => undefined); }, scanIntervalMs);
  server.once("close", () => clearInterval(scanTimer));
  const shutdown = () => { void eventLog.write({ level: "info", event: "daemon_stopping" }).finally(() => server.close()); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

function ensureDiagnostics(state: CollectorState): CollectorDiagnostics {
  return state.diagnostics ??= { lastScanAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastError: null, recoveredAt: null };
}

async function recordFailure(store: JsonStateStore, eventLog: CollectorEventLog, at: string, error: unknown): Promise<void> {
  const state = await store.load();
  const diagnostics = ensureDiagnostics(state);
  const code = safeErrorCode(error);
  const stage = code.startsWith("upload_") || code === "invalid_upload_response" ? "upload" : "scan";
  const context = diagnosticContext(state);
  diagnostics.lastScanAt = at;
  diagnostics.consecutiveFailures += 1;
  diagnostics.lastError = { at, stage, code, ...context };
  await store.save(state);
  await eventLog.write({ level: "error", event: "scan_failed", code, consecutive_failures: diagnostics.consecutiveFailures,
    ...(context.cospecRunId ? { cospec_run_id: context.cospecRunId } : {}),
    ...(context.sourceFileId ? { source_file_id: context.sourceFileId } : {}) });
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "scan_failed";
  if (/^(upload_(timeout|network_error|http_\d{3})|invalid_upload_response|source_changed_during_retry|line_too_large)$/.test(message)) return message;
  const systemCode = (error as NodeJS.ErrnoException | undefined)?.code;
  if (systemCode === "ENOENT") return "source_missing";
  if (systemCode === "EACCES" || systemCode === "EPERM") return "source_permission_denied";
  return "scan_failed";
}

function diagnosticContext(state: CollectorState): { cospecRunId?: string; sourceFileId?: string } {
  const run = Object.values(state.runs).find((item) => item.status === "open" || (item.endOffset !== null && item.sourceFileId && state.files[item.sourceFileId]?.confirmedOffset !== item.endOffset));
  return run ? { cospecRunId: run.cospecRunId, ...(run.sourceFileId ? { sourceFileId: run.sourceFileId } : {}) } : {};
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

function scanIntervalFromEnvironment(): number {
  const configured = process.env.COSPEC_TELEMETRY_SCAN_INTERVAL_MS;
  if (configured === undefined) return DEFAULT_SCAN_INTERVAL_MS;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < 10) throw new Error("invalid_environment:COSPEC_TELEMETRY_SCAN_INTERVAL_MS");
  return value;
}
