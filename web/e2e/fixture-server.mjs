import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIngestApp } from "../../dist/server/app.js";
import { DurableChunkRepository } from "../../dist/server/durable-repository.js";
import { ParserWorker } from "../../dist/server/parser-worker.js";

const root = await mkdtemp(join(tmpdir(), "cospec-web-e2e-"));
const repository = await DurableChunkRepository.open(root);
const runId = "11111111-1111-4111-8111-111111111111";
const clock = Date.now(); const at = (offsetMs) => new Date(clock + offsetMs).toISOString(); const now = at(-180_000);
const rows = [
  { type: "event_msg", timestamp: now, payload: { type: "token_count", info: { model_context_window: 258400, last_token_usage: { input_tokens: 120, output_tokens: 30 } } } },
  { type: "response_item", timestamp: "2026-09-01T08:00:01.000Z", payload: { type: "message", role: "assistant" } },
  { type: "compacted", timestamp: "2026-09-01T08:00:02.000Z", payload: {} },
  { type: "response_item", timestamp: at(-120_000), payload: { type: "function_call_output", call_id: "skill-start", output: { output: "[COSPEC:SKILL:START:tr1-requirements-spec:1234abcd]\n" } } },
  { type: "response_item", timestamp: at(-1_000), payload: { type: "function_call_output", call_id: "skill-end", output: { output: "[COSPEC:SKILL:END:tr1-requirements-spec:1234abcd:OK]\n" } } },
];
const bytes = Buffer.from(rows.map(JSON.stringify).join("\n") + "\n");
await repository.accept({
  schema_version: "0.1.0", upload_id: randomUUID(), cospec_run_id: runId, source_type: "codex_jsonl", source_version: "0.150.1",
  agent_session_id: "22222222-2222-4222-8222-222222222222", collected_at: now, collector_version: "0.1.0",
  file: { source_file_id: randomUUID(), generation: 1, path_hint: "redacted.jsonl", start_offset: 0, end_offset: bytes.length,
    byte_count: bytes.length, line_count: rows.length, sha256: createHash("sha256").update(bytes).digest("hex"), previous_chunk_sha256: null, ends_with_newline: true },
  environment: { captured_at: now, agent_type: "codex", agent_version: "0.150.1", os_platform: "linux", os_arch: "x64", cospec_plugin_version: "1.1.79", timezone: "UTC" },
}, bytes);
const artifactBytes = Buffer.from("# 国产化域控 TR1 评审版\n");
await repository.acceptArtifact({
  schema_version: "0.1.0", upload_id: "33333333-3333-4333-8333-333333333333", cospec_run_id: runId,
  skill: "tr1-requirements-spec", attempt_id: "tr1-final-001", artifact_index: 0, artifact_role: "tr1_deliverable",
  file_name: "tr1用户需求文档_评审版.md", logical_path: "outputs/tr1-requirements-spec/tr1用户需求文档_评审版.md", content_type: "text/markdown", size_bytes: artifactBytes.length,
  sha256: createHash("sha256").update(artifactBytes).digest("hex"), created_at: now,
}, artifactBytes);
repository.acceptRunEvent({ schema_version: "0.1.0", event_id: `${runId}:run_started`, cospec_run_id: runId, event_type: "run_started", occurred_at: now, workflow_kind: "large", workflow_name: "large-requirement-workflow", actor: { employee_id: "63027", display_name: "测试规划员", proposer_dept: "研发体系/工程技术部" } });
repository.acceptRunEvent({ schema_version: "0.1.0", event_id: `${runId}:run_finished`, cospec_run_id: runId, event_type: "run_finished", occurred_at: at(-500), status: "completed" });
await new ParserWorker(repository).runPending();
const app = await createIngestApp({ bearerToken: "e2e-token", adminBearerToken: "e2e-admin-token", repository, queryRepository: repository });
await app.listen({ host: "127.0.0.1", port: 4320 });
const close = async () => { await app.close(); repository.close(); process.exit(0); };
process.on("SIGTERM", close); process.on("SIGINT", close);
