import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpChunkReceiver } from "../collector/http-receiver.js";
import { RunRegistry } from "../collector/runs.js";
import { CollectorScanner } from "../collector/scanner.js";
import { emptyState, JsonStateStore } from "../collector/state.js";
import type { ArtifactMetadata, ChunkMetadata } from "../collector/types.js";
import { createIngestApp } from "./app.js";
import { MemoryChunkRepository } from "./memory-repository.js";

const TOKEN = "integration-secret-value";

test("real HTTP multipart upload is accepted and idempotent", async () => {
  const repository = new MemoryChunkRepository();
  const app = await createIngestApp({ bearerToken: TOKEN, repository });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const receiver = new HttpChunkReceiver({ baseUrl: address, bearerToken: TOKEN });
    const firstBytes = Buffer.from('{"first":true}\n');
    const first = metadata(firstBytes, 120, null);
    await receiver.accept(first, firstBytes);
    await receiver.accept(first, firstBytes);
    assert.equal(repository.chunkCount, 1);

    const sameRangeNewUpload = { ...first, upload_id: randomUUID() };
    await receiver.accept(sameRangeNewUpload, firstBytes);
    assert.equal(repository.chunkCount, 1);

    const secondBytes = Buffer.from('{"second":true}\n');
    const second = metadata(secondBytes, first.file.end_offset, first.file.sha256, first.cospec_run_id, first.file.source_file_id);
    await receiver.accept(second, secondBytes);
    assert.equal(repository.chunkCount, 2);
  } finally { await app.close(); }
});

test("workflow lifecycle events are accepted idempotently and queryable", async () => {
  const repository = new MemoryChunkRepository();
  const app = await createIngestApp({ bearerToken: TOKEN, repository });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const runId = randomUUID();
  const event = {
    schema_version: "0.1.0", event_id: randomUUID(), cospec_run_id: runId,
    event_type: "run_started", occurred_at: new Date().toISOString(),
    workflow_kind: "small", workflow_name: "small-requirement-workflow",
    actor: { employee_id: "63027", display_name: "测试规划员", proposer_dept: "研发体系/工程技术部" },
  };
  try {
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${address}/api/v1/run-events`, {
        method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(event),
      });
      assert.equal(response.status, 200);
    }
    const response = await fetch(`${address}/api/v1/runs/${runId}/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { items: unknown[] }).items.length, 1);
    assert.deepEqual(repository.getRunEvents(runId)[0]?.actor, { employee_id: "63027", display_name: "测试规划员", proposer_dept: "研发体系/工程技术部" });
  } finally { await app.close(); }
});

test("formal artifact uploads are idempotent, queryable and downloadable with authentication", async () => {
  const repository = new MemoryChunkRepository(); const app = await createIngestApp({ bearerToken: TOKEN, repository });
  const address = await app.listen({ host: "127.0.0.1", port: 0 }); const bytes = Buffer.from("# 评审版\n"); const runId = randomUUID();
  const artifact: ArtifactMetadata = { schema_version: "0.1.0", upload_id: randomUUID(), cospec_run_id: runId, skill: "tr1-requirements-spec", attempt_id: "attempt-1", artifact_index: 0, artifact_role: "tr1_deliverable", file_name: "评审版.md", logical_path: "outputs/tr1-requirements-spec/评审版.md", content_type: "text/markdown", size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), created_at: new Date().toISOString() };
  try {
    const receiver = new HttpChunkReceiver({ baseUrl: address, bearerToken: TOKEN });
    await receiver.acceptArtifact(artifact, bytes); await receiver.acceptArtifact(artifact, bytes);
    const listed = await fetch(`${address}/api/v1/runs/${runId}/artifacts`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(listed.status, 200); const listedItems = (await listed.json() as { items: Array<{ logical_path: string }> }).items; assert.equal(listedItems.length, 1); assert.equal(listedItems[0]?.logical_path, "outputs/tr1-requirements-spec/评审版.md");
    const download = await fetch(`${address}/api/v1/artifacts/${artifact.upload_id}/download`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal((await fetch(`${address}/api/v1/artifacts/${artifact.upload_id}/download`)).status, 401);
    await assert.rejects(new HttpChunkReceiver({ baseUrl: address, bearerToken: TOKEN }).acceptArtifact({ ...artifact, upload_id: randomUUID(), logical_path: "../private/TR1.md" }, bytes), /upload_http_400/);
  } finally { await app.close(); }
});

test("collector cursor advances on HTTP confirmation and stays put on HTTP rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-http-cursor-"));
  const sessionsRoot = join(root, "sessions");
  const stateDirectory = join(root, "state");
  await mkdir(sessionsRoot);
  const sessionId = randomUUID();
  const sessionPath = join(sessionsRoot, `${sessionId}.jsonl`);
  await writeFile(sessionPath, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cli_version: "0.150.1" } })}\n`);
  const store = new JsonStateStore(stateDirectory);
  const stateValue = emptyState();
  await new RunRegistry(sessionsRoot).ensure(stateValue, "codex", sessionId, randomUUID());
  const startOffset = Object.values(stateValue.files)[0]!.confirmedOffset;
  await store.save(stateValue);

  const app = await createIngestApp({ bearerToken: TOKEN });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    await appendFile(sessionPath, '{"accepted":true}\n');
    await new CollectorScanner(store, new HttpChunkReceiver({ baseUrl: address, bearerToken: TOKEN })).scan();
    const acceptedOffset = Object.values((await store.load()).files)[0]!.confirmedOffset;
    assert.ok(acceptedOffset > startOffset);

    await appendFile(sessionPath, '{"rejected":true}\n');
    await assert.rejects(new CollectorScanner(store, new HttpChunkReceiver({
      baseUrl: address, fetchImplementation: async () => new Response(null, { status: 503 }),
    })).scan(), /upload_http_503/);
    assert.equal(Object.values((await store.load()).files)[0]!.confirmedOffset, acceptedOffset);
  } finally { await app.close(); }
});

test("uploads require no token while content validation failures remain explicit", async () => {
  const app = await createIngestApp({ bearerToken: TOKEN });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const bytes = Buffer.from('{"ok":true}\n');
    const value = metadata(bytes, 0, null);
    await new HttpChunkReceiver({ baseUrl: address }).accept(value, bytes);
    const invalidHash = structuredClone(value);
    invalidHash.file.sha256 = "0".repeat(64);
    const response = await rawUpload(address, TOKEN, invalidHash, bytes);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "hash_mismatch" });

    const invalidMetadata = structuredClone(value) as unknown as Record<string, unknown>;
    delete invalidMetadata.cospec_run_id;
    assert.equal((await rawUpload(address, TOKEN, invalidMetadata as unknown as ChunkMetadata, bytes)).status, 400);

    const wrongCount = structuredClone(value);
    wrongCount.file.byte_count += 1;
    assert.equal((await rawUpload(address, TOKEN, wrongCount, bytes)).status, 400);

    const incomplete = Buffer.from('{"incomplete":true}');
    const incompleteMetadata = metadata(incomplete, 0, null);
    assert.equal((await rawUpload(address, TOKEN, incompleteMetadata, incomplete)).status, 400);
  } finally { await app.close(); }
});

test("offset gaps and previous hash mismatches are rejected", async () => {
  const app = await createIngestApp({ bearerToken: TOKEN });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const receiver = new HttpChunkReceiver({ baseUrl: address, bearerToken: TOKEN });
    const bytes = Buffer.from('{"one":1}\n');
    const first = metadata(bytes, 10, null);
    await receiver.accept(first, bytes);

    const gap = metadata(bytes, first.file.end_offset + 5, first.file.sha256, first.cospec_run_id, first.file.source_file_id);
    assert.equal((await rawUpload(address, TOKEN, gap, bytes)).status, 409);

    const conflictingBytes = Buffer.from('{"two":2}\n');
    const overlap = metadata(conflictingBytes, first.file.start_offset, null, first.cospec_run_id, first.file.source_file_id);
    assert.deepEqual(await (await rawUpload(address, TOKEN, overlap, conflictingBytes)).json(), { error: "offset_conflict" });

    const reusedUploadId = metadata(bytes, first.file.end_offset, first.file.sha256, first.cospec_run_id, first.file.source_file_id);
    reusedUploadId.upload_id = first.upload_id;
    assert.deepEqual(await (await rawUpload(address, TOKEN, reusedUploadId, bytes)).json(), { error: "upload_id_conflict" });

    const badPrevious = metadata(bytes, first.file.end_offset, "f".repeat(64), first.cospec_run_id, first.file.source_file_id);
    const response = await rawUpload(address, TOKEN, badPrevious, bytes);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "previous_hash_mismatch" });

    const firstWithPrevious = metadata(bytes, 500, "a".repeat(64));
    assert.deepEqual(await (await rawUpload(address, TOKEN, firstWithPrevious, bytes)).json(), { error: "previous_hash_mismatch" });
  } finally { await app.close(); }
});

test("client rejects malformed success, timeout and network failure without exposing credentials", async () => {
  const bytes = Buffer.from('{"x":1}\n');
  const value = metadata(bytes, 0, null);
  const malformed = new HttpChunkReceiver({
    baseUrl: "http://unused", bearerToken: TOKEN,
    fetchImplementation: async () => new Response(JSON.stringify({ status: "accepted" }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(malformed.accept(value, bytes), /invalid_upload_response/);

  const timeout = new HttpChunkReceiver({
    baseUrl: "http://unused", bearerToken: TOKEN,
    fetchImplementation: async () => { throw new DOMException("timed out", "TimeoutError"); },
  });
  await assert.rejects(timeout.accept(value, bytes), /upload_timeout/);

  const network = new HttpChunkReceiver({
    baseUrl: "http://unused", bearerToken: TOKEN,
    fetchImplementation: async () => { throw new Error(`connection failed ${TOKEN}`); },
  });
  await assert.rejects(network.accept(value, bytes), (error: Error) => error.message === "upload_network_error" && !error.message.includes(TOKEN));

  const serverError = new HttpChunkReceiver({
    baseUrl: "http://unused", bearerToken: TOKEN,
    fetchImplementation: async () => new Response("internal details", { status: 500 }),
  });
  await assert.rejects(serverError.accept(value, bytes), (error: Error) => error.message === "upload_http_500" && !error.message.includes("internal details"));
});

function metadata(bytes: Buffer, start: number, previous: string | null, runId: string = randomUUID(), sourceFileId: string = randomUUID()): ChunkMetadata {
  const now = new Date().toISOString();
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    schema_version: "0.1.0", upload_id: randomUUID(), cospec_run_id: runId,
    source_type: "codex_jsonl", source_version: "0.150.1", agent_session_id: randomUUID(),
    collected_at: now, collector_version: "0.1.0",
    file: {
      source_file_id: sourceFileId, generation: 1, path_hint: "redacted.jsonl",
      start_offset: start, end_offset: start + bytes.length, byte_count: bytes.length,
      line_count: bytes.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0),
      sha256: hash, previous_chunk_sha256: previous, ends_with_newline: true,
    },
    environment: {
      captured_at: now, agent_type: "codex", agent_version: "0.150.1",
      os_platform: "linux", os_arch: "x64", cospec_plugin_version: "1.1.79", timezone: "UTC",
    },
  };
}

async function rawUpload(baseUrl: string, token: string, value: ChunkMetadata, bytes: Buffer): Promise<Response> {
  const form = new FormData();
  form.append("metadata", JSON.stringify(value));
  form.append("source", new Blob([Uint8Array.from(bytes)]), "chunk.jsonl");
  return fetch(`${baseUrl}/api/v1/jsonl-chunks`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: form,
  });
}
