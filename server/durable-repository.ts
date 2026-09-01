import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChunkMetadata } from "../collector/types.js";
import { RepositoryConflict, type AcceptedResult, type ChunkRepository } from "./memory-repository.js";
import type { ParseResult } from "./parser.js";
import type { QueryRepository, RunDetail, RunListItem, RunUsageFilters } from "./query.js";

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
    const toolCallTimes = this.database.prepare(`SELECT f.call_id,f.tool_name,f.timestamp FROM tool_call_facts f
      JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?
      ORDER BY f.record_index,f.item_index`).all(runId, version) as Array<Record<string, unknown>>;
    const toolResultTimes = this.database.prepare(`SELECT f.call_id,f.timestamp FROM tool_result_facts f
      JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?
      ORDER BY f.record_index,f.item_index`).all(runId, version) as Array<Record<string, unknown>>;
    const toolDurations = calculateToolDurations(toolCallTimes, toolResultTimes);
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
      tools: { ...toolStatusMetrics(toolCounts), duration: toolDurations.overall, byTool: Object.fromEntries(toolRows.map((row) => {
        const { tool_name: _toolName, ...counts } = row;
        const toolName = String(row.tool_name);
        return [toolName, { ...toolStatusMetrics(numericObject(counts)), duration: toolDurations.byTool[toolName] }];
      })) },
      interval: { firstEventAt: time.first_event_at ?? null, lastEventAt: time.last_event_at ?? null, semantics: "host_record_span" },
      attribution: { run: "explicit_jsonl_offset_interval", skill: "unavailable" },
    };
  }

  getRunUsageSummary(filters: RunUsageFilters): Record<string, unknown> {
    const runRows = this.database.prepare(`SELECT c.cospec_run_id,
      MIN(json_extract(c.metadata_json,'$.environment.agent_type')) AS agent_type,
      MIN(json_extract(c.metadata_json,'$.environment.agent_version')) AS agent_version,
      MIN(c.received_at) AS first_received_at,a.parser_version,
      MIN(CASE WHEN p.parser_version=a.parser_version THEN p.first_timestamp END) AS first_event_at,
      MAX(CASE WHEN p.parser_version=a.parser_version THEN p.last_timestamp END) AS last_event_at
      FROM chunks c LEFT JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id
      LEFT JOIN parse_results p ON p.upload_id=c.upload_id
      GROUP BY c.cospec_run_id`).all() as Array<Record<string, unknown>>;
    const messageRows = this.database.prepare(`SELECT c.cospec_run_id,m.parser_version,m.role,COUNT(*) AS count
      FROM message_facts m JOIN chunks c ON c.upload_id=m.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=m.parser_version
      GROUP BY c.cospec_run_id,m.parser_version,m.role`).all() as Array<Record<string, unknown>>;
    const tokenRows = this.database.prepare(`SELECT c.cospec_run_id,t.parser_version,t.model,COUNT(*) AS observations,
      COUNT(t.input_tokens) AS input_samples,SUM(t.input_tokens) AS input_tokens,
      COUNT(t.output_tokens) AS output_samples,SUM(t.output_tokens) AS output_tokens,
      COUNT(t.cache_read_input_tokens) AS cache_read_samples,SUM(t.cache_read_input_tokens) AS cache_read_input_tokens,
      COUNT(t.cache_write_or_creation_input_tokens) AS cache_write_samples,SUM(t.cache_write_or_creation_input_tokens) AS cache_write_or_creation_input_tokens,
      COUNT(t.reasoning_output_tokens) AS reasoning_samples,SUM(t.reasoning_output_tokens) AS reasoning_output_tokens,
      COUNT(t.reported_total_tokens) AS reported_total_samples,SUM(t.reported_total_tokens) AS reported_total_tokens
      FROM token_usage_facts t JOIN chunks c ON c.upload_id=t.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=t.parser_version
      GROUP BY c.cospec_run_id,t.parser_version,t.model`).all() as Array<Record<string, unknown>>;
    const toolCallRows = this.database.prepare(`SELECT c.cospec_run_id,f.call_id,f.tool_name,f.timestamp
      FROM tool_call_facts f JOIN chunks c ON c.upload_id=f.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=f.parser_version
      ORDER BY c.cospec_run_id,f.record_index,f.item_index`).all() as Array<Record<string, unknown>>;
    const toolResultRows = this.database.prepare(`SELECT c.cospec_run_id,f.call_id,f.timestamp
      FROM tool_result_facts f JOIN chunks c ON c.upload_id=f.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=f.parser_version
      ORDER BY c.cospec_run_id,f.record_index,f.item_index`).all() as Array<Record<string, unknown>>;

    const modelsByRun = new Map<string, Set<string>>();
    for (const row of tokenRows) if (row.model !== null) {
      const models = modelsByRun.get(String(row.cospec_run_id)) ?? new Set<string>();
      models.add(String(row.model)); modelsByRun.set(String(row.cospec_run_id), models);
    }
    const selected = runRows.filter((row) => {
      const runId = String(row.cospec_run_id);
      const time = Date.parse(String(row.first_event_at ?? row.first_received_at));
      return (!filters.from || time >= Date.parse(filters.from)) && (!filters.to || time <= Date.parse(filters.to)) &&
        (!filters.agentType || row.agent_type === filters.agentType) && (!filters.agentVersion || row.agent_version === filters.agentVersion) &&
        (!filters.model || modelsByRun.get(runId)?.has(filters.model));
    });
    const runIds = new Set(selected.map((row) => String(row.cospec_run_id)));
    const selectedMessages = messageRows.filter((row) => runIds.has(String(row.cospec_run_id)));
    const selectedTokens = tokenRows.filter((row) => runIds.has(String(row.cospec_run_id)));
    const selectedToolCalls = toolCallRows.filter((row) => runIds.has(String(row.cospec_run_id)));
    const selectedToolResults = toolResultRows.filter((row) => runIds.has(String(row.cospec_run_id)));

    const byAgent: Record<string, number> = {};
    const byAgentVersion: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    let runsWithParser = 0;
    for (const row of selected) {
      increment(byAgent, String(row.agent_type));
      increment(byAgentVersion, `${String(row.agent_type)}@${String(row.agent_version)}`);
      increment(byDay, new Date(Date.parse(String(row.first_event_at ?? row.first_received_at))).toISOString().slice(0, 10));
      if (row.parser_version !== null) runsWithParser += 1;
    }
    const messageByRole: Record<string, number> = {};
    const messageRuns = new Set<string>();
    let messageTotal = 0;
    for (const row of selectedMessages) {
      const count = Number(row.count); messageTotal += count; increment(messageByRole, String(row.role), count);
      messageRuns.add(String(row.cospec_run_id));
    }
    const tokenRuns = new Set<string>();
    const tokenFieldRuns = Object.fromEntries(TOKEN_TOTAL_FIELDS.map((field) => [field, new Set<string>()])) as Record<TokenTotalField, Set<string>>;
    const modelRuns = new Set<string>();
    const tokenTotals = emptyTokenTotals();
    const byModel: Record<string, ReturnType<typeof emptyModelTotals>> = {};
    for (const row of selectedTokens) {
      const runId = String(row.cospec_run_id); tokenRuns.add(runId);
      addTokenRow(tokenTotals, row);
      for (const field of TOKEN_TOTAL_FIELDS) if (row[field] !== null) tokenFieldRuns[field].add(runId);
      if (row.model !== null) {
        modelRuns.add(runId);
        const model = String(row.model); byModel[model] ??= emptyModelTotals();
        addTokenRow(byModel[model], row); byModel[model].runs.add(runId);
      }
    }
    const resources = buildRunResources(selected, selectedMessages, selectedTokens, selectedToolCalls, selectedToolResults, modelsByRun);
    return {
      filters: { from: filters.from ?? null, to: filters.to ?? null, agentType: filters.agentType ?? null,
        agentVersion: filters.agentVersion ?? null, model: filters.model ?? null },
      timeSemantics: "first_jsonl_event_fallback_first_received",
      runs: { total: selected.length, with_parser_facts: runsWithParser, without_parser_facts: selected.length - runsWithParser,
        byAgent, byAgentVersion, byDay },
      messages: coverageSummary(selected.length, messageRuns.size, { total: messageTotal, byRole: messageByRole,
        average_per_observed_run: messageRuns.size ? messageTotal / messageRuns.size : null }),
      tokens: coverageSummary(selected.length, tokenRuns.size, { ...tokenTotals,
        average_input_per_observed_run: average(tokenTotals.input_tokens, tokenFieldRuns.input_tokens.size),
        average_output_per_observed_run: average(tokenTotals.output_tokens, tokenFieldRuns.output_tokens.size),
        field_run_coverage: Object.fromEntries(TOKEN_TOTAL_FIELDS.map((field) => [field,
          coverageCounts(selected.length, tokenFieldRuns[field].size)])) }),
      models: coverageSummary(selected.length, modelRuns.size, { byModel: Object.fromEntries(Object.entries(byModel).map(([model, totals]) =>
        [model, { ...totals, runs: totals.runs.size }])) }),
      resourceDistribution: resources,
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

interface ToolInterval { start: number; end: number }

function calculateToolDurations(callRows: Array<Record<string, unknown>>, resultRows: Array<Record<string, unknown>>): {
  overall: Record<string, number | string | null>;
  byTool: Record<string, Record<string, number | string | null>>;
} {
  const resultTimes = new Map<string, number[]>();
  for (const row of resultRows) {
    const timestamp = timestampMs(row.timestamp);
    if (timestamp === null) continue;
    const callId = String(row.call_id);
    const values = resultTimes.get(callId) ?? [];
    values.push(timestamp);
    resultTimes.set(callId, values);
  }
  for (const values of resultTimes.values()) values.sort((a, b) => a - b);

  const all = durationAccumulator();
  const byTool = new Map<string, ReturnType<typeof durationAccumulator>>();
  for (const row of callRows) {
    const toolName = String(row.tool_name);
    const tool = byTool.get(toolName) ?? durationAccumulator();
    byTool.set(toolName, tool);
    const start = timestampMs(row.timestamp);
    const candidates = resultTimes.get(String(row.call_id)) ?? [];
    if (start === null || candidates.length === 0) {
      all.unknown += 1; tool.unknown += 1; continue;
    }
    const end = candidates.find((candidate) => candidate >= start);
    if (end === undefined) {
      all.invalid += 1; tool.invalid += 1; continue;
    }
    all.intervals.push({ start, end });
    tool.intervals.push({ start, end });
  }
  return {
    overall: summarizeDurations(callRows.length, all),
    byTool: Object.fromEntries([...byTool].map(([name, value]) => [name, summarizeDurations(
      callRows.filter((row) => String(row.tool_name) === name).length, value)])),
  };
}

function durationAccumulator(): { intervals: ToolInterval[]; unknown: number; invalid: number } {
  return { intervals: [], unknown: 0, invalid: 0 };
}

function summarizeDurations(total: number, value: ReturnType<typeof durationAccumulator>): Record<string, number | string | null> {
  const durations = value.intervals.map(({ start, end }) => end - start).sort((a, b) => a - b);
  return {
    measured_calls: durations.length,
    unknown_calls: value.unknown,
    invalid_intervals: value.invalid,
    coverage: total === 0 ? null : durations.length / total,
    accumulated_ms: durations.reduce((sum, duration) => sum + duration, 0),
    wall_clock_ms: mergedDuration(value.intervals),
    p50_ms: percentile(durations, 0.5),
    p90_ms: percentile(durations, 0.9),
    semantics: "call_to_result_timestamp",
  };
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(sorted: number[], ratio: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(sorted.length * ratio) - 1] ?? null;
}

function mergedDuration(intervals: ToolInterval[]): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let current: ToolInterval | null = null;
  for (const interval of sorted) {
    if (!current) current = { ...interval };
    else if (interval.start <= current.end) current.end = Math.max(current.end, interval.end);
    else { total += current.end - current.start; current = { ...interval }; }
  }
  return total + (current ? current.end - current.start : 0);
}

const TOKEN_TOTAL_FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens",
  "cache_write_or_creation_input_tokens", "reasoning_output_tokens", "reported_total_tokens"] as const;
const TOKEN_SAMPLE_FIELDS = ["input_samples", "output_samples", "cache_read_samples", "cache_write_samples",
  "reasoning_samples", "reported_total_samples"] as const;
type TokenTotalField = typeof TOKEN_TOTAL_FIELDS[number];
type TokenSampleField = typeof TOKEN_SAMPLE_FIELDS[number];
type TokenTotals = { observations: number } & Record<TokenTotalField, number | null> & Record<TokenSampleField, number>;
type ModelTotals = TokenTotals & { runs: Set<string> };

function emptyTokenTotals(): TokenTotals {
  return { observations: 0, input_tokens: null, output_tokens: null, cache_read_input_tokens: null,
    cache_write_or_creation_input_tokens: null, reasoning_output_tokens: null, reported_total_tokens: null,
    input_samples: 0, output_samples: 0, cache_read_samples: 0, cache_write_samples: 0, reasoning_samples: 0, reported_total_samples: 0 };
}

function emptyModelTotals(): ModelTotals { return { ...emptyTokenTotals(), runs: new Set<string>() }; }

function addTokenRow(target: TokenTotals, row: Record<string, unknown>): void {
  target.observations += Number(row.observations);
  for (const field of TOKEN_SAMPLE_FIELDS) target[field] += Number(row[field]);
  for (const field of TOKEN_TOTAL_FIELDS) if (row[field] !== null) target[field] = (target[field] ?? 0) + Number(row[field]);
}

function coverageSummary(totalRuns: number, observedRuns: number, details: Record<string, unknown>): Record<string, unknown> {
  return { ...details, ...coverageCounts(totalRuns, observedRuns) };
}

function coverageCounts(totalRuns: number, observedRuns: number): Record<string, number | null> {
  return { runs_with_data: observedRuns, runs_missing_data: totalRuns - observedRuns,
    run_coverage: totalRuns === 0 ? null : observedRuns / totalRuns };
}

function average(total: number | null, count: number): number | null { return total === null || count === 0 ? null : total / count; }

function increment(target: Record<string, number>, key: string, amount = 1): void { target[key] = (target[key] ?? 0) + amount; }

interface RunResources {
  agentType: string; agentVersion: string; models: Set<string>;
  runSpanMs: number | null; messages: number | null; inputTokens: number | null; outputTokens: number | null;
  toolCalls: number | null; toolWallClockMs: number | null;
}

function buildRunResources(
  runs: Array<Record<string, unknown>>,
  messages: Array<Record<string, unknown>>,
  tokens: Array<Record<string, unknown>>,
  calls: Array<Record<string, unknown>>,
  results: Array<Record<string, unknown>>,
  modelsByRun: Map<string, Set<string>>,
): Record<string, unknown> {
  const messageTotals = new Map<string, number>();
  for (const row of messages) messageTotals.set(String(row.cospec_run_id), (messageTotals.get(String(row.cospec_run_id)) ?? 0) + Number(row.count));
  const tokenTotals = new Map<string, TokenTotals>();
  for (const row of tokens) {
    const runId = String(row.cospec_run_id); const total = tokenTotals.get(runId) ?? emptyTokenTotals();
    addTokenRow(total, row); tokenTotals.set(runId, total);
  }
  const callsByRun = groupRows(calls);
  const resultsByRun = groupRows(results);
  const values: RunResources[] = runs.map((row) => {
    const runId = String(row.cospec_run_id);
    const parsed = row.parser_version !== null;
    const runCalls = callsByRun.get(runId) ?? [];
    const duration = calculateToolDurations(runCalls, resultsByRun.get(runId) ?? []).overall;
    const first = timestampMs(row.first_event_at); const last = timestampMs(row.last_event_at);
    return {
      agentType: String(row.agent_type), agentVersion: String(row.agent_version), models: modelsByRun.get(runId) ?? new Set<string>(),
      runSpanMs: first !== null && last !== null && last >= first ? last - first : null,
      messages: parsed ? (messageTotals.get(runId) ?? 0) : null,
      inputTokens: tokenTotals.get(runId)?.input_tokens ?? null,
      outputTokens: tokenTotals.get(runId)?.output_tokens ?? null,
      toolCalls: parsed ? runCalls.length : null,
      toolWallClockMs: !parsed ? null : runCalls.length === 0 ? 0 : duration.coverage === 1 ? Number(duration.wall_clock_ms) : null,
    };
  });
  return {
    overall: resourceMetrics(values),
    byAgent: groupedResourceMetrics(values, (row) => [row.agentType]),
    byAgentVersion: groupedResourceMetrics(values, (row) => [`${row.agentType}@${row.agentVersion}`]),
    byModel: groupedResourceMetrics(values, (row) => [...row.models]),
    modelGroupingNote: "multi_model_run_is_included_in_each_model_group",
  };
}

function groupRows(rows: Array<Record<string, unknown>>): Map<string, Array<Record<string, unknown>>> {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const runId = String(row.cospec_run_id); const values = grouped.get(runId) ?? [];
    values.push(row); grouped.set(runId, values);
  }
  return grouped;
}

function groupedResourceMetrics(values: RunResources[], keys: (value: RunResources) => string[]): Record<string, unknown> {
  const grouped = new Map<string, RunResources[]>();
  for (const value of values) for (const key of keys(value)) {
    const rows = grouped.get(key) ?? []; rows.push(value); grouped.set(key, rows);
  }
  return Object.fromEntries([...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([key, rows]) => [key, resourceMetrics(rows)]));
}

function resourceMetrics(values: RunResources[]): Record<string, unknown> {
  return {
    runs: values.length,
    run_span_ms: metricDistribution(values.map((row) => row.runSpanMs)),
    messages_per_run: metricDistribution(values.map((row) => row.messages)),
    input_tokens_per_run: metricDistribution(values.map((row) => row.inputTokens)),
    output_tokens_per_run: metricDistribution(values.map((row) => row.outputTokens)),
    tool_calls_per_run: metricDistribution(values.map((row) => row.toolCalls)),
    tool_wall_clock_ms_per_run: metricDistribution(values.map((row) => row.toolWallClockMs)),
  };
}

function metricDistribution(values: Array<number | null>): Record<string, number | null> {
  const measured = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  return {
    runs_with_data: measured.length,
    runs_missing_data: values.length - measured.length,
    run_coverage: values.length === 0 ? null : measured.length / values.length,
    average: measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null,
    p50: percentile(measured, 0.5),
    p90: percentile(measured, 0.9),
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
