import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArtifactMetadata, ChunkMetadata } from "../collector/types.js";
import { DurableChunkRepository } from "./durable-repository.js";

test("durable repository preserves bytes, parser status and idempotency across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-durable-"));
  const bytes = Buffer.from('{"durable":true}\n');
  const first = metadata(bytes, 250, null);
  let repository = await DurableChunkRepository.open(root);
  assert.deepEqual(await repository.accept(first, bytes), { status: "accepted", nextOffset: first.file.end_offset });
  const pending = repository.pendingChunks();
  assert.equal(pending.length, 1);
  assert.deepEqual(await readFile(pending[0]!.rawPath), bytes);
  assert.equal(createHash("sha256").update(await readFile(pending[0]!.rawPath)).digest("hex"), first.file.sha256);
  repository.close();

  repository = await DurableChunkRepository.open(root);
  assert.deepEqual(await repository.accept(first, bytes), { status: "already_accepted", nextOffset: first.file.end_offset });
  const alias = { ...first, upload_id: randomUUID() };
  assert.deepEqual(await repository.accept(alias, bytes), { status: "already_accepted", nextOffset: first.file.end_offset });
  const conflictingReuse = metadata(Buffer.from('{"different":1}\n'), first.file.end_offset, first.file.sha256, first.cospec_run_id, first.file.source_file_id);
  conflictingReuse.upload_id = alias.upload_id;
  await assert.rejects(repository.accept(conflictingReuse, Buffer.from('{"different":1}\n')), /upload_id_conflict/);

  const secondBytes = Buffer.from('{"next":true}\n');
  const second = metadata(secondBytes, first.file.end_offset, first.file.sha256, first.cospec_run_id, first.file.source_file_id);
  assert.deepEqual(await repository.accept(second, secondBytes), { status: "accepted", nextOffset: second.file.end_offset });
  repository.close();

  repository = await DurableChunkRepository.open(root);
  const gap = metadata(secondBytes, second.file.end_offset + 1, second.file.sha256, first.cospec_run_id, first.file.source_file_id);
  await assert.rejects(repository.accept(gap, secondBytes), /offset_gap/);
  assert.equal(repository.pendingChunks().length, 2);
  repository.close();
});

test("orphan raw files are reported and storage failure is not accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-orphan-"));
  const repository = await DurableChunkRepository.open(root);
  const orphanDirectory = join(root, "raw", "orphan");
  await mkdir(orphanDirectory, { recursive: true });
  await writeFile(join(orphanDirectory, "unregistered.jsonl"), "{}\n");
  assert.deepEqual(await repository.orphanRawFiles(), [join("raw", "orphan", "unregistered.jsonl")]);
  repository.close();

  const brokenRoot = await mkdtemp(join(tmpdir(), "cospec-broken-store-"));
  const broken = await DurableChunkRepository.open(brokenRoot);
  await rm(join(brokenRoot, "raw"), { recursive: true });
  await writeFile(join(brokenRoot, "raw"), "not-a-directory");
  const bytes = Buffer.from('{"must_not_accept":true}\n');
  await assert.rejects(broken.accept(metadata(bytes, 0, null), bytes));
  assert.equal(broken.pendingChunks().length, 0);
  broken.close();
});

test("durable artifact content and Run association survive a server restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-durable-artifact-")); const bytes = Buffer.from("# TR1\n"); const runId = randomUUID();
  const artifact: ArtifactMetadata = { schema_version: "0.1.0", upload_id: randomUUID(), cospec_run_id: runId, skill: "tr1-requirements-spec", attempt_id: "final", artifact_index: 0, artifact_role: "tr1_deliverable", file_name: "TR1.md", logical_path: "outputs/tr1-requirements-spec/TR1.md", content_type: "text/markdown", size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), created_at: new Date().toISOString() };
  let repository = await DurableChunkRepository.open(root); assert.deepEqual(await repository.acceptArtifact(artifact, bytes), { status: "accepted" });
  repository.acceptRunEvent({ schema_version: "0.1.0", event_id: `${runId}:start`, cospec_run_id: runId, event_type: "run_started", occurred_at: artifact.created_at, workflow_kind: "large", workflow_name: "large-requirement-workflow", actor: { employee_id: "63027", display_name: "测试规划员" } }); repository.close();
  repository = await DurableChunkRepository.open(root); assert.equal(repository.listArtifacts(runId).length, 1); assert.deepEqual((await repository.getArtifact(artifact.upload_id))?.bytes, bytes); assert.deepEqual(await repository.acceptArtifact(artifact, bytes), { status: "already_accepted" });
  assert.deepEqual((repository.getWorkflowSummary() as any).artifacts, { total: 1, runs_with_artifacts: 1, run_coverage: 1, by_role: { tr1_deliverable: 1 } }); repository.close();
  await rm(root, { recursive: true, force: true });
});

test("knowledge query events retain full query details for operational diagnosis", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-knowledge-summary-"));
  const repository = await DurableChunkRepository.open(root); const runId = randomUUID();
  repository.acceptRunEvent({ schema_version: "0.1.0", event_id: `${runId}:knowledge-query:q1`, cospec_run_id: runId,
    event_type: "knowledge_query_finished", occurred_at: "2026-09-03T12:00:00.000Z", query_id: "q1", query_status: "degraded",
    kb_name: "desktop-cloud", kb_version: "2026.09", kb_revision: "sha256:abc", query_source: "workflow",
    consumer_skill: "spec-clarify-requirement", answerability: "partially_answerable", hit_count: 4, citation_count: 2, warning_count: 1,
    query_detail: { question: "当前功能是什么？", answer: "支持功能 A。[KB-1]", hits: [{ path: "02/功能.md", excerpt: "功能 A" }], warnings: [{ code: "SOURCE_GAP", message: "缺少版本说明" }] } });
  const summary = repository.getKnowledgeSummary() as any;
  assert.equal(summary.total, 1); assert.equal(summary.runs, 1); assert.equal(summary.hits, 4);
  assert.deepEqual(summary.by_answerability, { partially_answerable: 1 });
  assert.deepEqual(summary.by_consumer_skill, { "spec-clarify-requirement": 1 });
  assert.equal(summary.items[0].detail.question, "当前功能是什么？");
  assert.equal(summary.items[0].detail.hits[0].path, "02/功能.md");
  repository.close(); await rm(root, { recursive: true, force: true });
});

function metadata(bytes: Buffer, start: number, previous: string | null, runId: string = randomUUID(), sourceFileId: string = randomUUID()): ChunkMetadata {
  const now = new Date().toISOString();
  return {
    schema_version: "0.1.0", upload_id: randomUUID(), cospec_run_id: runId,
    source_type: "codex_jsonl", source_version: "0.150.1", agent_session_id: randomUUID(),
    collected_at: now, collector_version: "0.1.0",
    file: {
      source_file_id: sourceFileId, generation: 1, path_hint: "redacted.jsonl",
      start_offset: start, end_offset: start + bytes.length, byte_count: bytes.length, line_count: 1,
      sha256: createHash("sha256").update(bytes).digest("hex"), previous_chunk_sha256: previous, ends_with_newline: true,
    },
    environment: {
      captured_at: now, agent_type: "codex", agent_version: "0.150.1", os_platform: "linux", os_arch: "x64",
      cospec_plugin_version: "1.1.79", timezone: "UTC",
    },
  };
}
