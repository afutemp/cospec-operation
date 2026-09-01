#!/usr/bin/env node
import { resolve } from "node:path";
import { DurableChunkRepository } from "./durable-repository.js";
import { ParserRegistry } from "./parser-registry.js";
import { ReplayService } from "./replay.js";

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const runId = option("run-id");
const parserVersion = option("parser-version");
if (!runId || !parserVersion) throw new Error("usage: replay --run-id <UUID> --parser-version <installed-version>");
const root = resolve(process.env.COSPEC_TELEMETRY_STORAGE_DIR ?? "storage");
const repository = await DurableChunkRepository.open(root);
try {
  const result = await new ReplayService(repository, new ParserRegistry()).replayRun(runId, parserVersion);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "completed") process.exitCode = 1;
} finally { repository.close(); }
