import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ChunkMetadata } from "../collector/types.js";
import { MemoryChunkRepository, RepositoryConflict, type ChunkRepository } from "./memory-repository.js";
import type { QueryRepository } from "./query.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

const MAX_CHUNK_BYTES = 10 * 1024 * 1024;

export interface IngestOptions { bearerToken: string; repository?: ChunkRepository; queryRepository?: QueryRepository }

export async function createIngestApp(options: IngestOptions): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 12 * 1024 * 1024, logger: false });
  const repository = options.repository ?? new MemoryChunkRepository();
  const schema = JSON.parse(await readFile(new URL("../../contracts/jsonl-chunk-metadata.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  await app.register(multipart, { limits: { files: 1, fields: 1, fileSize: MAX_CHUNK_BYTES } });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      if (options.queryRepository) options.queryRepository.listRuns(1, 0);
      return reply.send({ status: "ready" });
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.post("/api/v1/jsonl-chunks", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${options.bearerToken}`) return reply.code(401).send({ error: "unauthorized" });
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

  const queryRepository = options.queryRepository;
  if (queryRepository) {
    app.get("/api/v1/runs", async (request, reply) => {
      if (!authorized(request.headers.authorization, options.bearerToken)) return reply.code(401).send({ error: "unauthorized" });
      const query = request.query as { limit?: string; offset?: string };
      const limit = integerParameter(query.limit, 20, 1, 100);
      const offset = integerParameter(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      if (limit === null || offset === null) return reply.code(400).send({ error: "invalid_pagination" });
      return reply.send({ ...queryRepository.listRuns(limit, offset), limit, offset });
    });

    app.get("/api/v1/runs/:runId", async (request, reply) => {
      if (!authorized(request.headers.authorization, options.bearerToken)) return reply.code(401).send({ error: "unauthorized" });
      const { runId } = request.params as { runId: string };
      const result = queryRepository.getRun(runId);
      return result ? reply.send(result) : reply.code(404).send({ error: "run_not_found" });
    });

    app.get("/api/v1/runs/:runId/chunks", async (request, reply) => {
      if (!authorized(request.headers.authorization, options.bearerToken)) return reply.code(401).send({ error: "unauthorized" });
      const { runId } = request.params as { runId: string };
      if (!queryRepository.getRun(runId)) return reply.code(404).send({ error: "run_not_found" });
      return reply.send({ items: await queryRepository.getRunChunks(runId) });
    });

    app.get("/api/v1/runs/:runId/replays", async (request, reply) => {
      if (!authorized(request.headers.authorization, options.bearerToken)) return reply.code(401).send({ error: "unauthorized" });
      const { runId } = request.params as { runId: string };
      if (!queryRepository.getRun(runId)) return reply.code(404).send({ error: "run_not_found" });
      return reply.send({ items: queryRepository.getRunReplays(runId) });
    });

    app.get("/api/v1/runs/:runId/facts", async (request, reply) => {
      if (!authorized(request.headers.authorization, options.bearerToken)) return reply.code(401).send({ error: "unauthorized" });
      const { runId } = request.params as { runId: string };
      const result = queryRepository.getRunFacts(runId);
      return result ? reply.send(result) : reply.code(404).send({ error: "run_not_found" });
    });
  }
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

function authorized(header: string | undefined, token: string): boolean { return header === `Bearer ${token}`; }

function integerParameter(value: string | undefined, fallback: number, minimum: number, maximum: number): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}
