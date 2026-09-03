import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fileURLToPath } from "node:url";
import type { ArtifactMetadata, ChunkMetadata, RunEvent } from "../collector/types.js";
import { MemoryChunkRepository, RepositoryConflict, type ArtifactRepository, type ChunkRepository, type RunEventRepository } from "./memory-repository.js";
import type { QueryRepository, RunUsageFilters } from "./query.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

const MAX_CHUNK_BYTES = 10 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

export interface IngestOptions { bearerToken: string; adminBearerToken?: string; repository?: ChunkRepository; queryRepository?: QueryRepository }
interface DashboardUserRepository {
  findDashboardUser(tokenHash: string): Record<string, unknown> | null;
  listDashboardUsers(): Record<string, unknown>[];
  createDashboardUser(input: { userId: string; displayName: string; role: "viewer" | "admin"; tokenHash: string; now: string }): Record<string, unknown>;
  updateDashboardUser(userId: string, changes: { role?: "viewer" | "admin"; status?: "active" | "disabled" }, now: string): Record<string, unknown> | null;
}

export async function createIngestApp(options: IngestOptions): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 22 * 1024 * 1024, logger: false });
  const repository = options.repository ?? new MemoryChunkRepository();
  const userRepository = repository as ChunkRepository & Partial<DashboardUserRepository>;
  const requestIdentity = (header: string | undefined) => authenticate(header, options.bearerToken, options.adminBearerToken, userRepository);
  const requestAuthorized = (header: string | undefined) => Boolean(requestIdentity(header));
  const schema = JSON.parse(await readFile(new URL("../../contracts/jsonl-chunk-metadata.schema.json", import.meta.url), "utf8"));
  const artifactSchema = JSON.parse(await readFile(new URL("../../contracts/artifact-metadata.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const validateArtifactMetadata = ajv.compile(artifactSchema);
  await app.register(multipart, { limits: { files: 1, fields: 1, fileSize: MAX_ARTIFACT_BYTES } });
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL("../web", import.meta.url)), wildcard: false,
    setHeaders(reply) { reply.header("Cache-Control", "no-store"); },
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/api/v1/auth/me", async (request, reply) => {
    const identity = requestIdentity(request.headers.authorization);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });
    return reply.send(identity);
  });

  app.get("/api/v1/admin/users", async (request, reply) => {
    const identity = requestIdentity(request.headers.authorization);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });
    if (identity.role !== "admin") return reply.code(403).send({ error: "admin_required" });
    return reply.send({ items: userRepository.listDashboardUsers?.() ?? [] });
  });
  app.post("/api/v1/admin/users", async (request, reply) => {
    const identity = requestIdentity(request.headers.authorization);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });
    if (identity.role !== "admin") return reply.code(403).send({ error: "admin_required" });
    if (!userRepository.createDashboardUser) return reply.code(501).send({ error: "user_management_not_supported" });
    const body = request.body as { display_name?: unknown; role?: unknown };
    const displayName = typeof body?.display_name === "string" ? body.display_name.trim() : "";
    if (!displayName || displayName.length > 100 || /[\u0000-\u001f]/.test(displayName) || !["viewer", "admin"].includes(String(body?.role)))
      return reply.code(400).send({ error: "invalid_user" });
    const accessToken = `ctu_${randomBytes(24).toString("base64url")}`;
    const user = userRepository.createDashboardUser({ userId: randomUUID(), displayName, role: body.role as "viewer" | "admin", tokenHash: tokenHash(accessToken), now: new Date().toISOString() });
    return reply.code(201).send({ user, access_token: accessToken });
  });
  app.patch("/api/v1/admin/users/:userId", async (request, reply) => {
    const identity = requestIdentity(request.headers.authorization);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });
    if (identity.role !== "admin") return reply.code(403).send({ error: "admin_required" });
    if (!userRepository.updateDashboardUser) return reply.code(501).send({ error: "user_management_not_supported" });
    const body = request.body as { role?: unknown; status?: unknown };
    if ((body.role !== undefined && !["viewer", "admin"].includes(String(body.role))) || (body.status !== undefined && !["active", "disabled"].includes(String(body.status))) || (body.role === undefined && body.status === undefined))
      return reply.code(400).send({ error: "invalid_user_update" });
    const user = userRepository.updateDashboardUser((request.params as { userId: string }).userId, { ...(body.role ? { role: body.role as "viewer" | "admin" } : {}), ...(body.status ? { status: body.status as "active" | "disabled" } : {}) }, new Date().toISOString());
    return user ? reply.send({ user }) : reply.code(404).send({ error: "user_not_found" });
  });

  app.post("/api/v1/run-events", async (request, reply) => {
    const event = request.body as RunEvent;
    if (!validRunEvent(event)) return reply.code(400).send({ error: "invalid_run_event" });
    const target = repository as ChunkRepository & Partial<RunEventRepository>;
    if (!target.acceptRunEvent) return reply.code(501).send({ error: "run_events_not_supported" });
    try { return reply.send({ event_id: event.event_id, status: target.acceptRunEvent(event) }); }
    catch (error) { if (error instanceof RepositoryConflict) return reply.code(409).send({ error: error.message }); throw error; }
  });
  app.get("/api/v1/runs/:runId/events", async (request, reply) => {
    if (!requestAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const { runId } = request.params as { runId: string };
    const target = repository as ChunkRepository & Partial<RunEventRepository>;
    return reply.send({ items: target.getRunEvents?.(runId) ?? [] });
  });

  app.get("/health/ready", async (_request, reply) => {
    try {
      if (options.queryRepository) options.queryRepository.listRuns(1, 0);
      return reply.send({ status: "ready" });
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.post("/api/v1/jsonl-chunks", async (request, reply) => {
    try {
      let metadata: ChunkMetadata | undefined;
      let source: Buffer | undefined;
      for await (const part of request.parts()) {
        if (part.type === "field" && part.fieldname === "metadata") {
          if (typeof part.value !== "string") throw new RequestError("invalid_metadata");
          try { metadata = JSON.parse(part.value) as ChunkMetadata; }
          catch { throw new RequestError("invalid_metadata"); }
        } else if (part.type === "file" && part.fieldname === "source") {
          source = await part.toBuffer();
        } else if (part.type === "file") {
          await part.toBuffer();
          throw new RequestError("unexpected_part");
        }
      }
      if (!metadata || !source) throw new RequestError("missing_part");
      if (!validate(metadata)) throw new RequestError("invalid_metadata");
      validateContent(metadata, source);
      const result = await repository.accept(metadata, source);
      return reply.send({
        upload_id: metadata.upload_id,
        source_file_id: metadata.file.source_file_id,
        generation: metadata.file.generation,
        accepted_start_offset: metadata.file.start_offset,
        accepted_end_offset: metadata.file.end_offset,
        next_offset: result.nextOffset,
        status: result.status,
      });
    } catch (error) {
      if (error instanceof RepositoryConflict) return reply.code(409).send({ error: error.message });
      if (error instanceof RequestError) return reply.code(400).send({ error: error.message });
      if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: "chunk_too_large" });
      throw error;
    }
  });

  app.post("/api/v1/artifacts", async (request, reply) => {
    try {
      let metadata: ArtifactMetadata | undefined; let artifact: Buffer | undefined;
      for await (const part of request.parts()) {
        if (part.type === "field" && part.fieldname === "metadata") {
          try { metadata = JSON.parse(String(part.value)) as ArtifactMetadata; } catch { throw new RequestError("invalid_metadata"); }
        } else if (part.type === "file" && part.fieldname === "artifact") artifact = await part.toBuffer();
        else if (part.type === "file") { await part.toBuffer(); throw new RequestError("unexpected_part"); }
      }
      if (!metadata || !artifact) throw new RequestError("missing_part");
      validateArtifact(metadata, artifact, validateArtifactMetadata);
      const target = repository as ChunkRepository & Partial<ArtifactRepository>;
      if (!target.acceptArtifact) return reply.code(501).send({ error: "artifacts_not_supported" });
      const result = await target.acceptArtifact(metadata, artifact);
      return reply.send({ upload_id: metadata.upload_id, sha256: metadata.sha256, status: result.status });
    } catch (error) {
      if (error instanceof RepositoryConflict) return reply.code(409).send({ error: error.message });
      if (error instanceof RequestError) return reply.code(400).send({ error: error.message });
      if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: "artifact_too_large" });
      throw error;
    }
  });
  app.get("/api/v1/runs/:runId/artifacts", async (request, reply) => {
    if (!requestAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const { runId } = request.params as { runId: string };
    const target = repository as ChunkRepository & Partial<ArtifactRepository>;
    return reply.send({ items: target.listArtifacts?.(runId) ?? [] });
  });
  app.get("/api/v1/artifacts/:uploadId/download", async (request, reply) => {
    if (!requestAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const { uploadId } = request.params as { uploadId: string };
    const target = repository as ChunkRepository & Partial<ArtifactRepository>;
    const item = await target.getArtifact?.(uploadId);
    if (!item) return reply.code(404).send({ error: "artifact_not_found" });
    reply.header("Content-Type", item.metadata.content_type).header("Cache-Control", "no-store")
      .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(item.metadata.file_name)}`);
    return reply.send(item.bytes);
  });

  const queryRepository = options.queryRepository;
  if (queryRepository) {
    app.get("/api/v1/runs", async (request, reply) => {
      if (!requestAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
      const query = request.query as Record<string, string | undefined>;
      const limit = integerParameter(query.limit, 20, 1, 100);
      const offset = integerParameter(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      if (limit === null || offset === null) return reply.code(400).send({ error: "invalid_pagination" });
      const inactiveHours = query.inactiveHours === undefined ? undefined : Number(query.inactiveHours);
      if (inactiveHours !== undefined && (!Number.isFinite(inactiveHours) || inactiveHours < 0)) return reply.code(400).send({ error: "invalid_inactive_hours" });
      const boolean = (value: string | undefined) => value === undefined ? undefined : value === "true" ? true : value === "false" ? false : null;
      const hasArtifact = boolean(query.hasArtifact); const toolFailure = boolean(query.toolFailure); const identityMissing=boolean(query.identityMissing);
      if (hasArtifact === null || toolFailure === null || identityMissing === null) return reply.code(400).send({ error: "invalid_boolean_filter" });
      const filters = Object.fromEntries(Object.entries({
        from: query.from, to: query.to, agentType: query.agentType as "codex" | "claude_code" | undefined,
        agentVersion: query.agentVersion, cospecPluginVersion: query.cospecPluginVersion,
        employeeId: query.employeeId, proposerDept: query.proposerDept,
        workflowKind: query.workflowKind as "large" | "small" | "custom" | undefined,
        workflowStatus: query.workflowStatus as "running" | "completed" | "failed" | "interrupted" | undefined,
        skill: query.skill, hasArtifact: hasArtifact ?? undefined, artifactRole: query.artifactRole,
        toolFailure: toolFailure ?? undefined, identityMissing:identityMissing??undefined, inactiveHours,
      }).filter(([, value]) => value !== undefined));
      return reply.send({ ...queryRepository.listRuns(limit, offset, filters), limit, offset });
    });

    app.get("/api/v1/runs/:runId", async (request, reply) => {
      if (!requestAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
      const { runId } = request.params as { runId: string };
      const result = queryRepository.getRun(runId);
      return result ? reply.send(result) : reply.code(404).send({ error: "run_not_found" });
    });

    app.get("/api/v1/runs/:runId/chunks", async (request, reply) => {
      if (!requestAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
      const { runId } = request.params as { runId: string };
      if (!queryRepository.getRun(runId)) return reply.code(404).send({ error: "run_not_found" });
      return reply.send({ items: await queryRepository.getRunChunks(runId) });
    });
    app.get("/api/v1/runs/:runId/replays", async (request, reply) => {
      if (!requestAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
      const { runId } = request.params as { runId: string };
      if (!queryRepository.getRun(runId)) return reply.code(404).send({ error: "run_not_found" });
      return reply.send({ items: queryRepository.getRunReplays(runId) });
    });

    app.get("/api/v1/runs/:runId/facts", async (request, reply) => {
      if (!requestAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
      const { runId } = request.params as { runId: string };
      const result = queryRepository.getRunFacts(runId);
      return result ? reply.send(result) : reply.code(404).send({ error: "run_not_found" });
    });

    app.get("/api/v1/runs/:runId/raw-sources", async (request, reply) => {
      if (!requestAuthorized(request.headers.authorization))
        return reply.code(401).send({ error: "unauthorized" });
      const { runId } = request.params as { runId: string };
      if (!queryRepository.getRun(runId)) return reply.code(404).send({ error: "run_not_found" });
      return reply.send({ items: queryRepository.listRunRawSources(runId) });
    });
    app.get("/api/v1/runs/:runId/raw-sources/:sourceFileId/:generation/download", async (request, reply) => {
      if (!requestAuthorized(request.headers.authorization))
        return reply.code(401).send({ error: "unauthorized" });
      if (requestIdentity(request.headers.authorization)?.role !== "admin")
        return reply.code(403).send({ error: "admin_required" });
      const { runId, sourceFileId, generation: generationText } = request.params as {
        runId: string; sourceFileId: string; generation: string;
      };
      const generation = Number(generationText);
      if (!Number.isInteger(generation) || generation < 1) return reply.code(400).send({ error: "invalid_generation" });
      const bytes = await queryRepository.getRunRawSource(runId, sourceFileId, generation);
      if (!bytes) return reply.code(404).send({ error: "raw_source_not_found" });
      const fileName = `cospec-${runId.slice(0, 8)}-${sourceFileId.slice(0, 8)}-g${generation}.jsonl`;
      return reply.header("Content-Type", "application/x-ndjson").header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store").header("Content-Disposition", `attachment; filename="${fileName}"`).send(bytes);
    });

    app.get("/api/v1/summaries/run-usage", async (request, reply) => {
      if (!requestAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
      const query = request.query as Record<string, string | undefined>;
      const allowed = new Set(["from", "to", "workflowKind", "agentType", "agentVersion", "model", "cospecPluginVersion", "employeeId", "proposerDept"]);
      if (Object.keys(query).some((key) => !allowed.has(key))) return reply.code(400).send({ error: "invalid_filter" });
      if ((query.from && !validDate(query.from)) || (query.to && !validDate(query.to)) ||
          (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) ||
          (query.workflowKind && !["large", "small", "custom"].includes(query.workflowKind)) ||
          (query.agentType && !["codex", "claude_code"].includes(query.agentType)) ||
          [query.agentVersion, query.model, query.cospecPluginVersion, query.employeeId, query.proposerDept].some((value) => value !== undefined && (value.length === 0 || value.length > 200))) {
        return reply.code(400).send({ error: "invalid_filter" });
      }
      return reply.send(queryRepository.getRunUsageSummary(query as RunUsageFilters));
    });
    app.get("/api/v1/summaries/workflows", async (request, reply) => {
      if (!requestAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
      const query = request.query as Record<string, string | undefined>;
      if (Object.keys(query).some((key) => !["from", "to", "employeeId", "proposerDept"].includes(key)) ||
        (query.from && !validDate(query.from)) || (query.to && !validDate(query.to)) ||
        [query.employeeId, query.proposerDept].some((value) => value !== undefined && (value.length === 0 || value.length > 200))) return reply.code(400).send({ error: "invalid_filter" });
      return reply.send(queryRepository.getWorkflowSummary?.(query) ?? { total: 0, by_kind: {}, by_status: {}, completion_rate: null, stages: [] });
    });
    app.get("/api/v1/summaries/knowledge", async (request, reply) => {
      if (!requestAuthorized(request.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
      const query = request.query as Record<string, string | undefined>;
      if (Object.keys(query).some((key) => !["from", "to"].includes(key)) ||
        (query.from && !validDate(query.from)) || (query.to && !validDate(query.to)) ||
        (query.from && query.to && Date.parse(query.from) > Date.parse(query.to))) return reply.code(400).send({ error: "invalid_filter" });
      return reply.send(queryRepository.getKnowledgeSummary?.(query) ?? { total: 0, runs: 0, items: [] });
    });
  }
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/") && !request.url.startsWith("/health/") && !request.url.startsWith("/assets/")) {
      reply.header("Cache-Control", "no-store");
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" });
  });
  return app;
}

class RequestError extends Error {}

function validateContent(metadata: ChunkMetadata, source: Buffer): void {
  if (source.length === 0 || source.length > MAX_CHUNK_BYTES) throw new RequestError("chunk_too_large");
  if (source.at(-1) !== 0x0a) throw new RequestError("incomplete_jsonl_line");
  if (metadata.file.byte_count !== source.length || metadata.file.end_offset - metadata.file.start_offset !== source.length) throw new RequestError("byte_count_mismatch");
  const lines = source.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0);
  if (metadata.file.line_count !== lines) throw new RequestError("line_count_mismatch");
  const hash = createHash("sha256").update(source).digest("hex");
  if (metadata.file.sha256 !== hash) throw new RequestError("hash_mismatch");
}

function validateArtifact(metadata: ArtifactMetadata, bytes: Buffer, validateMetadata: (value: unknown) => boolean): void {
  if (!validateMetadata(metadata) || /[\u0000-\u001f]/.test(metadata.artifact_role) || /[\u0000-\u001f]/.test(metadata.file_name) || /[\u0000-\u001f]/.test(metadata.content_type)) throw new RequestError("invalid_metadata");
  if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) throw new RequestError("artifact_too_large");
  if (metadata.size_bytes !== bytes.length) throw new RequestError("byte_count_mismatch");
  if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw new RequestError("hash_mismatch");
}


function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function authenticate(header: string | undefined, token: string, adminToken: string | undefined, users: Partial<DashboardUserRepository>): { role: "viewer" | "admin"; display_name: string; user_id: string | null; source: "deployment" | "local" } | null {
  if (adminToken && header === `Bearer ${adminToken}`) return { role: "admin", display_name: "部署管理员", user_id: null, source: "deployment" };
  if (header === `Bearer ${token}`) return { role: "viewer", display_name: "部署只读账号", user_id: null, source: "deployment" };
  const value = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!value || !users.findDashboardUser) return null;
  const user = users.findDashboardUser(tokenHash(value));
  if (!user || user.status !== "active" || !["viewer", "admin"].includes(String(user.role))) return null;
  return { role: user.role as "viewer" | "admin", display_name: String(user.display_name), user_id: String(user.user_id), source: "local" };
}

function integerParameter(value: string | undefined, fallback: number, minimum: number, maximum: number): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function validDate(value: string): boolean { return Number.isFinite(Date.parse(value)); }

function validRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RunEvent>;
  if (event.schema_version !== "0.1.0" || !event.event_id || !event.cospec_run_id || !event.occurred_at || !Number.isFinite(Date.parse(event.occurred_at))) return false;
  if (!event.event_type || !["run_started", "stage_started", "stage_finished", "skill_started", "skill_finished", "knowledge_query_finished", "run_finished"].includes(event.event_type)) return false;
  if (event.actor && (!/^[A-Za-z0-9._-]{1,64}$/.test(event.actor.employee_id) || !event.actor.display_name || event.actor.display_name.length > 100 || /[\u0000-\u001f]/.test(event.actor.display_name) ||
    (event.actor.proposer_dept !== undefined && (!event.actor.proposer_dept || event.actor.proposer_dept.length > 200 || /[\u0000-\u001f]/.test(event.actor.proposer_dept))))) return false;
  if (event.event_type === "run_started") return !!event.workflow_name && !!event.workflow_kind && ["large", "small", "custom"].includes(event.workflow_kind);
  if (event.event_type.startsWith("stage_")) return !!event.stage && (event.event_type === "stage_started"
    ? event.status === undefined : !!event.status && ["completed", "failed", "interrupted", "skipped"].includes(event.status));
  if (event.event_type.startsWith("skill_")) return !!event.skill && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(event.skill) &&
    !!event.execution_id && /^[A-Za-z0-9]{8}$/.test(event.execution_id) &&
    (event.event_type === "skill_started" ? event.status === undefined
      : !!event.status && ["completed", "failed", "interrupted", "orphan"].includes(event.status));
  if (event.event_type === "knowledge_query_finished") return !!event.query_id && event.query_id.length <= 128 &&
    !!event.kb_name && event.kb_name.length <= 128 && !!event.kb_revision && event.kb_revision.length <= 128 &&
    !!event.query_status && ["completed", "degraded", "failed", "incomplete"].includes(event.query_status) &&
    (!event.kb_version || event.kb_version.length <= 128) && ["workflow", "user"].includes(event.query_source ?? "") &&
    (!event.consumer_skill || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(event.consumer_skill)) &&
    (!event.answerability || ["answerable", "partially_answerable", "unanswerable", "conflicted"].includes(event.answerability)) &&
    [event.hit_count, event.citation_count, event.warning_count].every((count) => Number.isInteger(count) && Number(count) >= 0);
  return !!event.status && ["completed", "failed", "interrupted"].includes(event.status);
}
