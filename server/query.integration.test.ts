import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChunkMetadata } from "../collector/types.js";
import { createIngestApp } from "./app.js";
import { DurableChunkRepository } from "./durable-repository.js";
import { parseCodexJsonl } from "./parser.js";
import { ParserRegistry } from "./parser-registry.js";
import { ParserWorker } from "./parser-worker.js";
import { ReplayService } from "./replay.js";

const TOKEN = "query-test-token";

test("health endpoints expose only process and repository readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-health-"));
  const repository = await DurableChunkRepository.open(root);
  const app = await createIngestApp({ bearerToken: TOKEN, repository, queryRepository: repository });
  try {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { status: "ok" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { status: "ready" });
    assert.equal(live.body.includes(TOKEN) || live.body.includes(root), false);
    assert.equal(ready.body.includes(TOKEN) || ready.body.includes(root), false);
  } finally { await app.close(); repository.close(); }
});

test("read-only query API returns active-version summaries without content or paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-query-"));
  const repository = await DurableChunkRepository.open(root);
  const runId = randomUUID();
  const sourceFileId = randomUUID();
  const firstBytes = Buffer.from('{"type":"event_msg","timestamp":"2026-09-01T01:00:00Z","payload":{"private":"DO_NOT_RETURN"}}\n');
  const first = metadata(firstBytes, runId, sourceFileId, 500, null);
  await repository.accept(first, firstBytes);
  const secondBytes = Buffer.from('{"type":"future_type","timestamp":"2026-09-01T02:00:00Z"}\n');
  await repository.accept(metadata(secondBytes, runId, sourceFileId, first.file.end_offset, first.file.sha256), secondBytes);
  await new ParserWorker(repository).runPending();
  await new ReplayService(repository, new ParserRegistry({ "0.2.0": (bytes) => parseCodexJsonl(bytes, "0.2.0") })).replayRun(runId, "0.2.0");

  const app = await createIngestApp({ bearerToken: TOKEN, repository, queryRepository: repository });
  try {
    const headers = { authorization: `Bearer ${TOKEN}` };
    const list = await app.inject({ method: "GET", url: "/api/v1/runs?limit=1&offset=0", headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().total, 1);
    assert.equal(list.json().items[0].runId, runId);

    const detail = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().activeParserVersion, "0.2.0");
    assert.equal(detail.json().totalLines, 2);
    assert.deepEqual(detail.json().typeCounts, { event_msg: 1, future_type: 1 });
    assert.equal(detail.body.includes("DO_NOT_RETURN"), false);
    assert.equal(detail.body.includes(root), false);

    const chunks = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/chunks`, headers });
    assert.equal(chunks.json().items.length, 2);
    assert.equal(chunks.json().items.every((item: { rawPresent: boolean }) => item.rawPresent), true);
    assert.equal(chunks.body.includes(root), false);
    assert.equal(chunks.body.includes("private.jsonl"), false);

    const replays = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/replays`, headers });
    assert.equal(replays.json().items[0].targetVersion, "0.2.0");
    assert.equal(replays.json().items[0].status, "completed");

    assert.equal((await app.inject({ method: "GET", url: "/api/v1/runs" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/runs?limit=0", headers })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/runs/${randomUUID()}`, headers })).statusCode, 404);
  } finally { await app.close(); repository.close(); }
});

test("query API returns an empty paginated list", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-query-empty-"));
  const repository = await DurableChunkRepository.open(root);
  const app = await createIngestApp({ bearerToken: TOKEN, repository, queryRepository: repository });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/runs", headers: { authorization: `Bearer ${TOKEN}` } });
    assert.deepEqual(response.json(), { items: [], total: 0, limit: 20, offset: 0 });
  } finally { await app.close(); repository.close(); }
});

function metadata(bytes: Buffer, runId: string, sourceFileId: string, start: number, previous: string | null): ChunkMetadata {
  const now = new Date().toISOString();
  return {
    schema_version: "0.1.0", upload_id: randomUUID(), cospec_run_id: runId,
    source_type: "codex_jsonl", source_version: "0.150.1", agent_session_id: randomUUID(), collected_at: now, collector_version: "0.1.0",
    file: { source_file_id: sourceFileId, generation: 1, path_hint: "/private/private.jsonl", start_offset: start,
      end_offset: start + bytes.length, byte_count: bytes.length, line_count: 1,
      sha256: createHash("sha256").update(bytes).digest("hex"), previous_chunk_sha256: previous, ends_with_newline: true },
    environment: { captured_at: now, agent_type: "codex", agent_version: "0.150.1", os_platform: "linux", os_arch: "x64", cospec_plugin_version: "1", timezone: "UTC" },
  };
}
