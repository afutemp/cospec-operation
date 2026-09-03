import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_ARTIFACT_BYTES, syncManifestArtifacts } from "./artifacts.js";
import { emptyState } from "./state.js";

test("manifest sync freezes verified formal artifacts once and rejects changed or oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cospec-artifacts-"));
  const runId = randomUUID(); const artifactPath = join(root, "需求.md"); const bytes = Buffer.from("# 正式需求\n");
  await writeFile(artifactPath, bytes);
  const state = emptyState(); state.runs[runId] = { schemaVersion: "0.1.0", cospecRunId: runId, agentType: "codex", agentSessionId: randomUUID(), sourceFileId: null, generation: null, startOffset: null, endOffset: null, startedAt: new Date().toISOString(), endedAt: null, status: "pending" };
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ run_id: runId, products: { "small-requirement-spec": { role: "small_requirement_deliverable", attempts: [{ attempt_id: "attempt-1", status: "done", recorded_at: new Date().toISOString(), artifacts: [{ kind: "file", role: "small_requirement_deliverable", path: artifactPath, sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length }] }] } } }));
  assert.deepEqual(await syncManifestArtifacts(state, runId, manifestPath, root), { queued: 1, known: 0, rejected: 0 });
  const queued = Object.values(state.artifacts!)[0]!;
  assert.equal(queued.metadata.logical_path, "outputs/small-requirement-spec/需求.md");
  assert.deepEqual(await readFile(queued.spoolPath), bytes);
  await writeFile(artifactPath, "changed");
  assert.deepEqual(await syncManifestArtifacts(state, runId, manifestPath, root), { queued: 0, known: 1, rejected: 0 });

  const tooLarge = { ...JSON.parse(await readFile(manifestPath, "utf8")) };
  tooLarge.products["small-requirement-spec"].attempts[0].attempt_id = "attempt-2";
  tooLarge.products["small-requirement-spec"].attempts[0].artifacts[0].size_bytes = MAX_ARTIFACT_BYTES + 1;
  await writeFile(manifestPath, JSON.stringify(tooLarge));
  assert.deepEqual(await syncManifestArtifacts(state, runId, manifestPath, root), { queued: 0, known: 0, rejected: 1 });
  assert.equal(Object.values(state.artifacts!).find((item) => item.metadata.attempt_id === "attempt-2")?.error, "artifact_too_large");
  await rm(root, { recursive: true, force: true });
});
