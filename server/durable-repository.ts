import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChunkMetadata } from "../collector/types.js";
import { RepositoryConflict, type AcceptedResult, type ChunkRepository } from "./memory-repository.js";
import type { ParseResult } from "./parser.js";
import type { QueryRepository, RunDetail, RunListItem } from "./query.js";

interface StreamRow { next_offset: number; previous_hash: string }
interface ChunkRow { fingerprint: string; end_offset: number; sha256: string }

export class DurableChunkRepository implements ChunkRepository, QueryRepository {
  private queue = Promise.resolve<unknown>(undefined);
  private constructor(private readonly root: string, private readonly database: DatabaseSync) {}

  static async open(root: string): Promise<DurableChunkRepository> {
    await mkdir(join(root, "raw"), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(join(root, "metadata.sqlite"));
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS streams (
        stream_key TEXT PRIMARY KEY, next_offset INTEGER NOT NULL, previous_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        upload_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, stream_key TEXT NOT NULL,
        cospec_run_id TEXT NOT NULL,
        start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, sha256 TEXT NOT NULL,
        raw_path TEXT NOT NULL UNIQUE, parser_status TEXT NOT NULL DEFAULT 'pending',
        metadata_json TEXT NOT NULL, received_at TEXT NOT NULL,
        UNIQUE(stream_key, start_offset, end_offset)
      );
      CREATE TABLE IF NOT EXISTS upload_ids (
        upload_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, end_offset INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS parse_results (
        upload_id TEXT NOT NULL, parser_version TEXT NOT NULL, status TEXT NOT NULL,
        total_lines INTEGER, valid_lines INTEGER, invalid_lines INTEGER, unknown_type_lines INTEGER,
        type_counts_json TEXT, first_timestamp TEXT, last_timestamp TEXT,
        diagnostics_json TEXT NOT NULL, parsed_at TEXT NOT NULL,
        PRIMARY KEY(upload_id, parser_version),
        FOREIGN KEY(upload_id) REFERENCES chunks(upload_id)
      );
      CREATE TABLE IF NOT EXISTS active_parser_versions (
        cospec_run_id TEXT PRIMARY KEY, parser_version TEXT NOT NULL, activated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_facts (
        upload_id TEXT NOT NULL, parser_version TEXT NOT NULL, record_index INTEGER NOT NULL,
        timestamp TEXT, role TEXT NOT NULL, model TEXT,
        PRIMARY KEY(upload_id,parser_version,record_index), FOREIGN KEY(upload_id) REFERENCES chunks(upload_id)
      );
      CREATE TABLE IF NOT EXISTS token_usage_facts (
        upload_id TEXT NOT NULL, parser_version TEXT NOT NULL, record_index INTEGER NOT NULL,
        timestamp TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_input_tokens INTEGER,
        cache_write_or_creation_input_tokens INTEGER, reasoning_output_tokens INTEGER, reported_total_tokens INTEGER,
        PRIMARY KEY(upload_id,parser_version,record_index), FOREIGN KEY(upload_id) REFERENCES chunks(upload_id)
      );
      CREATE TABLE IF NOT EXISTS tool_call_facts (
        upload_id TEXT NOT NULL, parser_version TEXT NOT NULL, record_index INTEGER NOT NULL, item_index INTEGER NOT NULL,
        timestamp TEXT, call_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        PRIMARY KEY(upload_id,parser_version,record_index,item_index), FOREIGN KEY(upload_id) REFERENCES chunks(upload_id)
      );
      CREATE TABLE IF NOT EXISTS tool_result_facts (
        upload_id TEXT NOT NULL, parser_version TEXT NOT NULL, record_index INTEGER NOT NULL, item_index INTEGER NOT NULL,
        timestamp TEXT, call_id TEXT NOT NULL, status TEXT NOT NULL, failure_code TEXT,
        PRIMARY KEY(upload_id,parser_version,record_index,item_index), FOREIGN KEY(upload_id) REFERENCES chunks(upload_id)
      );
      CREATE TABLE IF NOT EXISTS replay_jobs (
        job_id TEXT PRIMARY KEY, cospec_run_id TEXT NOT NULL, target_version TEXT NOT NULL,
        status TEXT NOT NULL, total_chunks INTEGER NOT NULL, completed_chunks INTEGER NOT NULL DEFAULT 0,
        failed_chunks INTEGER NOT NULL DEFAULT 0, failure_code TEXT,
        started_at TEXT NOT NULL, finished_at TEXT,
        UNIQUE(cospec_run_id,target_version)
      );
      CREATE INDEX IF NOT EXISTS chunks_parser_status ON chunks(parser_status);
    `);
    return new DurableChunkRepository(root, database);
  }

  accept(metadata: ChunkMetadata, bytes: Buffer): Promise<AcceptedResult> {
    const work = this.queue.then(() => this.acceptOne(metadata, bytes), () => this.acceptOne(metadata, bytes));
    this.queue = work;
    return work;
  }

  close(): void { this.database.close(); }

  pendingChunks(): Array<{ uploadId: string; runId: string; rawPath: string; sha256: string; sourceType: "codex_jsonl" | "claude_code_jsonl" }> {
    return this.database.prepare("SELECT upload_id, cospec_run_id, raw_path, sha256, json_extract(metadata_json,'$.source_type') AS source_type FROM chunks WHERE parser_status='pending' ORDER BY received_at").all()
      .map((row) => ({ uploadId: String(row.upload_id), runId: String(row.cospec_run_id), rawPath: join(this.root, String(row.raw_path)), sha256: String(row.sha256), sourceType: String(row.source_type) as "codex_jsonl" | "claude_code_jsonl" }));
  }

  saveParseResult(uploadId: string, result: ParseResult): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO parse_results
        (upload_id,parser_version,status,total_lines,valid_lines,invalid_lines,unknown_type_lines,
         type_counts_json,first_timestamp,last_timestamp,diagnostics_json,parsed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(upload_id,parser_version) DO NOTHING`).run(
        uploadId, result.parserVersion, result.status, result.totalLines, result.validLines,
        result.invalidLines, result.unknownTypeLines, JSON.stringify(result.typeCounts),
        result.firstTimestamp, result.lastTimestamp, JSON.stringify(result.diagnostics), new Date().toISOString(),
      );
      this.database.prepare("UPDATE chunks SET parser_status=? WHERE upload_id=?").run(result.status, uploadId);
      this.insertFacts(uploadId, result);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  saveParseFailure(uploadId: string, parserVersion: string, code: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO parse_results
        (upload_id,parser_version,status,diagnostics_json,parsed_at) VALUES(?,?,?,?,?)
        ON CONFLICT(upload_id,parser_version) DO NOTHING`)
        .run(uploadId, parserVersion, "failed", JSON.stringify([{ code }]), new Date().toISOString());
      this.database.prepare("UPDATE chunks SET parser_status='failed' WHERE upload_id=?").run(uploadId);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  parseResultCount(): number {
    return Number((this.database.prepare("SELECT COUNT(*) AS count FROM parse_results").get() as { count: number }).count);
  }

  parseResults(): Array<Record<string, unknown>> {
    return this.database.prepare("SELECT * FROM parse_results ORDER BY parsed_at").all() as Array<Record<string, unknown>>;
  }

  runChunks(runId: string): Array<{ uploadId: string; rawPath: string; sha256: string; sourceType: "codex_jsonl" | "claude_code_jsonl" }> {
    return this.database.prepare("SELECT upload_id,raw_path,sha256,json_extract(metadata_json,'$.source_type') AS source_type FROM chunks WHERE cospec_run_id=? ORDER BY start_offset")
      .all(runId).map((row) => ({ uploadId: String(row.upload_id), rawPath: join(this.root, String(row.raw_path)), sha256: String(row.sha256), sourceType: String(row.source_type) as "codex_jsonl" | "claude_code_jsonl" }));
  }

  saveReplayResult(uploadId: string, result: ParseResult): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO parse_results
      (upload_id,parser_version,status,total_lines,valid_lines,invalid_lines,unknown_type_lines,
       type_counts_json,first_timestamp,last_timestamp,diagnostics_json,parsed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(upload_id,parser_version) DO NOTHING`).run(
      uploadId, result.parserVersion, result.status, result.totalLines, result.validLines,
      result.invalidLines, result.unknownTypeLines, JSON.stringify(result.typeCounts),
      result.firstTimestamp, result.lastTimestamp, JSON.stringify(result.diagnostics), new Date().toISOString(),
    );
      this.insertFacts(uploadId, result);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private insertFacts(uploadId: string, result: ParseResult): void {
    const message = this.database.prepare(`INSERT INTO message_facts(upload_id,parser_version,record_index,timestamp,role,model)
      VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
    for (const fact of result.messageFacts) message.run(uploadId, result.parserVersion, fact.recordIndex, fact.timestamp, fact.role, fact.model);
    const token = this.database.prepare(`INSERT INTO token_usage_facts(upload_id,parser_version,record_index,timestamp,model,input_tokens,output_tokens,
      cache_read_input_tokens,cache_write_or_creation_input_tokens,reasoning_output_tokens,reported_total_tokens)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
    for (const fact of result.tokenUsageFacts) token.run(uploadId, result.parserVersion, fact.recordIndex, fact.timestamp, fact.model,
      fact.inputTokens, fact.outputTokens, fact.cacheReadInputTokens, fact.cacheWriteOrCreationInputTokens, fact.reasoningOutputTokens, fact.reportedTotalTokens);
    const call = this.database.prepare(`INSERT INTO tool_call_facts(upload_id,parser_version,record_index,item_index,timestamp,call_id,tool_name)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
    for (const fact of result.toolCallFacts) call.run(uploadId, result.parserVersion, fact.recordIndex, fact.itemIndex, fact.timestamp, fact.callId, fact.toolName);
    const toolResult = this.database.prepare(`INSERT INTO tool_result_facts(upload_id,parser_version,record_index,item_index,timestamp,call_id,status,failure_code)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
    for (const fact of result.toolResultFacts) toolResult.run(uploadId, result.parserVersion, fact.recordIndex, fact.itemIndex, fact.timestamp, fact.callId, fact.status, fact.failureCode);
  }

  startReplay(runId: string, targetVersion: string, totalChunks: number): Record<string, unknown> {
    this.database.prepare(`INSERT INTO replay_jobs
      (job_id,cospec_run_id,target_version,status,total_chunks,started_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(cospec_run_id,target_version) DO NOTHING`)
      .run(randomUUID(), runId, targetVersion, "running", totalChunks, new Date().toISOString());
    return this.database.prepare("SELECT * FROM replay_jobs WHERE cospec_run_id=? AND target_version=?").get(runId, targetVersion) as Record<string, unknown>;
  }

  completeReplay(jobId: string, runId: string, targetVersion: string, completedChunks: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO active_parser_versions(cospec_run_id,parser_version,activated_at) VALUES(?,?,?)
        ON CONFLICT(cospec_run_id) DO UPDATE SET parser_version=excluded.parser_version, activated_at=excluded.activated_at`)
        .run(runId, targetVersion, new Date().toISOString());
      this.database.prepare(`UPDATE replay_jobs SET status='completed',completed_chunks=?,failed_chunks=0,finished_at=? WHERE job_id=?`)
        .run(completedChunks, new Date().toISOString(), jobId);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  failReplay(jobId: string, completedChunks: number, failureCode: string): void {
    this.database.prepare(`UPDATE replay_jobs SET status='failed',completed_chunks=?,failed_chunks=1,failure_code=?,finished_at=? WHERE job_id=?`)
      .run(completedChunks, failureCode, new Date().toISOString(), jobId);
  }

  activeParserVersion(runId: string): string | null {
    const row = this.database.prepare("SELECT parser_version FROM active_parser_versions WHERE cospec_run_id=?").get(runId);
    return row ? String(row.parser_version) : null;
  }

  activateRunIfFullyParsed(runId: string, parserVersion: string): boolean {
    const row = this.database.prepare(`SELECT
      (SELECT COUNT(*) FROM chunks WHERE cospec_run_id=?) AS total,
      (SELECT COUNT(*) FROM parse_results p JOIN chunks c ON c.upload_id=p.upload_id
       WHERE c.cospec_run_id=? AND p.parser_version=? AND p.status IN ('completed','completed_with_errors')) AS parsed`)
      .get(runId, runId, parserVersion) as { total: number; parsed: number };
    if (row.total === 0 || row.total !== row.parsed) return false;
    this.database.prepare(`INSERT INTO active_parser_versions(cospec_run_id,parser_version,activated_at) VALUES(?,?,?)
      ON CONFLICT(cospec_run_id) DO UPDATE SET parser_version=excluded.parser_version,activated_at=excluded.activated_at`)
      .run(runId, parserVersion, new Date().toISOString());
    return true;
  }

  replayJob(runId: string, targetVersion: string): Record<string, unknown> | undefined {
    return this.database.prepare("SELECT * FROM replay_jobs WHERE cospec_run_id=? AND target_version=?").get(runId, targetVersion) as Record<string, unknown> | undefined;
  }

  listRuns(limit: number, offset: number): { items: RunListItem[]; total: number } {
    const total = Number((this.database.prepare("SELECT COUNT(DISTINCT cospec_run_id) AS count FROM chunks").get() as { count: number }).count);
    const rows = this.database.prepare(`${runSummarySql()} ORDER BY first_received_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
    return { items: rows.map(toRunListItem), total };
  }

  getRun(runId: string): RunDetail | null {
    const row = this.database.prepare(`${runSummarySql()} HAVING c.cospec_run_id=?`).get(runId);
    if (!row) return null;
    const base = toRunListItem(row);
    const statusRows = this.database.prepare("SELECT parser_status,COUNT(*) AS count FROM chunks WHERE cospec_run_id=? GROUP BY parser_status").all(runId);
    const parseStatusCounts = Object.fromEntries(statusRows.map((item) => [String(item.parser_status), Number(item.count)]));
    const parseRows = base.activeParserVersion
      ? this.database.prepare(`SELECT p.* FROM parse_results p JOIN chunks c ON c.upload_id=p.upload_id
          WHERE c.cospec_run_id=? AND p.parser_version=?`).all(runId, base.activeParserVersion)
      : [];
    const typeCounts: Record<string, number> = {};
    const timestamps: string[] = [];
    for (const item of parseRows) {
      for (const [type, count] of Object.entries(JSON.parse(String(item.type_counts_json ?? "{}")) as Record<string, number>)) typeCounts[type] = (typeCounts[type] ?? 0) + count;
      if (item.first_timestamp) timestamps.push(String(item.first_timestamp));
      if (item.last_timestamp) timestamps.push(String(item.last_timestamp));
    }
    timestamps.sort((a, b) => Date.parse(a) - Date.parse(b));
    const sum = (field: string) => parseRows.length ? parseRows.reduce((value, item) => value + Number(item[field] ?? 0), 0) : null;
    return {
      ...base, parseStatusCounts,
      totalLines: sum("total_lines"), validLines: sum("valid_lines"), invalidLines: sum("invalid_lines"),
      unknownTypeLines: sum("unknown_type_lines"), typeCounts,
      firstTimestamp: timestamps[0] ?? null, lastTimestamp: timestamps.at(-1) ?? null,
    };
  }

  async getRunChunks(runId: string): Promise<Array<Record<string, unknown>>> {
    const rows = this.database.prepare(`SELECT upload_id,start_offset,end_offset,sha256,parser_status,received_at,raw_path,
      json_extract(metadata_json,'$.file.generation') AS generation FROM chunks WHERE cospec_run_id=? ORDER BY start_offset`).all(runId);
    return Promise.all(rows.map(async (row) => ({
      uploadId: String(row.upload_id), generation: Number(row.generation), startOffset: Number(row.start_offset),
      endOffset: Number(row.end_offset), byteCount: Number(row.end_offset) - Number(row.start_offset),
      sha256: String(row.sha256), parserStatus: String(row.parser_status), receivedAt: String(row.received_at),
      rawPresent: await exists(join(this.root, String(row.raw_path))),
    })));
  }

  getRunReplays(runId: string): Array<Record<string, unknown>> {
    return this.database.prepare(`SELECT job_id AS jobId,target_version AS targetVersion,status,total_chunks AS totalChunks,
      completed_chunks AS completedChunks,failed_chunks AS failedChunks,failure_code AS failureCode,
      started_at AS startedAt,finished_at AS finishedAt FROM replay_jobs WHERE cospec_run_id=? ORDER BY started_at DESC`).all(runId) as Array<Record<string, unknown>>;
  }

  getRunFacts(runId: string): Record<string, unknown> | null {
    const version = this.activeParserVersion(runId);
    if (!version || !this.getRun(runId)) return null;
    const params = [runId, version];
    const messageRows = this.database.prepare(`SELECT m.role,COUNT(*) AS count FROM message_facts m JOIN chunks c ON c.upload_id=m.upload_id
      WHERE c.cospec_run_id=? AND m.parser_version=? GROUP BY m.role`).all(...params);
    const token = this.database.prepare(`SELECT COUNT(*) AS observations,
      COUNT(input_tokens) AS input_samples,SUM(input_tokens) AS input_tokens,
      COUNT(output_tokens) AS output_samples,SUM(output_tokens) AS output_tokens,
      COUNT(cache_read_input_tokens) AS cache_read_samples,SUM(cache_read_input_tokens) AS cache_read_input_tokens,
      COUNT(cache_write_or_creation_input_tokens) AS cache_write_samples,SUM(cache_write_or_creation_input_tokens) AS cache_write_or_creation_input_tokens,
      COUNT(reasoning_output_tokens) AS reasoning_samples,SUM(reasoning_output_tokens) AS reasoning_output_tokens,
      COUNT(reported_total_tokens) AS reported_total_samples,SUM(reported_total_tokens) AS reported_total_tokens
      FROM token_usage_facts t JOIN chunks c ON c.upload_id=t.upload_id WHERE c.cospec_run_id=? AND t.parser_version=?`).get(...params) as Record<string, unknown>;
    const toolCounts = numericObject(this.database.prepare(`SELECT
      (SELECT COUNT(*) FROM tool_call_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?) AS calls,
      (SELECT COUNT(*) FROM tool_result_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=? AND f.status='success') AS successes,
      (SELECT COUNT(*) FROM tool_result_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=? AND f.status='failure') AS failures`).get(runId, version, runId, version, runId, version) as Record<string, unknown>);
    const toolRows = this.database.prepare(`WITH calls AS (
        SELECT f.call_id,f.tool_name FROM tool_call_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?
      ), results AS (
        SELECT f.call_id,f.status FROM tool_result_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?
      ) SELECT calls.tool_name,COUNT(*) AS calls,
        SUM(CASE WHEN results.status='success' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN results.status='failure' THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN results.status IS NULL OR results.status='unknown' THEN 1 ELSE 0 END) AS unknown_results
      FROM calls LEFT JOIN results ON results.call_id=calls.call_id GROUP BY calls.tool_name ORDER BY calls.tool_name`).all(runId, version, runId, version);
    const modelRows = this.database.prepare(`SELECT model,COUNT(*) AS observations FROM token_usage_facts t JOIN chunks c ON c.upload_id=t.upload_id
      WHERE c.cospec_run_id=? AND t.parser_version=? AND model IS NOT NULL GROUP BY model ORDER BY model`).all(runId, version);
    const time = this.database.prepare(`SELECT MIN(timestamp) AS first_event_at,MAX(timestamp) AS last_event_at FROM (
      SELECT m.timestamp FROM message_facts m JOIN chunks c ON c.upload_id=m.upload_id WHERE c.cospec_run_id=? AND m.parser_version=?
      UNION ALL SELECT f.timestamp FROM tool_call_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?) WHERE timestamp IS NOT NULL`)
      .get(runId, version, runId, version) as Record<string, unknown>;
    return {
      parserVersion: version,
      messages: { total: messageRows.reduce((sum, row) => sum + Number(row.count), 0), byRole: Object.fromEntries(messageRows.map((row) => [String(row.role), Number(row.count)])) },
      tokens: { ...numericObject(token), byModel: Object.fromEntries(modelRows.map((row) => [String(row.model), Number(row.observations)])) },
      tools: { ...toolStatusMetrics(toolCounts), byTool: Object.fromEntries(toolRows.map((row) => {
        const { tool_name: _toolName, ...counts } = row;
        return [String(row.tool_name), toolStatusMetrics(numericObject(counts))];
      })) },
      interval: { firstEventAt: time.first_event_at ?? null, lastEventAt: time.last_event_at ?? null, semantics: "host_record_span" },
      attribution: { run: "explicit_jsonl_offset_interval", skill: "unavailable" },
    };
  }

  async orphanRawFiles(): Promise<string[]> {
    const registered = new Set(this.database.prepare("SELECT raw_path FROM chunks").all().map((row) => String(row.raw_path)));
    const rawRoot = join(this.root, "raw");
    const files = await readdir(rawRoot, { recursive: true, withFileTypes: true });
    return files.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => relative(this.root, join(entry.parentPath, entry.name)))
      .filter((path) => !registered.has(path));
  }

  private async acceptOne(metadata: ChunkMetadata, bytes: Buffer): Promise<AcceptedResult> {
    const key = streamKey(metadata);
    const fingerprint = `${key}:${metadata.file.start_offset}:${metadata.file.end_offset}:${metadata.file.sha256}`;
    const byUpload = this.database.prepare("SELECT fingerprint, end_offset, '' AS sha256 FROM upload_ids WHERE upload_id=?").get(metadata.upload_id) as ChunkRow | undefined;
    if (byUpload) {
      if (byUpload.fingerprint !== fingerprint) throw new RepositoryConflict("upload_id_conflict");
      return { status: "already_accepted", nextOffset: byUpload.end_offset };
    }
    const byRange = this.database.prepare("SELECT fingerprint, end_offset, sha256 FROM chunks WHERE stream_key=? AND start_offset=? AND end_offset=?")
      .get(key, metadata.file.start_offset, metadata.file.end_offset) as ChunkRow | undefined;
    if (byRange) {
      if (byRange.sha256 !== metadata.file.sha256) throw new RepositoryConflict("offset_conflict");
      this.database.prepare("INSERT INTO upload_ids(upload_id,fingerprint,end_offset) VALUES(?,?,?)")
        .run(metadata.upload_id, fingerprint, metadata.file.end_offset);
      return { status: "already_accepted", nextOffset: byRange.end_offset };
    }
    const stream = this.database.prepare("SELECT next_offset, previous_hash FROM streams WHERE stream_key=?").get(key) as StreamRow | undefined;
    if (!stream) {
      if (metadata.file.previous_chunk_sha256 !== null) throw new RepositoryConflict("previous_hash_mismatch");
    } else {
      if (metadata.file.start_offset < stream.next_offset) throw new RepositoryConflict("offset_conflict");
      if (metadata.file.start_offset > stream.next_offset) throw new RepositoryConflict("offset_gap");
      if (metadata.file.previous_chunk_sha256 !== stream.previous_hash) throw new RepositoryConflict("previous_hash_mismatch");
    }

    const rawPath = rawRelativePath(metadata);
    await writeImmutable(join(this.root, rawPath), bytes, metadata.file.sha256);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO chunks
        (upload_id,fingerprint,stream_key,cospec_run_id,start_offset,end_offset,sha256,raw_path,metadata_json,received_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        metadata.upload_id, fingerprint, key, metadata.cospec_run_id, metadata.file.start_offset, metadata.file.end_offset,
        metadata.file.sha256, rawPath, JSON.stringify(metadata), new Date().toISOString(),
      );
      this.database.prepare("INSERT INTO upload_ids(upload_id,fingerprint,end_offset) VALUES(?,?,?)")
        .run(metadata.upload_id, fingerprint, metadata.file.end_offset);
      this.database.prepare(`INSERT INTO streams(stream_key,next_offset,previous_hash) VALUES(?,?,?)
        ON CONFLICT(stream_key) DO UPDATE SET next_offset=excluded.next_offset, previous_hash=excluded.previous_hash`)
        .run(key, metadata.file.end_offset, metadata.file.sha256);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { status: "accepted", nextOffset: metadata.file.end_offset };
  }
}

async function writeImmutable(path: string, bytes: Buffer, expectedHash: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = await readFile(path);
    if (createHash("sha256").update(existing).digest("hex") !== expectedHash) throw new RepositoryConflict("raw_path_conflict");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try { await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EISDIR", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}

function rawRelativePath(metadata: ChunkMetadata): string {
  return join("raw", metadata.cospec_run_id, metadata.file.source_file_id, String(metadata.file.generation),
    `${metadata.file.start_offset}-${metadata.file.end_offset}-${metadata.file.sha256}.jsonl`);
}

function streamKey(metadata: ChunkMetadata): string {
  return `${metadata.cospec_run_id}:${metadata.file.source_file_id}:${metadata.file.generation}`;
}

function runSummarySql(): string {
  return `SELECT c.cospec_run_id,
    MIN(json_extract(c.metadata_json,'$.agent_session_id')) AS agent_session_id,
    MIN(json_extract(c.metadata_json,'$.source_type')) AS source_type,
    MIN(json_extract(c.metadata_json,'$.source_version')) AS source_version,
    MIN(json_extract(c.metadata_json,'$.environment.agent_type')) AS agent_type,
    COUNT(*) AS chunk_count,SUM(c.end_offset-c.start_offset) AS byte_count,
    MIN(c.start_offset) AS start_offset,MAX(c.end_offset) AS end_offset,
    MIN(c.received_at) AS first_received_at,MAX(c.received_at) AS last_received_at,
    a.parser_version AS active_parser_version
    FROM chunks c LEFT JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id
    GROUP BY c.cospec_run_id`;
}

function toRunListItem(row: Record<string, unknown>): RunListItem {
  return {
    runId: String(row.cospec_run_id), agentSessionId: String(row.agent_session_id), sourceType: String(row.source_type),
    sourceVersion: String(row.source_version), agentType: String(row.agent_type),
    chunkCount: Number(row.chunk_count), byteCount: Number(row.byte_count), startOffset: Number(row.start_offset), endOffset: Number(row.end_offset),
    activeParserVersion: row.active_parser_version === null ? null : String(row.active_parser_version),
    firstReceivedAt: String(row.first_received_at), lastReceivedAt: String(row.last_received_at),
  };
}

function numericObject(row: Record<string, unknown>): Record<string, number | null> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? null : Number(value)]));
}

function toolStatusMetrics(counts: Record<string, number | null>): Record<string, number | null> {
  const calls = counts.calls ?? 0;
  const successes = counts.successes ?? 0;
  const failures = counts.failures ?? 0;
  const determinedResults = successes + failures;
  return {
    ...counts,
    determined_results: determinedResults,
    unknown_results: Math.max(0, calls - determinedResults),
    status_coverage: calls === 0 ? null : determinedResults / calls,
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
