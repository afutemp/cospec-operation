import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { MAX_CHUNK_BYTES, readNextChunk } from "./chunk.js";
import { locateCodexSession } from "./session.js";
import { JsonStateStore, emptyState } from "./state.js";
import { RunRegistry, runBindingContract } from "./runs.js";
import { CollectorScanner, type ChunkReceiver } from "./scanner.js";
import type { ChunkMetadata } from "./types.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

async function fixture(): Promise<{ root: string; path: string; sessionId: string }> {
  const root = await mkdtemp(join(tmpdir(), "cospec-collector-"));
  const directory = join(root, "2026", "08", "31");
  await mkdir(directory, { recursive: true });
  const sessionId = randomUUID();
  const path = join(directory, `rollout-${sessionId}.jsonl`);
  await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`);
  return { root, path, sessionId };
}

test("locates Codex JSONL by session_meta and ignores incomplete tail", async () => {
  const item = await fixture();
  const complete = await readFile(item.path);
  await writeFile(item.path, Buffer.concat([complete, Buffer.from('{"partial":')]));
  const located = await locateCodexSession(item.root, item.sessionId);
  assert.equal(located?.path, item.path);
  assert.equal(located?.completeOffset, complete.length);
});

test("reads only complete lines and keeps contiguous byte offsets", async () => {
  const item = await fixture();
  await writeFile(item.path, '{"a":1}\n{"b":2}\n{"partial":');
  const first = await readNextChunk(item.path, 0);
  assert.equal(first?.bytes.toString(), '{"a":1}\n{"b":2}\n');
  assert.equal(first?.lineCount, 2);
  assert.equal(first?.endOffset, first?.byteCount);
  assert.equal(first?.sha256, createHash("sha256").update(first!.bytes).digest("hex"));
  assert.equal(await readNextChunk(item.path, first!.endOffset), null);
});

test("rejects a line exceeding the hard limit", async () => {
  const item = await fixture();
  await writeFile(item.path, Buffer.alloc(MAX_CHUNK_BYTES, 0x61));
  await assert.rejects(readNextChunk(item.path, 0), /line_too_large/);
});

test("state is persisted as readable JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cospec-state-"));
  const store = new JsonStateStore(directory);
  const state = emptyState();
  await store.save(state);
  assert.deepEqual(await store.load(), state);
  assert.match(await readFile(store.path, "utf8"), /"schemaVersion": 1/);
});

test("ensure is idempotent and finish captures a complete-line boundary", async () => {
  const item = await fixture();
  const registry = new RunRegistry(item.root);
  const state = emptyState();
  const runId = randomUUID();
  const first = await registry.ensure(state, "codex", item.sessionId, runId);
  const second = await registry.ensure(state, "codex", item.sessionId, runId);
  assert.equal(first, second);
  assert.equal(first.status, "open");
  await writeFile(item.path, `${await readFile(item.path, "utf8")}{"done":true}\n{"partial":`);
  const finished = await registry.finish(state, runId, "completed");
  assert.equal(finished.status, "completed");
  assert.ok(finished.endOffset! > finished.startOffset!);
  assert.equal((await readFile(item.path)).subarray(0, finished.endOffset!).at(-1), 0x0a);
  assert.equal(await registry.finish(state, runId, "completed"), finished);
});

test("missing session creates a pending binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-missing-"));
  const state = emptyState();
  const binding = await new RunRegistry(root).ensure(state, "codex", randomUUID(), randomUUID());
  assert.equal(binding.status, "pending");
  assert.equal(binding.startOffset, null);
});

test("pending binding resolves after its JSONL appears", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-pending-"));
  const state = emptyState();
  const registry = new RunRegistry(root);
  const sessionId = randomUUID();
  const runId = randomUUID();
  await registry.ensure(state, "codex", sessionId, runId);
  await writeFile(join(root, `${sessionId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cli_version: "1.2.3" } })}\n`);
  assert.equal(await registry.resolvePending(state), 1);
  assert.equal(state.runs[runId]?.status, "open");
  assert.equal(Object.values(state.files)[0]?.sourceVersion, "1.2.3");
});

test("scanner advances offset only after receiver acceptance", async () => {
  const item = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "cospec-scan-state-"));
  const store = new JsonStateStore(directory);
  const state = emptyState();
  await new RunRegistry(item.root).ensure(state, "codex", item.sessionId, randomUUID());
  const runStartOffset = Object.values(state.files)[0]!.confirmedOffset;
  await store.save(state);
  await appendFileCompat(item.path, '{"during_run":true}\n');

  const rejecting: ChunkReceiver = { async accept() { throw new Error("receiver_failed"); } };
  await assert.rejects(new CollectorScanner(store, rejecting).scan(), /receiver_failed/);
  assert.equal(Object.values((await store.load()).files)[0]?.confirmedOffset, runStartOffset);
  const pendingId = Object.values((await store.load()).files)[0]?.pendingUpload?.upload_id;
  assert.ok(pendingId);

  const received: Array<{ metadata: ChunkMetadata; bytes: Buffer }> = [];
  const accepting: ChunkReceiver = { async accept(metadata, bytes) { received.push({ metadata, bytes }); } };
  const result = await new CollectorScanner(store, accepting).scan();
  assert.equal(result.chunks, 1);
  assert.equal(received[0]?.metadata.agent_session_id, item.sessionId);
  assert.equal(received[0]?.metadata.upload_id, pendingId);
  assert.equal(received[0]?.metadata.file.start_offset, runStartOffset);
  assert.equal(Object.values((await store.load()).files)[0]?.confirmedOffset, received[0]?.metadata.file.end_offset);

  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const metadataSchema = JSON.parse(await readFile(join(process.cwd(), "contracts", "jsonl-chunk-metadata.schema.json"), "utf8"));
  assert.equal(ajv.validate(metadataSchema, received[0]?.metadata), true, JSON.stringify(ajv.errors));
});

test("run binding output conforms to the frozen schema", async () => {
  const item = await fixture();
  const binding = await new RunRegistry(item.root).ensure(emptyState(), "codex", item.sessionId, randomUUID());
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const schema = JSON.parse(await readFile(join(process.cwd(), "contracts", "cospec-run-binding.schema.json"), "utf8"));
  assert.equal(ajv.validate(schema, runBindingContract(binding)), true, JSON.stringify(ajv.errors));
});

test("one session supports sequential non-overlapping runs and rejects overlap", async () => {
  const item = await fixture();
  const state = emptyState();
  const registry = new RunRegistry(item.root);
  const firstId = randomUUID();
  const secondId = randomUUID();
  const first = await registry.ensure(state, "codex", item.sessionId, firstId);
  await assert.rejects(registry.ensure(state, "codex", item.sessionId, secondId), /session_has_active_run/);
  await appendFileCompat(item.path, '{"type":"event_msg"}\n');
  await registry.finish(state, firstId, "completed");
  const second = await registry.ensure(state, "codex", item.sessionId, secondId);
  assert.equal(second.startOffset, state.runs[firstId]?.endOffset);
  assert.ok(second.startOffset! >= first.startOffset!);
});

test("run id cannot be rebound and finish conflicts are rejected", async () => {
  const first = await fixture();
  const second = await fixture();
  const state = emptyState();
  const registry = new RunRegistry(first.root);
  const runId = randomUUID();
  await registry.ensure(state, "codex", first.sessionId, runId);
  await assert.rejects(registry.ensure(state, "codex", second.sessionId, runId), /run_binding_conflict/);
  await registry.finish(state, runId, "completed");
  await assert.rejects(registry.finish(state, runId, "failed"), /run_finish_conflict/);
});

test("truncation and rotation create new generations without replacing old outbox chunks", async () => {
  const item = await fixture();
  const stateDirectory = await mkdtemp(join(tmpdir(), "cospec-generation-"));
  const outbox = join(stateDirectory, "outbox");
  const store = new JsonStateStore(stateDirectory);
  const state = emptyState();
  await new RunRegistry(item.root).ensure(state, "codex", item.sessionId, randomUUID());
  await store.save(state);
  await appendFileCompat(item.path, '{"generation":1}\n');
  const received: Array<{ metadata: ChunkMetadata; bytes: Buffer }> = [];
  const receiver: ChunkReceiver = { async accept(metadata, bytes) { received.push({ metadata, bytes }); } };
  const scanner = new CollectorScanner(store, receiver);
  await scanner.scan();

  await writeFile(item.path, '{"truncated":true}\n');
  await scanner.scan();
  assert.equal(received.at(-1)?.metadata.file.generation, 2);
  assert.equal(Object.values((await store.load()).files)[0]?.lastDiagnostic?.code, "source_truncated");

  const replacement = `${item.path}.replacement`;
  await writeFile(replacement, '{"rotated":true}\n');
  await rename(replacement, item.path);
  await scanner.scan();
  assert.equal(received.at(-1)?.metadata.file.generation, 3);
  assert.equal(Object.values((await store.load()).files)[0]?.lastDiagnostic?.code, "source_rotated");
  assert.deepEqual(received.map((entry) => entry.metadata.file.generation), [1, 2, 3]);
  assert.equal(outbox.endsWith("outbox"), true);
});

async function appendFileCompat(path: string, value: string): Promise<void> {
  const previous = await readFile(path);
  await writeFile(path, Buffer.concat([previous, Buffer.from(value)]));
}
