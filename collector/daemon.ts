import type { Server } from "node:net";
import { getCodexSessionsRoot, getIpcEndpoint, getStateDirectory } from "./platform.js";
import { listen } from "./ipc.js";
import { RunRegistry } from "./runs.js";
import { JsonStateStore } from "./state.js";
import { CollectorScanner, FileOutboxReceiver } from "./scanner.js";
import { HttpChunkReceiver } from "./http-receiver.js";
import type { CollectorCommand, CommandResponse } from "./types.js";

export interface DaemonOptions { endpoint?: string; stateDirectory?: string; sessionsRoot?: string }

export async function startDaemon(options: DaemonOptions = {}): Promise<Server> {
  const store = new JsonStateStore(options.stateDirectory ?? getStateDirectory());
  const registry = new RunRegistry(options.sessionsRoot ?? getCodexSessionsRoot());
  const stateDirectory = options.stateDirectory ?? getStateDirectory();
  const receiver = process.env.COSPEC_TELEMETRY_SERVER_URL
    ? new HttpChunkReceiver({
        baseUrl: process.env.COSPEC_TELEMETRY_SERVER_URL,
        bearerToken: requiredEnvironment("COSPEC_TELEMETRY_BEARER_TOKEN"),
      })
    : new FileOutboxReceiver(`${stateDirectory}/outbox`);
  const scanner = new CollectorScanner(store, receiver);
  let queue = Promise.resolve<unknown>(undefined);
  let server: Server;

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const operation = queue.then(work, work);
    queue = operation;
    return operation;
  };

  const scan = async () => {
    const state = await store.load();
    const resolved = await registry.resolvePending(state);
    if (resolved > 0) await store.save(state);
    return scanner.scan();
  };

  const handle = (command: CollectorCommand): Promise<CommandResponse> => {
    return enqueue(async () => {
      const state = await store.load();
      if (command.type === "status") return { ok: true, data: state };
      if (command.type === "ensure") {
        const binding = await registry.ensure(state, command.agentType, command.agentSessionId, command.cospecRunId);
        await store.save(state);
        return { ok: true, data: binding };
      }
      if (command.type === "finish") {
        const binding = await registry.finish(state, command.cospecRunId, command.status);
        await store.save(state);
        await scanner.scan();
        return { ok: true, data: binding };
      }
      if (command.type === "scan") return { ok: true, data: await scan() };
      setImmediate(() => server.close());
      return { ok: true };
    }).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  };
  server = await listen(options.endpoint ?? getIpcEndpoint(), handle);
  const scanTimer = setInterval(() => { void enqueue(scan).catch(() => undefined); }, 1_000);
  server.once("close", () => clearInterval(scanTimer));
  const shutdown = () => server.close();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}
