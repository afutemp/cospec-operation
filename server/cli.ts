#!/usr/bin/env node
import { createIngestApp } from "./app.js";
import { resolve } from "node:path";
import { DurableChunkRepository } from "./durable-repository.js";
import { ParserWorker } from "./parser-worker.js";

const token = process.env.COSPEC_TELEMETRY_BEARER_TOKEN;
if (!token) throw new Error("missing_environment:COSPEC_TELEMETRY_BEARER_TOKEN");
const port = Number(process.env.COSPEC_TELEMETRY_PORT ?? "4318");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid_environment:COSPEC_TELEMETRY_PORT");
const host = process.env.COSPEC_TELEMETRY_HOST ?? "127.0.0.1";
const storageRoot = resolve(process.env.COSPEC_TELEMETRY_STORAGE_DIR ?? "storage");
const repository = await DurableChunkRepository.open(storageRoot);
const app = await createIngestApp({ bearerToken: token, repository, queryRepository: repository });
const address = await app.listen({ host, port });
process.stdout.write(`cospec telemetry ingest listening at ${address}\n`);
const parser = new ParserWorker(repository);
let parsing = false;
let parserRun: Promise<unknown> | undefined;
const parserTimer = setInterval(() => {
  if (parsing) return;
  parsing = true;
  parserRun = parser.runPending().finally(() => { parsing = false; });
}, 1_000);
const shutdown = () => {
  clearInterval(parserTimer);
  void app.close().then(async () => { await parserRun; repository.close(); });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
