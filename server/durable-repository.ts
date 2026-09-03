import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ArtifactMetadata,
  ChunkMetadata,
  RunEvent,
} from "../collector/types.js";
import {
  RepositoryConflict,
  type AcceptedResult,
  type ArtifactRepository,
  type ChunkRepository,
  type RunEventRepository,
} from "./memory-repository.js";
import type { ParseResult } from "./parser.js";
import type {
  QueryRepository,
  RunDetail,
  RunListFilters,
  RunListItem,
  RunUsageFilters,
} from "./query.js";

interface StreamRow {
  next_offset: number;
  previous_hash: string;
}
interface ChunkRow {
  fingerprint: string;
  end_offset: number;
  sha256: string;
}

function dashboardUserRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    user_id: String(row.user_id), display_name: String(row.display_name),
    role: String(row.role), status: String(row.status),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

export class DurableChunkRepository
  implements
    ChunkRepository,
    QueryRepository,
    RunEventRepository,
    ArtifactRepository
{
  private queue = Promise.resolve<unknown>(undefined);
  private constructor(
    private readonly root: string,
    private readonly database: DatabaseSync,
  ) {}

  static async open(root: string): Promise<DurableChunkRepository> {
    await mkdir(join(root, "raw"), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(join(root, "metadata.sqlite"));
    database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    );
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
      CREATE TABLE IF NOT EXISTS compaction_facts (
        upload_id TEXT NOT NULL, parser_version TEXT NOT NULL, record_index INTEGER NOT NULL,
        timestamp TEXT, trigger TEXT NOT NULL, pre_tokens INTEGER, post_tokens INTEGER,
        PRIMARY KEY(upload_id,parser_version,record_index), FOREIGN KEY(upload_id) REFERENCES chunks(upload_id)
      );
      CREATE TABLE IF NOT EXISTS context_window_facts (
        upload_id TEXT NOT NULL, parser_version TEXT NOT NULL, record_index INTEGER NOT NULL,
        timestamp TEXT, context_window_tokens INTEGER NOT NULL,
        PRIMARY KEY(upload_id,parser_version,record_index), FOREIGN KEY(upload_id) REFERENCES chunks(upload_id)
      );
      CREATE TABLE IF NOT EXISTS skill_marker_facts (
        upload_id TEXT NOT NULL, parser_version TEXT NOT NULL, record_index INTEGER NOT NULL,
        item_index INTEGER NOT NULL, marker_index INTEGER NOT NULL, timestamp TEXT,
        phase TEXT NOT NULL, skill TEXT NOT NULL, execution_id TEXT NOT NULL, status TEXT,
        PRIMARY KEY(upload_id,parser_version,record_index,item_index,marker_index),
        FOREIGN KEY(upload_id) REFERENCES chunks(upload_id)
      );
      CREATE TABLE IF NOT EXISTS turn_event_facts (
        upload_id TEXT NOT NULL, parser_version TEXT NOT NULL, record_index INTEGER NOT NULL,
        item_index INTEGER NOT NULL, timestamp TEXT, kind TEXT NOT NULL,
        PRIMARY KEY(upload_id,parser_version,record_index,item_index,kind),
        FOREIGN KEY(upload_id) REFERENCES chunks(upload_id)
      );
      CREATE TABLE IF NOT EXISTS replay_jobs (
        job_id TEXT PRIMARY KEY, cospec_run_id TEXT NOT NULL, target_version TEXT NOT NULL,
        status TEXT NOT NULL, total_chunks INTEGER NOT NULL, completed_chunks INTEGER NOT NULL DEFAULT 0,
        failed_chunks INTEGER NOT NULL DEFAULT 0, failure_code TEXT,
        started_at TEXT NOT NULL, finished_at TEXT,
        UNIQUE(cospec_run_id,target_version)
      );
      CREATE INDEX IF NOT EXISTS chunks_parser_status ON chunks(parser_status);
      CREATE TABLE IF NOT EXISTS run_events (
        event_id TEXT PRIMARY KEY, cospec_run_id TEXT NOT NULL, event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_events_run ON run_events(cospec_run_id,occurred_at);
      CREATE TABLE IF NOT EXISTS artifacts (
        upload_id TEXT PRIMARY KEY, artifact_key TEXT NOT NULL UNIQUE, cospec_run_id TEXT NOT NULL,
        sha256 TEXT NOT NULL, blob_path TEXT NOT NULL, metadata_json TEXT NOT NULL, received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_run ON artifacts(cospec_run_id,received_at);
      CREATE TABLE IF NOT EXISTS dashboard_users (
        user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL,
        status TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    return new DurableChunkRepository(root, database);
  }

  accept(metadata: ChunkMetadata, bytes: Buffer): Promise<AcceptedResult> {
    const work = this.queue.then(
      () => this.acceptOne(metadata, bytes),
      () => this.acceptOne(metadata, bytes),
    );
    this.queue = work;
    return work;
  }

  close(): void {
    this.database.close();
  }

  findDashboardUser(tokenHash: string): Record<string, unknown> | null {
    const row = this.database.prepare("SELECT user_id,display_name,role,status,created_at,updated_at FROM dashboard_users WHERE token_hash=?").get(tokenHash);
    return row ? dashboardUserRow(row as Record<string, unknown>) : null;
  }

  listDashboardUsers(): Record<string, unknown>[] {
    return (this.database.prepare("SELECT user_id,display_name,role,status,created_at,updated_at FROM dashboard_users ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(dashboardUserRow);
  }

  createDashboardUser(input: { userId: string; displayName: string; role: "viewer" | "admin"; tokenHash: string; now: string }): Record<string, unknown> {
    this.database.prepare("INSERT INTO dashboard_users(user_id,display_name,role,status,token_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(input.userId, input.displayName, input.role, "active", input.tokenHash, input.now, input.now);
    return this.findDashboardUser(input.tokenHash)!;
  }

  updateDashboardUser(userId: string, changes: { role?: "viewer" | "admin"; status?: "active" | "disabled" }, now: string): Record<string, unknown> | null {
    const current = this.database.prepare("SELECT role,status FROM dashboard_users WHERE user_id=?").get(userId) as Record<string, unknown> | undefined;
    if (!current) return null;
    this.database.prepare("UPDATE dashboard_users SET role=?,status=?,updated_at=? WHERE user_id=?").run(changes.role ?? String(current.role), changes.status ?? String(current.status), now, userId);
    const row = this.database.prepare("SELECT user_id,display_name,role,status,created_at,updated_at FROM dashboard_users WHERE user_id=?").get(userId);
    return dashboardUserRow(row as Record<string, unknown>);
  }

  acceptRunEvent(event: RunEvent): "accepted" | "already_accepted" {
    const payload = JSON.stringify(event);
    const prior = this.database
      .prepare("SELECT payload_json FROM run_events WHERE event_id=?")
      .get(event.event_id) as { payload_json: string } | undefined;
    if (prior) {
      if (prior.payload_json !== payload)
        throw new RepositoryConflict("event_id_conflict");
      return "already_accepted";
    }
    this.database
      .prepare(
        "INSERT INTO run_events(event_id,cospec_run_id,event_type,occurred_at,payload_json) VALUES(?,?,?,?,?)",
      )
      .run(
        event.event_id,
        event.cospec_run_id,
        event.event_type,
        event.occurred_at,
        payload,
      );
    return "accepted";
  }

  getRunEvents(runId: string): RunEvent[] {
    return this.database
      .prepare(
        "SELECT payload_json FROM run_events WHERE cospec_run_id=? ORDER BY occurred_at,event_id",
      )
      .all(runId)
      .map((row) => JSON.parse(String(row.payload_json)) as RunEvent);
  }

  async acceptArtifact(
    metadata: ArtifactMetadata,
    bytes: Buffer,
  ): Promise<{ status: "accepted" | "already_accepted" }> {
    const fingerprint = artifactKey(metadata);
    const priorUpload = this.database
      .prepare(
        "SELECT artifact_key,metadata_json FROM artifacts WHERE upload_id=?",
      )
      .get(metadata.upload_id) as Record<string, unknown> | undefined;
    if (priorUpload) {
      if (
        String(priorUpload.artifact_key) !== fingerprint ||
        String(priorUpload.metadata_json) !== JSON.stringify(metadata)
      )
        throw new RepositoryConflict("upload_id_conflict");
      return { status: "already_accepted" };
    }
    const priorArtifact = this.database
      .prepare("SELECT sha256 FROM artifacts WHERE artifact_key=?")
      .get(fingerprint) as { sha256: string } | undefined;
    if (priorArtifact) return { status: "already_accepted" };
    const blobPath = join(
      "artifacts",
      metadata.sha256.slice(0, 2),
      metadata.sha256,
    );
    await writeImmutable(join(this.root, blobPath), bytes, metadata.sha256);
    this.database
      .prepare(
        "INSERT INTO artifacts(upload_id,artifact_key,cospec_run_id,sha256,blob_path,metadata_json,received_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        metadata.upload_id,
        fingerprint,
        metadata.cospec_run_id,
        metadata.sha256,
        blobPath,
        JSON.stringify(metadata),
        new Date().toISOString(),
      );
    return { status: "accepted" };
  }

  listArtifacts(runId: string): Array<Record<string, unknown>> {
    return this.database
      .prepare(
        "SELECT upload_id,metadata_json,received_at FROM artifacts WHERE cospec_run_id=? ORDER BY received_at,upload_id",
      )
      .all(runId)
      .map((row) => ({
        ...JSON.parse(String(row.metadata_json)),
        upload_id: String(row.upload_id),
        uploaded_at: String(row.received_at),
        status: "uploaded",
      }));
  }

  async getArtifact(
    uploadId: string,
  ): Promise<{ metadata: ArtifactMetadata; bytes: Buffer } | null> {
    const row = this.database
      .prepare(
        "SELECT metadata_json,blob_path FROM artifacts WHERE upload_id=?",
      )
      .get(uploadId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      metadata: JSON.parse(String(row.metadata_json)) as ArtifactMetadata,
      bytes: await readFile(join(this.root, String(row.blob_path))),
    };
  }

  getWorkflowSummary(
    filters: {
      from?: string;
      to?: string;
      employeeId?: string;
      proposerDept?: string;
    } = {},
  ): Record<string, unknown> {
    const events = this.database
      .prepare(
        "SELECT payload_json FROM run_events ORDER BY occurred_at,event_id",
      )
      .all()
      .map((row) => JSON.parse(String(row.payload_json)) as RunEvent);
    const runs = new Map<
      string,
      {
        workflow_kind?: string;
        workflow_name?: string;
        status: string;
        started_at?: string;
        actor?: {
          employee_id: string;
          display_name: string;
          proposer_dept?: string;
        };
      }
    >();
    const stages = new Map<
      string,
      {
        started: number;
        completed: number;
        failed: number;
        interrupted: number;
        skipped: number;
      }
    >();
    for (const event of events) {
      const run = runs.get(event.cospec_run_id) ?? { status: "running" };
      if (event.event_type === "run_started") {
        run.started_at = event.occurred_at;
        if (event.workflow_kind) run.workflow_kind = event.workflow_kind;
        if (event.workflow_name) run.workflow_name = event.workflow_name;
        if (event.actor) run.actor = event.actor;
      }
      if (event.event_type === "run_finished")
        run.status = event.status ?? "running";
      runs.set(event.cospec_run_id, run);
      if (event.stage) {
        const stage = stages.get(event.stage) ?? {
          started: 0,
          completed: 0,
          failed: 0,
          interrupted: 0,
          skipped: 0,
        };
        if (event.event_type === "stage_started") stage.started += 1;
        if (event.event_type === "stage_finished" && event.status && event.status !== "orphan")
          stage[event.status] += 1;
        stages.set(event.stage, stage);
      }
    }
    const terminalRows = this.database
      .prepare(
        `SELECT cospec_run_id,MIN(json_extract(metadata_json,'$.environment.anonymous_terminal_id')) AS terminal_id,MIN(received_at) AS received_at FROM chunks GROUP BY cospec_run_id`,
      )
      .all() as Record<string, unknown>[];
    const terminalByRun = new Map(
      terminalRows.map((row) => [
        String(row.cospec_run_id),
        nullableString(row.terminal_id),
      ]),
    );
    const effective = resolveEffectiveIdentities(
      [...runs].map(([runId, run]) => ({
        runId,
        terminalId: terminalByRun.get(runId) ?? null,
        occurredAt: run.started_at ?? "",
        ...(run.actor
          ? {
              actor: {
                employeeId: run.actor.employee_id,
                displayName: run.actor.display_name,
                proposerDept: run.actor.proposer_dept,
              },
            }
          : {}),
      })),
    );
    for (const [runId, identity] of effective) {
      const run = runs.get(runId)!;
      run.actor = {
        employee_id: identity.employeeId,
        display_name: identity.displayName,
        ...(identity.proposerDept
          ? { proposer_dept: identity.proposerDept }
          : {}),
      };
    }
    for (const [id, run] of runs)
      if (
        (filters.from &&
          (!run.started_at ||
            Date.parse(run.started_at) < Date.parse(filters.from))) ||
        (filters.to &&
          (!run.started_at ||
            Date.parse(run.started_at) > Date.parse(filters.to))) ||
        (filters.employeeId && run.actor?.employee_id !== filters.employeeId) ||
        (filters.proposerDept &&
          run.actor?.proposer_dept !== filters.proposerDept)
      )
        runs.delete(id);
    stages.clear();
    for (const event of events)
      if (runs.has(event.cospec_run_id) && event.stage) {
        const stage = stages.get(event.stage) ?? {
          started: 0,
          completed: 0,
          failed: 0,
          interrupted: 0,
          skipped: 0,
        };
        if (event.event_type === "stage_started") stage.started += 1;
        if (event.event_type === "stage_finished" && event.status && event.status !== "orphan")
          stage[event.status] += 1;
        stages.set(event.stage, stage);
      }
    const byKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byProposerDept: Record<string, number> = {};
    for (const run of runs.values()) {
      byKind[run.workflow_kind ?? "unknown"] =
        (byKind[run.workflow_kind ?? "unknown"] ?? 0) + 1;
      byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
      const dept = run.actor?.proposer_dept ?? "unknown";
      byProposerDept[dept] = (byProposerDept[dept] ?? 0) + 1;
    }
    const terminal =
      (byStatus.completed ?? 0) +
      (byStatus.failed ?? 0) +
      (byStatus.interrupted ?? 0);
    const people = new Map<
      string,
      { employee_id: string; display_name: string; runs: number }
    >();
    let identifiedRuns = 0;
    for (const run of runs.values())
      if (run.actor) {
        identifiedRuns += 1;
        const person = people.get(run.actor.employee_id) ?? {
          ...run.actor,
          runs: 0,
        };
        person.runs += 1;
        people.set(run.actor.employee_id, person);
      }
    const anonymousTerminals = new Set<string>();
    for (const [runId, run] of runs)
      if (!run.actor) {
        const terminalId = terminalByRun.get(runId);
        if (terminalId) anonymousTerminals.add(terminalId);
      }
    const artifactRows = runs.size
      ? this.database
          .prepare(
            `SELECT cospec_run_id,metadata_json FROM artifacts WHERE cospec_run_id IN (${[...runs].map(() => "?").join(",")})`,
          )
          .all(...runs.keys())
      : [];
    const artifactRuns = new Set<string>();
    const artifactsByRole: Record<string, number> = {};
    const artifactCountByRun = new Map<string, number>();
    for (const row of artifactRows) {
      const runId = String(row.cospec_run_id);
      artifactRuns.add(runId);
      artifactCountByRun.set(runId, (artifactCountByRun.get(runId) ?? 0) + 1);
      const role = String(
        JSON.parse(String(row.metadata_json)).artifact_role ?? "unknown",
      );
      increment(artifactsByRole, role);
    }
    const byDay = new Map<
      string,
      {
        total: number;
        people: Set<string>;
        anonymousTerminals: Set<string>;
        artifacts: number;
        output_workflows: number;
        by_status: Record<string, number>;
        by_kind: Record<string, number>;
      }
    >();
    for (const [runId, run] of runs) {
      if (!run.started_at) continue;
      const day = new Date(run.started_at).toISOString().slice(0, 10);
      const item = byDay.get(day) ?? {
        total: 0,
        people: new Set<string>(),
        anonymousTerminals: new Set<string>(),
        artifacts: 0,
        output_workflows: 0,
        by_status: {},
        by_kind: {},
      };
      item.total++;
      if (run.actor?.employee_id) item.people.add(run.actor.employee_id);
      else {
        const terminalId = terminalByRun.get(runId);
        if (terminalId) item.anonymousTerminals.add(terminalId);
      }
      item.artifacts += artifactCountByRun.get(runId) ?? 0;
      if (artifactRuns.has(runId)) item.output_workflows++;
      increment(item.by_status, run.status);
      increment(item.by_kind, run.workflow_kind ?? "unknown");
      byDay.set(day, item);
    }
    return {
      total: runs.size,
      by_kind: byKind,
      by_status: byStatus,
      by_proposer_dept: byProposerDept,
      completion_rate: terminal ? (byStatus.completed ?? 0) / terminal : null,
      people: {
        identified_runs: identifiedRuns,
        unknown_runs: runs.size - identifiedRuns,
        coverage: runs.size ? identifiedRuns / runs.size : null,
        unique_people: people.size,
        items: [...people.values()].sort((a, b) =>
          a.employee_id.localeCompare(b.employee_id),
        ),
      },
      active_users: {
        estimated: people.size + anonymousTerminals.size,
        identified_people: people.size,
        anonymous_terminals: anonymousTerminals.size,
        semantics: "identified_people_plus_unlinked_anonymous_terminals",
      },
      artifacts: {
        total: artifactRows.length,
        runs_with_artifacts: artifactRuns.size,
        run_coverage: runs.size ? artifactRuns.size / runs.size : null,
        by_role: artifactsByRole,
      },
      by_day: Object.fromEntries(
        [...byDay]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, item]) => [
            day,
            {
              total: item.total,
              unique_people: item.people.size,
              anonymous_terminals: item.anonymousTerminals.size,
              estimated_active_users:
                item.people.size + item.anonymousTerminals.size,
              artifacts: item.artifacts,
              output_workflows: item.output_workflows,
              by_status: item.by_status,
              by_kind: item.by_kind,
            },
          ]),
      ),
      filter_options: {
        people: [
          ...new Map(
            events
              .filter((event) => event.actor)
              .map((event) => [event.actor!.employee_id, event.actor!]),
          ).values(),
        ].sort((a, b) => a.employee_id.localeCompare(b.employee_id)),
        proposer_depts: [
          ...new Set(
            events
              .map((event) => event.actor?.proposer_dept)
              .filter((value): value is string => !!value),
          ),
        ].sort(),
      },
      stages: [...stages.entries()].map(([stage, counts]) => ({
        stage,
        ...counts,
      })),
    };
  }

  pendingChunks(): Array<{
    uploadId: string;
    runId: string;
    rawPath: string;
    sha256: string;
    sourceType: "codex_jsonl" | "claude_code_jsonl";
  }> {
    return this.database
      .prepare(
        "SELECT upload_id, cospec_run_id, raw_path, sha256, json_extract(metadata_json,'$.source_type') AS source_type FROM chunks WHERE parser_status='pending' ORDER BY received_at",
      )
      .all()
      .map((row) => ({
        uploadId: String(row.upload_id),
        runId: String(row.cospec_run_id),
        rawPath: join(this.root, String(row.raw_path)),
        sha256: String(row.sha256),
        sourceType: String(row.source_type) as
          "codex_jsonl" | "claude_code_jsonl",
      }));
  }

  saveParseResult(uploadId: string, result: ParseResult): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO parse_results
        (upload_id,parser_version,status,total_lines,valid_lines,invalid_lines,unknown_type_lines,
         type_counts_json,first_timestamp,last_timestamp,diagnostics_json,parsed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(upload_id,parser_version) DO NOTHING`,
        )
        .run(
          uploadId,
          result.parserVersion,
          result.status,
          result.totalLines,
          result.validLines,
          result.invalidLines,
          result.unknownTypeLines,
          JSON.stringify(result.typeCounts),
          result.firstTimestamp,
          result.lastTimestamp,
          JSON.stringify(result.diagnostics),
          new Date().toISOString(),
        );
      this.database
        .prepare("UPDATE chunks SET parser_status=? WHERE upload_id=?")
        .run(result.status, uploadId);
      this.insertFacts(uploadId, result);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  saveParseFailure(
    uploadId: string,
    parserVersion: string,
    code: string,
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO parse_results
        (upload_id,parser_version,status,diagnostics_json,parsed_at) VALUES(?,?,?,?,?)
        ON CONFLICT(upload_id,parser_version) DO NOTHING`,
        )
        .run(
          uploadId,
          parserVersion,
          "failed",
          JSON.stringify([{ code }]),
          new Date().toISOString(),
        );
      this.database
        .prepare("UPDATE chunks SET parser_status='failed' WHERE upload_id=?")
        .run(uploadId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  parseResultCount(): number {
    return Number(
      (
        this.database
          .prepare("SELECT COUNT(*) AS count FROM parse_results")
          .get() as { count: number }
      ).count,
    );
  }

  parseResults(): Array<Record<string, unknown>> {
    return this.database
      .prepare("SELECT * FROM parse_results ORDER BY parsed_at")
      .all() as Array<Record<string, unknown>>;
  }

  runChunks(
    runId: string,
  ): Array<{
    uploadId: string;
    rawPath: string;
    sha256: string;
    sourceType: "codex_jsonl" | "claude_code_jsonl";
  }> {
    return this.database
      .prepare(
        "SELECT upload_id,raw_path,sha256,json_extract(metadata_json,'$.source_type') AS source_type FROM chunks WHERE cospec_run_id=? ORDER BY start_offset",
      )
      .all(runId)
      .map((row) => ({
        uploadId: String(row.upload_id),
        rawPath: join(this.root, String(row.raw_path)),
        sha256: String(row.sha256),
        sourceType: String(row.source_type) as
          "codex_jsonl" | "claude_code_jsonl",
      }));
  }

  saveReplayResult(uploadId: string, result: ParseResult): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO parse_results
      (upload_id,parser_version,status,total_lines,valid_lines,invalid_lines,unknown_type_lines,
       type_counts_json,first_timestamp,last_timestamp,diagnostics_json,parsed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(upload_id,parser_version) DO NOTHING`,
        )
        .run(
          uploadId,
          result.parserVersion,
          result.status,
          result.totalLines,
          result.validLines,
          result.invalidLines,
          result.unknownTypeLines,
          JSON.stringify(result.typeCounts),
          result.firstTimestamp,
          result.lastTimestamp,
          JSON.stringify(result.diagnostics),
          new Date().toISOString(),
        );
      this.insertFacts(uploadId, result);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertFacts(uploadId: string, result: ParseResult): void {
    const message = this.database
      .prepare(`INSERT INTO message_facts(upload_id,parser_version,record_index,timestamp,role,model)
      VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
    for (const fact of result.messageFacts)
      message.run(
        uploadId,
        result.parserVersion,
        fact.recordIndex,
        fact.timestamp,
        fact.role,
        fact.model,
      );
    const token = this.database
      .prepare(`INSERT INTO token_usage_facts(upload_id,parser_version,record_index,timestamp,model,input_tokens,output_tokens,
      cache_read_input_tokens,cache_write_or_creation_input_tokens,reasoning_output_tokens,reported_total_tokens)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
    for (const fact of result.tokenUsageFacts)
      token.run(
        uploadId,
        result.parserVersion,
        fact.recordIndex,
        fact.timestamp,
        fact.model,
        fact.inputTokens,
        fact.outputTokens,
        fact.cacheReadInputTokens,
        fact.cacheWriteOrCreationInputTokens,
        fact.reasoningOutputTokens,
        fact.reportedTotalTokens,
      );
    const call = this.database
      .prepare(`INSERT INTO tool_call_facts(upload_id,parser_version,record_index,item_index,timestamp,call_id,tool_name)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
    for (const fact of result.toolCallFacts)
      call.run(
        uploadId,
        result.parserVersion,
        fact.recordIndex,
        fact.itemIndex,
        fact.timestamp,
        fact.callId,
        fact.toolName,
      );
    const toolResult = this.database
      .prepare(`INSERT INTO tool_result_facts(upload_id,parser_version,record_index,item_index,timestamp,call_id,status,failure_code)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
    for (const fact of result.toolResultFacts)
      toolResult.run(
        uploadId,
        result.parserVersion,
        fact.recordIndex,
        fact.itemIndex,
        fact.timestamp,
        fact.callId,
        fact.status,
        fact.failureCode,
      );
    const compaction = this.database
      .prepare(`INSERT INTO compaction_facts(upload_id,parser_version,record_index,timestamp,trigger,pre_tokens,post_tokens)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
    for (const fact of result.compactionFacts)
      compaction.run(
        uploadId,
        result.parserVersion,
        fact.recordIndex,
        fact.timestamp,
        fact.trigger,
        fact.preTokens,
        fact.postTokens,
      );
    const contextWindow = this.database
      .prepare(`INSERT INTO context_window_facts(upload_id,parser_version,record_index,timestamp,context_window_tokens)
      VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`);
    for (const fact of result.contextWindowFacts)
      contextWindow.run(
        uploadId,
        result.parserVersion,
        fact.recordIndex,
        fact.timestamp,
        fact.contextWindowTokens,
      );
    const skillMarker = this.database.prepare(`INSERT INTO skill_marker_facts
      (upload_id,parser_version,record_index,item_index,marker_index,timestamp,phase,skill,execution_id,status)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
    for (const fact of result.skillMarkerFacts)
      skillMarker.run(
        uploadId,
        result.parserVersion,
        fact.recordIndex,
        fact.itemIndex,
        fact.markerIndex,
        fact.timestamp,
        fact.phase,
        fact.skill,
        fact.executionId,
        fact.status,
      );
    const turnEvent = this.database.prepare(`INSERT INTO turn_event_facts
      (upload_id,parser_version,record_index,item_index,timestamp,kind) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
    for (const fact of result.turnEventFacts)
      turnEvent.run(
        uploadId,
        result.parserVersion,
        fact.recordIndex,
        fact.itemIndex,
        fact.timestamp,
        fact.kind,
      );
  }

  startReplay(
    runId: string,
    targetVersion: string,
    totalChunks: number,
  ): Record<string, unknown> {
    this.database
      .prepare(
        `INSERT INTO replay_jobs
      (job_id,cospec_run_id,target_version,status,total_chunks,started_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(cospec_run_id,target_version) DO NOTHING`,
      )
      .run(
        randomUUID(),
        runId,
        targetVersion,
        "running",
        totalChunks,
        new Date().toISOString(),
      );
    return this.database
      .prepare(
        "SELECT * FROM replay_jobs WHERE cospec_run_id=? AND target_version=?",
      )
      .get(runId, targetVersion) as Record<string, unknown>;
  }

  completeReplay(
    jobId: string,
    runId: string,
    targetVersion: string,
    completedChunks: number,
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO active_parser_versions(cospec_run_id,parser_version,activated_at) VALUES(?,?,?)
        ON CONFLICT(cospec_run_id) DO UPDATE SET parser_version=excluded.parser_version, activated_at=excluded.activated_at`,
        )
        .run(runId, targetVersion, new Date().toISOString());
      this.database
        .prepare(
          `UPDATE replay_jobs SET status='completed',completed_chunks=?,failed_chunks=0,finished_at=? WHERE job_id=?`,
        )
        .run(completedChunks, new Date().toISOString(), jobId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  failReplay(
    jobId: string,
    completedChunks: number,
    failureCode: string,
  ): void {
    this.database
      .prepare(
        `UPDATE replay_jobs SET status='failed',completed_chunks=?,failed_chunks=1,failure_code=?,finished_at=? WHERE job_id=?`,
      )
      .run(completedChunks, failureCode, new Date().toISOString(), jobId);
  }

  activeParserVersion(runId: string): string | null {
    const row = this.database
      .prepare(
        "SELECT parser_version FROM active_parser_versions WHERE cospec_run_id=?",
      )
      .get(runId);
    return row ? String(row.parser_version) : null;
  }

  activateRunIfFullyParsed(runId: string, parserVersion: string): boolean {
    const row = this.database
      .prepare(
        `SELECT
      (SELECT COUNT(*) FROM chunks WHERE cospec_run_id=?) AS total,
      (SELECT COUNT(*) FROM parse_results p JOIN chunks c ON c.upload_id=p.upload_id
       WHERE c.cospec_run_id=? AND p.parser_version=? AND p.status IN ('completed','completed_with_errors')) AS parsed`,
      )
      .get(runId, runId, parserVersion) as { total: number; parsed: number };
    if (row.total === 0 || row.total !== row.parsed) return false;
    this.database
      .prepare(
        `INSERT INTO active_parser_versions(cospec_run_id,parser_version,activated_at) VALUES(?,?,?)
      ON CONFLICT(cospec_run_id) DO UPDATE SET parser_version=excluded.parser_version,activated_at=excluded.activated_at`,
      )
      .run(runId, parserVersion, new Date().toISOString());
    return true;
  }

  replayJob(
    runId: string,
    targetVersion: string,
  ): Record<string, unknown> | undefined {
    return this.database
      .prepare(
        "SELECT * FROM replay_jobs WHERE cospec_run_id=? AND target_version=?",
      )
      .get(runId, targetVersion) as Record<string, unknown> | undefined;
  }

  listRuns(
    limit: number,
    offset: number,
    filters: RunListFilters = {},
  ): { items: RunListItem[]; total: number } {
    const workflows = new Map<
      string,
      {
        kind: string | undefined;
        name: string | undefined;
        status: string;
        startedAt: string | undefined;
        employeeId: string | undefined;
        displayName: string | undefined;
        proposerDept: string | undefined;
      }
    >();
    for (const row of this.database
      .prepare(
        "SELECT cospec_run_id,payload_json FROM run_events ORDER BY occurred_at,event_id",
      )
      .all()) {
      const event = JSON.parse(
        String(row.payload_json),
      ) as import("../collector/types.js").RunEvent;
      const item = workflows.get(event.cospec_run_id) ?? {
        kind: undefined,
        name: undefined,
        status: "running",
        startedAt: undefined,
        employeeId: undefined,
        displayName: undefined,
        proposerDept: undefined,
      };
      if (event.event_type === "run_started") {
        item.kind = event.workflow_kind;
        item.name = event.workflow_name;
        item.startedAt = event.occurred_at;
        item.employeeId = event.actor?.employee_id;
        item.displayName = event.actor?.display_name;
        item.proposerDept = event.actor?.proposer_dept;
      }
      if (event.event_type === "run_finished")
        item.status = event.status ?? "running";
      workflows.set(event.cospec_run_id, item);
    }
    const skillMap = new Map<string, Set<string>>();
    for (const row of this.database
      .prepare(
        `SELECT DISTINCT c.cospec_run_id,f.skill FROM skill_marker_facts f JOIN chunks c ON c.upload_id=f.upload_id JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=f.parser_version`,
      )
      .all()) {
      const set = skillMap.get(String(row.cospec_run_id)) ?? new Set<string>();
      set.add(String(row.skill));
      skillMap.set(String(row.cospec_run_id), set);
    }
    const artifacts = new Map<string, { count: number; roles: Set<string> }>();
    for (const row of this.database
      .prepare("SELECT cospec_run_id,metadata_json FROM artifacts")
      .all()) {
      const id = String(row.cospec_run_id);
      const item = artifacts.get(id) ?? { count: 0, roles: new Set<string>() };
      item.count++;
      item.roles.add(
        String(
          JSON.parse(String(row.metadata_json)).artifact_role ?? "unknown",
        ),
      );
      artifacts.set(id, item);
    }
    const failures = new Map<string, number>();
    for (const row of this.database
      .prepare(
        `SELECT c.cospec_run_id,COUNT(*) AS count FROM tool_result_facts f JOIN chunks c ON c.upload_id=f.upload_id JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=f.parser_version WHERE f.status='failure' GROUP BY c.cospec_run_id`,
      )
      .all())
      failures.set(String(row.cospec_run_id), Number(row.count));
    const summaryRows = this.database
      .prepare(`${runSummarySql()} ORDER BY first_received_at DESC`)
      .all() as Record<string, unknown>[];
    const identities = resolveEffectiveIdentities(
      summaryRows.map((row) => {
        const id = String(row.cospec_run_id),
          flow = workflows.get(id);
        return {
          runId: id,
          terminalId: nullableString(row.anonymous_terminal_id),
          occurredAt: flow?.startedAt ?? String(row.first_received_at),
          ...(flow?.employeeId
            ? {
                actor: {
                  employeeId: flow.employeeId,
                  displayName: flow.displayName ?? flow.employeeId,
                  proposerDept: flow.proposerDept,
                },
              }
            : {}),
        };
      }),
    );
    const now = Date.now();
    let items: RunListItem[] = summaryRows
      .map((row): RunListItem => {
        const base = toRunListItem(row);
        const flow = workflows.get(base.runId);
        const identity = identities.get(base.runId);
        return {
          ...base,
          workflowKind: flow?.kind ?? null,
          workflowName: flow?.name ?? null,
          workflowStatus: flow?.status ?? "running",
          employeeId: identity?.employeeId ?? null,
          displayName: identity?.displayName ?? null,
          proposerDept: identity?.proposerDept ?? null,
          identityResolution: identity?.resolution ?? "unknown",
          skills: [...(skillMap.get(base.runId) ?? [])].sort(),
          artifactCount: artifacts.get(base.runId)?.count ?? 0,
          toolFailureCount: failures.get(base.runId) ?? 0,
        };
      })
      .filter((item) => {
        const started =
          workflows.get(item.runId)?.startedAt ?? item.firstReceivedAt;
        return (
          (!filters.from || Date.parse(started) >= Date.parse(filters.from)) &&
          (!filters.to || Date.parse(started) <= Date.parse(filters.to)) &&
          (!filters.agentType || item.agentType === filters.agentType) &&
          (!filters.agentVersion ||
            item.agentVersion === filters.agentVersion) &&
          (!filters.cospecPluginVersion ||
            item.cospecPluginVersion === filters.cospecPluginVersion) &&
          (!filters.employeeId || item.employeeId === filters.employeeId) &&
          (!filters.proposerDept ||
            item.proposerDept === filters.proposerDept) &&
          (!filters.workflowKind ||
            item.workflowKind === filters.workflowKind) &&
          (!filters.workflowStatus ||
            item.workflowStatus === filters.workflowStatus) &&
          (!filters.skill || item.skills.includes(filters.skill)) &&
          (filters.hasArtifact === undefined ||
            item.artifactCount > 0 === filters.hasArtifact) &&
          (!filters.artifactRole ||
            artifacts.get(item.runId)?.roles.has(filters.artifactRole) ===
              true) &&
          (filters.toolFailure === undefined ||
            item.toolFailureCount > 0 === filters.toolFailure) &&
          (filters.identityMissing === undefined ||
            !item.employeeId === filters.identityMissing) &&
          (filters.inactiveHours === undefined ||
            now - Date.parse(item.lastReceivedAt) >=
              filters.inactiveHours * 3600000)
        );
      });
    const total = items.length;
    items = items.slice(offset, offset + limit);
    return { items, total };
  }

  getRun(runId: string): RunDetail | null {
    const row = this.database
      .prepare(`${runSummarySql()} HAVING c.cospec_run_id=?`)
      .get(runId);
    if (!row) return null;
    const rawBase = toRunListItem(row);
    // Keep the detail header consistent with the run list. The list summary
    // resolves lifecycle events, terminal identity backfill, artifacts and
    // parsed facts; the raw chunk summary alone does not contain those values.
    const base =
      this.listRuns(Number.MAX_SAFE_INTEGER, 0).items.find(
        (item) => item.runId === runId,
      ) ?? rawBase;
    const statusRows = this.database
      .prepare(
        "SELECT parser_status,COUNT(*) AS count FROM chunks WHERE cospec_run_id=? GROUP BY parser_status",
      )
      .all(runId);
    const parseStatusCounts = Object.fromEntries(
      statusRows.map((item) => [
        String(item.parser_status),
        Number(item.count),
      ]),
    );
    const parseRows = base.activeParserVersion
      ? this.database
          .prepare(
            `SELECT p.* FROM parse_results p JOIN chunks c ON c.upload_id=p.upload_id
          WHERE c.cospec_run_id=? AND p.parser_version=?`,
          )
          .all(runId, base.activeParserVersion)
      : [];
    const typeCounts: Record<string, number> = {};
    const timestamps: string[] = [];
    for (const item of parseRows) {
      for (const [type, count] of Object.entries(
        JSON.parse(String(item.type_counts_json ?? "{}")) as Record<
          string,
          number
        >,
      ))
        typeCounts[type] = (typeCounts[type] ?? 0) + count;
      if (item.first_timestamp) timestamps.push(String(item.first_timestamp));
      if (item.last_timestamp) timestamps.push(String(item.last_timestamp));
    }
    timestamps.sort((a, b) => Date.parse(a) - Date.parse(b));
    const sum = (field: string) =>
      parseRows.length
        ? parseRows.reduce((value, item) => value + Number(item[field] ?? 0), 0)
        : null;
    return {
      ...base,
      parseStatusCounts,
      totalLines: sum("total_lines"),
      validLines: sum("valid_lines"),
      invalidLines: sum("invalid_lines"),
      unknownTypeLines: sum("unknown_type_lines"),
      typeCounts,
      firstTimestamp: timestamps[0] ?? null,
      lastTimestamp: timestamps.at(-1) ?? null,
    };
  }

  async getRunChunks(runId: string): Promise<Array<Record<string, unknown>>> {
    const rows = this.database
      .prepare(
        `SELECT upload_id,start_offset,end_offset,sha256,parser_status,received_at,raw_path,
      json_extract(metadata_json,'$.file.generation') AS generation FROM chunks WHERE cospec_run_id=? ORDER BY start_offset`,
      )
      .all(runId);
    return Promise.all(
      rows.map(async (row) => ({
        uploadId: String(row.upload_id),
        generation: Number(row.generation),
        startOffset: Number(row.start_offset),
        endOffset: Number(row.end_offset),
        byteCount: Number(row.end_offset) - Number(row.start_offset),
        sha256: String(row.sha256),
        parserStatus: String(row.parser_status),
        receivedAt: String(row.received_at),
        rawPresent: await exists(join(this.root, String(row.raw_path))),
      })),
    );
  }

  listRunRawSources(runId: string): Array<Record<string, unknown>> {
    return this.database
      .prepare(
        `SELECT
      json_extract(metadata_json,'$.file.source_file_id') AS sourceFileId,
      json_extract(metadata_json,'$.file.generation') AS generation,
      json_extract(metadata_json,'$.agent_session_id') AS agentSessionId,
      json_extract(metadata_json,'$.source_type') AS sourceType,
      json_extract(metadata_json,'$.session.role') AS sessionRole,
      COUNT(*) AS chunkCount,SUM(end_offset-start_offset) AS byteCount,
      MIN(received_at) AS firstReceivedAt,MAX(received_at) AS lastReceivedAt
      FROM chunks WHERE cospec_run_id=?
      GROUP BY sourceFileId,generation,agentSessionId,sourceType,sessionRole
      ORDER BY CASE WHEN sessionRole='subagent' THEN 1 ELSE 0 END,firstReceivedAt`,
      )
      .all(runId) as Array<Record<string, unknown>>;
  }

  async getRunRawSource(
    runId: string,
    sourceFileId: string,
    generation: number,
  ): Promise<Buffer | null> {
    const rows = this.database
      .prepare(
        `SELECT raw_path,sha256 FROM chunks
      WHERE cospec_run_id=?
        AND json_extract(metadata_json,'$.file.source_file_id')=?
        AND json_extract(metadata_json,'$.file.generation')=?
      ORDER BY start_offset`,
      )
      .all(runId, sourceFileId, generation) as Array<{
      raw_path: string;
      sha256: string;
    }>;
    if (!rows.length) return null;
    const blocks: Buffer[] = [];
    for (const row of rows) {
      const block = await readFile(join(this.root, row.raw_path));
      if (createHash("sha256").update(block).digest("hex") !== row.sha256)
        throw new Error("raw_integrity_failure");
      blocks.push(block);
    }
    return Buffer.concat(blocks);
  }

  getRunReplays(runId: string): Array<Record<string, unknown>> {
    return this.database
      .prepare(
        `SELECT job_id AS jobId,target_version AS targetVersion,status,total_chunks AS totalChunks,
      completed_chunks AS completedChunks,failed_chunks AS failedChunks,failure_code AS failureCode,
      started_at AS startedAt,finished_at AS finishedAt FROM replay_jobs WHERE cospec_run_id=? ORDER BY started_at DESC`,
      )
      .all(runId) as Array<Record<string, unknown>>;
  }

  getRunFacts(runId: string): Record<string, unknown> | null {
    const version = this.activeParserVersion(runId);
    if (!version || !this.getRun(runId)) return null;
    const params = [runId, version];
    const messageRows = this.database
      .prepare(
        `SELECT m.role,COUNT(*) AS count FROM message_facts m JOIN chunks c ON c.upload_id=m.upload_id
      WHERE c.cospec_run_id=? AND m.parser_version=? GROUP BY m.role`,
      )
      .all(...params);
    const token = this.database
      .prepare(
        `SELECT COUNT(*) AS observations,
      COUNT(input_tokens) AS input_samples,SUM(input_tokens) AS input_tokens,
      COUNT(output_tokens) AS output_samples,SUM(output_tokens) AS output_tokens,
      COUNT(cache_read_input_tokens) AS cache_read_samples,SUM(cache_read_input_tokens) AS cache_read_input_tokens,
      COUNT(cache_write_or_creation_input_tokens) AS cache_write_samples,SUM(cache_write_or_creation_input_tokens) AS cache_write_or_creation_input_tokens,
      COUNT(reasoning_output_tokens) AS reasoning_samples,SUM(reasoning_output_tokens) AS reasoning_output_tokens,
      COUNT(reported_total_tokens) AS reported_total_samples,SUM(reported_total_tokens) AS reported_total_tokens
      FROM token_usage_facts t JOIN chunks c ON c.upload_id=t.upload_id WHERE c.cospec_run_id=? AND t.parser_version=?`,
      )
      .get(...params) as Record<string, unknown>;
    const tokenFactRows = this.database
      .prepare(
        `SELECT t.timestamp,t.input_tokens,t.output_tokens,t.cache_read_input_tokens,
      t.cache_write_or_creation_input_tokens,t.reasoning_output_tokens,t.reported_total_tokens,
      json_extract(c.metadata_json,'$.session.role') AS session_role,
      json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id
      FROM token_usage_facts t JOIN chunks c ON c.upload_id=t.upload_id WHERE c.cospec_run_id=? AND t.parser_version=?
      ORDER BY c.start_offset,t.record_index`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    const toolCounts = numericObject(
      this.database
        .prepare(
          `SELECT
      (SELECT COUNT(*) FROM tool_call_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?) AS calls,
      (SELECT COUNT(*) FROM tool_result_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=? AND f.status='success') AS successes,
      (SELECT COUNT(*) FROM tool_result_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=? AND f.status='failure') AS failures`,
        )
        .get(runId, version, runId, version, runId, version) as Record<
        string,
        unknown
      >,
    );
    const toolRows = this.database
      .prepare(
        `WITH calls AS (
        SELECT f.call_id,f.tool_name FROM tool_call_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?
      ), results AS (
        SELECT f.call_id,f.status FROM tool_result_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?
      ) SELECT calls.tool_name,COUNT(*) AS calls,
        SUM(CASE WHEN results.status='success' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN results.status='failure' THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN results.status IS NULL OR results.status='unknown' THEN 1 ELSE 0 END) AS unknown_results
      FROM calls LEFT JOIN results ON results.call_id=calls.call_id GROUP BY calls.tool_name ORDER BY calls.tool_name`,
      )
      .all(runId, version, runId, version);
    const toolCallTimes = this.database
      .prepare(
        `SELECT f.call_id,f.tool_name,f.timestamp,
      json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id FROM tool_call_facts f
      JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?
      ORDER BY f.record_index,f.item_index`,
      )
      .all(runId, version) as Array<Record<string, unknown>>;
    const toolResultTimes = this.database
      .prepare(
        `SELECT f.call_id,f.timestamp,f.status,
      json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id FROM tool_result_facts f
      JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?
      ORDER BY f.record_index,f.item_index`,
      )
      .all(runId, version) as Array<Record<string, unknown>>;
    const toolDurations = calculateToolDurations(
      toolCallTimes,
      toolResultTimes,
    );
    const modelRows = this.database
      .prepare(
        `SELECT model,COUNT(*) AS observations FROM token_usage_facts t JOIN chunks c ON c.upload_id=t.upload_id
      WHERE c.cospec_run_id=? AND t.parser_version=? AND model IS NOT NULL GROUP BY model ORDER BY model`,
      )
      .all(runId, version);
    const time = this.database
      .prepare(
        `SELECT MIN(timestamp) AS first_event_at,MAX(timestamp) AS last_event_at FROM (
      SELECT m.timestamp FROM message_facts m JOIN chunks c ON c.upload_id=m.upload_id WHERE c.cospec_run_id=? AND m.parser_version=?
      UNION ALL SELECT f.timestamp FROM tool_call_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?) WHERE timestamp IS NOT NULL`,
      )
      .get(runId, version, runId, version) as Record<string, unknown>;
    const compactionRows = this.database
      .prepare(
        `SELECT f.trigger,f.pre_tokens,f.post_tokens FROM compaction_facts f
      JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?
      ORDER BY c.start_offset,f.record_index`,
      )
      .all(runId, version) as Array<Record<string, unknown>>;
    const contextWindowRows = this.database
      .prepare(
        `SELECT f.context_window_tokens FROM context_window_facts f
      JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?
      ORDER BY c.start_offset,f.record_index`,
      )
      .all(runId, version) as Array<Record<string, unknown>>;
    const contextWindowValues = [
      ...new Set(
        contextWindowRows.map((row) => Number(row.context_window_tokens)),
      ),
    ];
    const skillMarkerRows = this.database
      .prepare(
        `SELECT f.phase,f.skill,f.execution_id,f.status,f.timestamp
      FROM skill_marker_facts f JOIN chunks c ON c.upload_id=f.upload_id
      WHERE c.cospec_run_id=? AND f.parser_version=?
      ORDER BY c.start_offset,f.record_index,f.item_index,f.marker_index`,
      )
      .all(runId, version) as Array<Record<string, unknown>>;
    const structuredSkillRows = this.getStructuredSkillRows(runId).map(({ cospec_run_id: _runId, ...row }) => row);
    const effectiveSkillRows = preferStructuredSkillRows(skillMarkerRows, structuredSkillRows);
    const turnEventRows = this.database
      .prepare(
        `SELECT f.kind,f.timestamp FROM turn_event_facts f JOIN chunks c ON c.upload_id=f.upload_id
      WHERE c.cospec_run_id=? AND f.parser_version=? ORDER BY c.start_offset,f.record_index,f.item_index`,
      )
      .all(runId, version) as Array<Record<string, unknown>>;
    const subagentSessionRows = this.database
      .prepare(
        `SELECT json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id,
      MIN(p.first_timestamp) AS first_event_at FROM chunks c LEFT JOIN parse_results p ON p.upload_id=c.upload_id AND p.parser_version=?
      WHERE c.cospec_run_id=? AND json_extract(c.metadata_json,'$.session.role')='subagent' GROUP BY agent_session_id`,
      )
      .all(version, runId) as Array<Record<string, unknown>>;
    const skills = summarizeSkillExecutions(effectiveSkillRows, turnEventRows, {
      tokenRows: tokenFactRows,
      callRows: toolCallTimes,
      resultRows: toolResultTimes,
      subagentRows: subagentSessionRows,
    });
    return {
      parserVersion: version,
      messages: {
        total: messageRows.reduce((sum, row) => sum + Number(row.count), 0),
        byRole: Object.fromEntries(
          messageRows.map((row) => [String(row.role), Number(row.count)]),
        ),
      },
      tokens: {
        ...numericObject(token),
        byModel: Object.fromEntries(
          modelRows.map((row) => [String(row.model), Number(row.observations)]),
        ),
      },
      tools: {
        ...toolStatusMetrics(toolCounts),
        duration: toolDurations.overall,
        byTool: Object.fromEntries(
          toolRows.map((row) => {
            const { tool_name: _toolName, ...counts } = row;
            const toolName = String(row.tool_name);
            return [
              toolName,
              {
                ...toolStatusMetrics(numericObject(counts)),
                duration: toolDurations.byTool[toolName],
              },
            ];
          }),
        ),
      },
      interval: {
        firstEventAt: time.first_event_at ?? null,
        lastEventAt: time.last_event_at ?? null,
        semantics: "host_record_span",
      },
      skills,
      attribution: {
        run: "explicit_jsonl_offset_interval",
        skill: structuredSkillRows.length
          ? "structured_skill_events"
          : skillMarkerRows.length
            ? "explicit_start_end_markers"
          : "unavailable",
      },
      subagents: this.getRunSubagentFacts(runId, version),
      context: {
        compactions: {
          total: compactionRows.length,
          byTrigger: {
            auto: compactionRows.filter((row) => row.trigger === "auto").length,
            manual: compactionRows.filter((row) => row.trigger === "manual")
              .length,
            unknown: compactionRows.filter((row) => row.trigger === "unknown")
              .length,
          },
          withTokenDelta: compactionRows.filter(
            (row) => row.pre_tokens !== null && row.post_tokens !== null,
          ).length,
        },
        window: {
          observed: contextWindowRows.length > 0,
          latestTokens: contextWindowRows.length
            ? Number(contextWindowRows.at(-1)!.context_window_tokens)
            : null,
          observedValues: contextWindowValues,
          source: contextWindowRows.length
            ? "jsonl_explicit_field"
            : "unavailable",
        },
      },
    };
  }

  private getStructuredSkillRows(runId?: string): Array<Record<string, unknown>> {
    const rows = this.database.prepare(`SELECT cospec_run_id,payload_json FROM run_events
      WHERE event_type IN ('skill_started','skill_finished') ${runId ? "AND cospec_run_id=?" : ""}
      ORDER BY cospec_run_id,occurred_at,event_id`).all(...(runId ? [runId] : [])) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const event = JSON.parse(String(row.payload_json)) as RunEvent;
      return { cospec_run_id: String(row.cospec_run_id), phase: event.event_type === "skill_started" ? "start" : "end",
        skill: event.skill, execution_id: event.execution_id, timestamp: event.occurred_at,
        status: event.event_type === "skill_finished" ? structuredSkillStatus(event.status) : null };
    });
  }

  private getRunSubagentFacts(
    runId: string,
    version: string,
  ): Record<string, unknown> {
    const sessions = this.database
      .prepare(
        `SELECT
      json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id,
      json_extract(c.metadata_json,'$.session.parent_agent_session_id') AS parent_agent_session_id,
      MIN(p.first_timestamp) AS first_event_at,MAX(p.last_timestamp) AS last_event_at,
      MAX(CASE WHEN p.status IN ('completed','completed_with_errors') THEN 1 ELSE 0 END) AS parsed
      FROM chunks c LEFT JOIN parse_results p ON p.upload_id=c.upload_id AND p.parser_version=?
      WHERE c.cospec_run_id=? AND json_extract(c.metadata_json,'$.session.role')='subagent'
      GROUP BY agent_session_id,parent_agent_session_id ORDER BY agent_session_id`,
      )
      .all(version, runId) as Array<Record<string, unknown>>;
    const messages = this.database
      .prepare(
        `SELECT json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id,m.role,COUNT(*) AS count
      FROM message_facts m JOIN chunks c ON c.upload_id=m.upload_id WHERE c.cospec_run_id=? AND m.parser_version=?
      AND json_extract(c.metadata_json,'$.session.role')='subagent' GROUP BY agent_session_id,m.role`,
      )
      .all(runId, version) as Array<Record<string, unknown>>;
    const tokens = this.database
      .prepare(
        `SELECT json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id,t.model,COUNT(*) AS observations,
      COUNT(t.input_tokens) AS input_samples,SUM(t.input_tokens) AS input_tokens,
      COUNT(t.output_tokens) AS output_samples,SUM(t.output_tokens) AS output_tokens,
      COUNT(t.cache_read_input_tokens) AS cache_read_samples,SUM(t.cache_read_input_tokens) AS cache_read_input_tokens,
      COUNT(t.cache_write_or_creation_input_tokens) AS cache_write_samples,SUM(t.cache_write_or_creation_input_tokens) AS cache_write_or_creation_input_tokens,
      COUNT(t.reasoning_output_tokens) AS reasoning_samples,SUM(t.reasoning_output_tokens) AS reasoning_output_tokens,
      COUNT(t.reported_total_tokens) AS reported_total_samples,SUM(t.reported_total_tokens) AS reported_total_tokens
      FROM token_usage_facts t JOIN chunks c ON c.upload_id=t.upload_id WHERE c.cospec_run_id=? AND t.parser_version=?
      AND json_extract(c.metadata_json,'$.session.role')='subagent' GROUP BY agent_session_id,t.model`,
      )
      .all(runId, version) as Array<Record<string, unknown>>;
    const calls = this.database
      .prepare(
        `SELECT json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id,
      f.call_id,f.tool_name,f.timestamp FROM tool_call_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?
      AND json_extract(c.metadata_json,'$.session.role')='subagent'`,
      )
      .all(runId, version) as Array<Record<string, unknown>>;
    const results = this.database
      .prepare(
        `SELECT json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id,
      f.call_id,f.timestamp FROM tool_result_facts f JOIN chunks c ON c.upload_id=f.upload_id WHERE c.cospec_run_id=? AND f.parser_version=?
      AND json_extract(c.metadata_json,'$.session.role')='subagent'`,
      )
      .all(runId, version) as Array<Record<string, unknown>>;
    return summarizeSubagents(sessions, messages, tokens, calls, results);
  }

  getRunUsageSummary(filters: RunUsageFilters): Record<string, unknown> {
    const runRows = this.database
      .prepare(
        `SELECT c.cospec_run_id,
      COALESCE(MIN(CASE WHEN json_extract(c.metadata_json,'$.session.role')='main' OR json_extract(c.metadata_json,'$.session.role') IS NULL
        THEN json_extract(c.metadata_json,'$.environment.agent_type') END),MIN(json_extract(c.metadata_json,'$.environment.agent_type'))) AS agent_type,
      COALESCE(MIN(CASE WHEN json_extract(c.metadata_json,'$.session.role')='main' OR json_extract(c.metadata_json,'$.session.role') IS NULL
        THEN json_extract(c.metadata_json,'$.environment.agent_version') END),MIN(json_extract(c.metadata_json,'$.environment.agent_version'))) AS agent_version,
      COALESCE(MIN(CASE WHEN json_extract(c.metadata_json,'$.session.role')='main' OR json_extract(c.metadata_json,'$.session.role') IS NULL
        THEN json_extract(c.metadata_json,'$.environment.anonymous_terminal_id') END),MIN(json_extract(c.metadata_json,'$.environment.anonymous_terminal_id'))) AS anonymous_terminal_id,
      COALESCE(MIN(CASE WHEN json_extract(c.metadata_json,'$.session.role')='main' OR json_extract(c.metadata_json,'$.session.role') IS NULL
        THEN json_extract(c.metadata_json,'$.environment.cospec_plugin_version') END),MIN(json_extract(c.metadata_json,'$.environment.cospec_plugin_version'))) AS cospec_plugin_version,
      MIN(c.received_at) AS first_received_at,a.parser_version,
      MIN(CASE WHEN p.parser_version=a.parser_version THEN p.first_timestamp END) AS first_event_at,
      MAX(CASE WHEN p.parser_version=a.parser_version THEN p.last_timestamp END) AS last_event_at,
      MAX(CASE WHEN json_extract(c.metadata_json,'$.session.role')='main' THEN 1 ELSE 0 END) AS subagent_collection
      FROM chunks c LEFT JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id
      LEFT JOIN parse_results p ON p.upload_id=c.upload_id
      GROUP BY c.cospec_run_id`,
      )
      .all() as Array<Record<string, unknown>>;
    const artifactRows = this.database
      .prepare(
        `SELECT cospec_run_id,json_extract(metadata_json,'$.skill') AS skill,COUNT(*) AS count
      FROM artifacts GROUP BY cospec_run_id,skill`,
      )
      .all() as Array<Record<string, unknown>>;
    const messageRows = this.database
      .prepare(
        `SELECT c.cospec_run_id,m.parser_version,m.role,COUNT(*) AS count
      FROM message_facts m JOIN chunks c ON c.upload_id=m.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=m.parser_version
      GROUP BY c.cospec_run_id,m.parser_version,m.role`,
      )
      .all() as Array<Record<string, unknown>>;
    const tokenRows = this.database
      .prepare(
        `SELECT c.cospec_run_id,t.parser_version,t.model,COUNT(*) AS observations,
      COUNT(t.input_tokens) AS input_samples,SUM(t.input_tokens) AS input_tokens,
      COUNT(t.output_tokens) AS output_samples,SUM(t.output_tokens) AS output_tokens,
      COUNT(t.cache_read_input_tokens) AS cache_read_samples,SUM(t.cache_read_input_tokens) AS cache_read_input_tokens,
      COUNT(t.cache_write_or_creation_input_tokens) AS cache_write_samples,SUM(t.cache_write_or_creation_input_tokens) AS cache_write_or_creation_input_tokens,
      COUNT(t.reasoning_output_tokens) AS reasoning_samples,SUM(t.reasoning_output_tokens) AS reasoning_output_tokens,
      COUNT(t.reported_total_tokens) AS reported_total_samples,SUM(t.reported_total_tokens) AS reported_total_tokens
      FROM token_usage_facts t JOIN chunks c ON c.upload_id=t.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=t.parser_version
      GROUP BY c.cospec_run_id,t.parser_version,t.model`,
      )
      .all() as Array<Record<string, unknown>>;
    const tokenFactRows = this.database
      .prepare(
        `SELECT c.cospec_run_id,t.timestamp,t.input_tokens,t.output_tokens,
      t.cache_read_input_tokens,t.cache_write_or_creation_input_tokens,t.reasoning_output_tokens,t.reported_total_tokens,
      json_extract(c.metadata_json,'$.session.role') AS session_role,
      json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id
      FROM token_usage_facts t JOIN chunks c ON c.upload_id=t.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=t.parser_version
      ORDER BY c.cospec_run_id,c.start_offset,t.record_index`,
      )
      .all() as Array<Record<string, unknown>>;
    const toolCallRows = this.database
      .prepare(
        `SELECT c.cospec_run_id,f.call_id,f.tool_name,f.timestamp,
      json_extract(c.metadata_json,'$.session.role') AS session_role,
      json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id
      FROM tool_call_facts f JOIN chunks c ON c.upload_id=f.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=f.parser_version
      ORDER BY c.cospec_run_id,f.record_index,f.item_index`,
      )
      .all() as Array<Record<string, unknown>>;
    const toolResultRows = this.database
      .prepare(
        `SELECT c.cospec_run_id,f.call_id,f.timestamp,f.status,
      json_extract(c.metadata_json,'$.session.role') AS session_role,
      json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id
      FROM tool_result_facts f JOIN chunks c ON c.upload_id=f.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=f.parser_version
      ORDER BY c.cospec_run_id,f.record_index,f.item_index`,
      )
      .all() as Array<Record<string, unknown>>;
    const skillMarkerRows = this.database
      .prepare(
        `SELECT c.cospec_run_id,f.phase,f.skill,f.execution_id,f.status,f.timestamp
      FROM skill_marker_facts f JOIN chunks c ON c.upload_id=f.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=f.parser_version
      ORDER BY c.cospec_run_id,c.start_offset,f.record_index,f.item_index,f.marker_index`,
      )
      .all() as Array<Record<string, unknown>>;
    const effectiveSkillRows = preferStructuredSkillRows(skillMarkerRows, this.getStructuredSkillRows());
    const turnEventRows = this.database
      .prepare(
        `SELECT c.cospec_run_id,f.kind,f.timestamp
      FROM turn_event_facts f JOIN chunks c ON c.upload_id=f.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=f.parser_version
      ORDER BY c.cospec_run_id,c.start_offset,f.record_index,f.item_index`,
      )
      .all() as Array<Record<string, unknown>>;
    const compactionRows = this.database
      .prepare(
        `SELECT c.cospec_run_id,f.trigger FROM compaction_facts f JOIN chunks c ON c.upload_id=f.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=f.parser_version`,
      )
      .all() as Array<Record<string, unknown>>;
    const subagentSessionRows = this.database
      .prepare(
        `SELECT c.cospec_run_id,
      json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id,
      json_extract(c.metadata_json,'$.session.parent_agent_session_id') AS parent_agent_session_id,
      MIN(CASE WHEN p.parser_version=a.parser_version THEN p.first_timestamp END) AS first_event_at,
      MAX(CASE WHEN p.parser_version=a.parser_version THEN p.last_timestamp END) AS last_event_at
      FROM chunks c JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id
      LEFT JOIN parse_results p ON p.upload_id=c.upload_id
      WHERE json_extract(c.metadata_json,'$.session.role')='subagent'
      GROUP BY c.cospec_run_id,agent_session_id,parent_agent_session_id`,
      )
      .all() as Array<Record<string, unknown>>;
    const subagentMessageRows = this.database
      .prepare(
        `SELECT c.cospec_run_id,
      json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id,COUNT(*) AS count
      FROM message_facts m JOIN chunks c ON c.upload_id=m.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=m.parser_version
      WHERE json_extract(c.metadata_json,'$.session.role')='subagent' GROUP BY c.cospec_run_id,agent_session_id`,
      )
      .all() as Array<Record<string, unknown>>;
    const subagentTokenRows = this.database
      .prepare(
        `SELECT c.cospec_run_id,
      json_extract(c.metadata_json,'$.agent_session_id') AS agent_session_id,t.model,COUNT(*) AS observations,
      COUNT(t.input_tokens) AS input_samples,SUM(t.input_tokens) AS input_tokens,
      COUNT(t.output_tokens) AS output_samples,SUM(t.output_tokens) AS output_tokens,
      COUNT(t.cache_read_input_tokens) AS cache_read_samples,SUM(t.cache_read_input_tokens) AS cache_read_input_tokens,
      COUNT(t.cache_write_or_creation_input_tokens) AS cache_write_samples,SUM(t.cache_write_or_creation_input_tokens) AS cache_write_or_creation_input_tokens,
      COUNT(t.reasoning_output_tokens) AS reasoning_samples,SUM(t.reasoning_output_tokens) AS reasoning_output_tokens,
      COUNT(t.reported_total_tokens) AS reported_total_samples,SUM(t.reported_total_tokens) AS reported_total_tokens
      FROM token_usage_facts t JOIN chunks c ON c.upload_id=t.upload_id
      JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id AND a.parser_version=t.parser_version
      WHERE json_extract(c.metadata_json,'$.session.role')='subagent' GROUP BY c.cospec_run_id,agent_session_id,t.model`,
      )
      .all() as Array<Record<string, unknown>>;

    const modelsByRun = new Map<string, Set<string>>();
    for (const row of tokenRows)
      if (row.model !== null) {
        const models =
          modelsByRun.get(String(row.cospec_run_id)) ?? new Set<string>();
        models.add(String(row.model));
        modelsByRun.set(String(row.cospec_run_id), models);
      }
    const actors = new Map<
      string,
      { employee_id: string; display_name: string; proposer_dept?: string }
    >();
    const workflowKinds = new Map<string, string>();
    const actorTimes = new Map<string, string>();
    for (const row of this.database
      .prepare(
        "SELECT cospec_run_id,payload_json FROM run_events WHERE event_type='run_started'",
      )
      .all()) {
      const event = JSON.parse(String(row.payload_json)) as RunEvent;
      if (event.workflow_kind)
        workflowKinds.set(String(row.cospec_run_id), event.workflow_kind);
      if (event.actor?.employee_id) {
        actors.set(String(row.cospec_run_id), event.actor);
        actorTimes.set(String(row.cospec_run_id), event.occurred_at);
      }
    }
    const effectiveActors = resolveEffectiveIdentities(
      runRows.map((row) => {
        const runId = String(row.cospec_run_id),
          actor = actors.get(runId);
        return {
          runId,
          terminalId: nullableString(row.anonymous_terminal_id),
          occurredAt:
            actorTimes.get(runId) ??
            String(row.first_event_at ?? row.first_received_at),
          ...(actor
            ? {
                actor: {
                  employeeId: actor.employee_id,
                  displayName: actor.display_name,
                  proposerDept: actor.proposer_dept,
                },
              }
            : {}),
        };
      }),
    );
    for (const [runId, identity] of effectiveActors)
      actors.set(runId, {
        employee_id: identity.employeeId,
        display_name: identity.displayName,
        ...(identity.proposerDept
          ? { proposer_dept: identity.proposerDept }
          : {}),
      });
    const matchesDimensions = (row: Record<string, unknown>) => {
      const runId = String(row.cospec_run_id);
      return (
        (!filters.agentType || row.agent_type === filters.agentType) &&
        (!filters.workflowKind ||
          workflowKinds.get(runId) === filters.workflowKind) &&
        (!filters.agentVersion || row.agent_version === filters.agentVersion) &&
        (!filters.model || modelsByRun.get(runId)?.has(filters.model)) &&
        (!filters.cospecPluginVersion ||
          row.cospec_plugin_version === filters.cospecPluginVersion) &&
        (!filters.employeeId ||
          actors.get(runId)?.employee_id === filters.employeeId) &&
        (!filters.proposerDept ||
          actors.get(runId)?.proposer_dept === filters.proposerDept)
      );
    };
    const dimensionRuns = runRows.filter(matchesDimensions);
    const selected = dimensionRuns.filter((row) => {
      const time = Date.parse(
        String(row.first_event_at ?? row.first_received_at),
      );
      return (
        (!filters.from || time >= Date.parse(filters.from)) &&
        (!filters.to || time <= Date.parse(filters.to))
      );
    });
    const runIds = new Set(selected.map((row) => String(row.cospec_run_id)));
    const selectedMessages = messageRows.filter((row) =>
      runIds.has(String(row.cospec_run_id)),
    );
    const selectedTokens = tokenRows.filter((row) =>
      runIds.has(String(row.cospec_run_id)),
    );
    const selectedTokenFacts = tokenFactRows.filter((row) =>
      runIds.has(String(row.cospec_run_id)),
    );
    const selectedToolCalls = toolCallRows.filter((row) =>
      runIds.has(String(row.cospec_run_id)),
    );
    const selectedToolResults = toolResultRows.filter((row) =>
      runIds.has(String(row.cospec_run_id)),
    );
    const selectedSkillMarkers = effectiveSkillRows.filter((row) =>
      runIds.has(String(row.cospec_run_id)),
    );
    const selectedArtifacts = artifactRows.filter((row) =>
      runIds.has(String(row.cospec_run_id)),
    );
    const selectedTurnEvents = turnEventRows.filter((row) =>
      runIds.has(String(row.cospec_run_id)),
    );
    const selectedCompactions = compactionRows.filter((row) =>
      runIds.has(String(row.cospec_run_id)),
    );

    const byAgent: Record<string, number> = {};
    const byAgentVersion: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    const byCospecPluginVersion: Record<string, number> = {};
    const pluginTerminals = new Map<string, Set<string>>();
    const pluginRunsWithTerminal = new Map<string, number>();
    let runsWithParser = 0;
    const terminalIds = new Set<string>();
    let runsWithTerminalId = 0;
    for (const row of selected) {
      increment(byAgent, String(row.agent_type));
      increment(
        byAgentVersion,
        `${String(row.agent_type)}@${String(row.agent_version)}`,
      );
      increment(
        byDay,
        new Date(
          Date.parse(String(row.first_event_at ?? row.first_received_at)),
        )
          .toISOString()
          .slice(0, 10),
      );
      const pluginVersion =
        typeof row.cospec_plugin_version === "string" &&
        row.cospec_plugin_version
          ? row.cospec_plugin_version
          : "<missing>";
      increment(byCospecPluginVersion, pluginVersion);
      if (row.parser_version !== null) runsWithParser += 1;
      if (
        typeof row.anonymous_terminal_id === "string" &&
        row.anonymous_terminal_id
      ) {
        terminalIds.add(row.anonymous_terminal_id);
        runsWithTerminalId += 1;
        const ids = pluginTerminals.get(pluginVersion) ?? new Set<string>();
        ids.add(row.anonymous_terminal_id);
        pluginTerminals.set(pluginVersion, ids);
        pluginRunsWithTerminal.set(
          pluginVersion,
          (pluginRunsWithTerminal.get(pluginVersion) ?? 0) + 1,
        );
      }
    }
    const messageByRole: Record<string, number> = {};
    const messageRuns = new Set<string>();
    let messageTotal = 0;
    for (const row of selectedMessages) {
      const count = Number(row.count);
      messageTotal += count;
      increment(messageByRole, String(row.role), count);
      messageRuns.add(String(row.cospec_run_id));
    }
    const tokenRuns = new Set<string>();
    const tokenFieldRuns = Object.fromEntries(
      TOKEN_TOTAL_FIELDS.map((field) => [field, new Set<string>()]),
    ) as Record<TokenTotalField, Set<string>>;
    const modelRuns = new Set<string>();
    const tokenTotals = emptyTokenTotals();
    const byModel: Record<string, ReturnType<typeof emptyModelTotals>> = {};
    for (const row of selectedTokens) {
      const runId = String(row.cospec_run_id);
      tokenRuns.add(runId);
      addTokenRow(tokenTotals, row);
      for (const field of TOKEN_TOTAL_FIELDS)
        if (row[field] !== null) tokenFieldRuns[field].add(runId);
      if (row.model !== null) {
        modelRuns.add(runId);
        const model = String(row.model);
        byModel[model] ??= emptyModelTotals();
        addTokenRow(byModel[model], row);
        byModel[model].runs.add(runId);
      }
    }
    const resources = buildRunResources(
      selected,
      selectedMessages,
      selectedTokens,
      selectedToolCalls,
      selectedToolResults,
      modelsByRun,
    );
    const subagentUsage = buildSubagentUsage(
      selected,
      subagentSessionRows.filter((row) =>
        runIds.has(String(row.cospec_run_id)),
      ),
      subagentMessageRows.filter((row) =>
        runIds.has(String(row.cospec_run_id)),
      ),
      subagentTokenRows.filter((row) => runIds.has(String(row.cospec_run_id))),
      selectedMessages,
      selectedTokens,
      selectedToolCalls,
      selectedToolResults,
    );
    const skillSummary = summarizeSkillExecutions(
      selectedSkillMarkers,
      selectedTurnEvents,
      {
        tokenRows: selectedTokenFacts,
        callRows: selectedToolCalls,
        resultRows: selectedToolResults,
        subagentRows: subagentSessionRows.filter((row) =>
          runIds.has(String(row.cospec_run_id)),
        ),
      },
    );
    const skillByDay: Record<string, Record<string, number>> = {};
    for (const row of selectedSkillMarkers.filter(
      (item) => item.phase === "start",
    )) {
      const timestamp = Date.parse(String(row.timestamp));
      if (!Number.isFinite(timestamp)) continue;
      const day = new Date(timestamp).toISOString().slice(0, 10);
      skillByDay[day] ??= {};
      increment(skillByDay[day], String(row.skill));
    }
    (skillSummary as Record<string, unknown>).byDay = skillByDay;
    const runsWithSkills = new Set(
      selectedSkillMarkers
        .filter((row) => row.phase === "start")
        .map((row) => String(row.cospec_run_id)),
    );
    (skillSummary as Record<string, unknown>).unique_people = new Set(
      [...runsWithSkills]
        .map((runId) => actors.get(runId)?.employee_id)
        .filter((id): id is string => Boolean(id)),
    ).size;
    (skillSummary as Record<string, unknown>).unique_runs = runsWithSkills.size;
    for (const [skill, value] of Object.entries(
      (skillSummary.bySkill ?? {}) as Record<string, Record<string, unknown>>,
    )) {
      const skillRuns = new Set(
        selectedSkillMarkers
          .filter((row) => row.phase === "start" && row.skill === skill)
          .map((row) => String(row.cospec_run_id)),
      );
      const employeeIds = new Set(
        [...skillRuns]
          .map((runId) => actors.get(runId)?.employee_id)
          .filter((id): id is string => !!id),
      );
      value.unique_people = employeeIds.size;
      value.identified_runs = [...skillRuns].filter((runId) =>
        actors.has(runId),
      ).length;
      value.unique_runs = skillRuns.size;
      value.artifact_count = selectedArtifacts
        .filter((row) => row.skill === skill && skillRuns.has(String(row.cospec_run_id)))
        .reduce((total, row) => total + Number(row.count), 0);
    }
    return {
      filters: {
        from: filters.from ?? null,
        to: filters.to ?? null,
        workflowKind: filters.workflowKind ?? null,
        agentType: filters.agentType ?? null,
        agentVersion: filters.agentVersion ?? null,
        model: filters.model ?? null,
        cospecPluginVersion: filters.cospecPluginVersion ?? null,
        employeeId: filters.employeeId ?? null,
        proposerDept: filters.proposerDept ?? null,
      },
      timeSemantics: "first_jsonl_event_fallback_first_received",
      runs: {
        total: selected.length,
        with_parser_facts: runsWithParser,
        without_parser_facts: selected.length - runsWithParser,
        byAgent,
        byAgentVersion,
        byCospecPluginVersion,
        byDay,
      },
      terminals: {
        active_anonymous_terminals: terminalIds.size,
        runs_with_terminal_id: runsWithTerminalId,
        runs_missing_terminal_id: selected.length - runsWithTerminalId,
        run_coverage:
          selected.length === 0 ? null : runsWithTerminalId / selected.length,
        engagement: buildTerminalEngagement(
          selected,
          dimensionRuns,
          filters.from,
        ),
      },
      cospecPluginVersions: {
        byVersion: Object.fromEntries(
          Object.entries(byCospecPluginVersion).map(([version, runs]) => {
            const withTerminal = pluginRunsWithTerminal.get(version) ?? 0;
            return [
              version,
              {
                runs,
                active_anonymous_terminals:
                  pluginTerminals.get(version)?.size ?? 0,
                runs_with_terminal_id: withTerminal,
                runs_missing_terminal_id: runs - withTerminal,
              },
            ];
          }),
        ),
      },
      messages: coverageSummary(selected.length, messageRuns.size, {
        total: messageTotal,
        byRole: messageByRole,
        average_per_observed_run: messageRuns.size
          ? messageTotal / messageRuns.size
          : null,
      }),
      tokens: coverageSummary(selected.length, tokenRuns.size, {
        ...tokenTotals,
        average_input_per_observed_run: average(
          tokenTotals.input_tokens,
          tokenFieldRuns.input_tokens.size,
        ),
        average_output_per_observed_run: average(
          tokenTotals.output_tokens,
          tokenFieldRuns.output_tokens.size,
        ),
        field_run_coverage: Object.fromEntries(
          TOKEN_TOTAL_FIELDS.map((field) => [
            field,
            coverageCounts(selected.length, tokenFieldRuns[field].size),
          ]),
        ),
      }),
      models: coverageSummary(selected.length, modelRuns.size, {
        byModel: Object.fromEntries(
          Object.entries(byModel).map(([model, totals]) => [
            model,
            { ...totals, runs: totals.runs.size },
          ]),
        ),
      }),
      skills: skillSummary,
      activity: buildRunActivity(selected, selectedSkillMarkers),
      versionPerformance: buildVersionPerformance(selected, {
        skillMarkers: selectedSkillMarkers,
        turnEvents: selectedTurnEvents,
        tokenRows: selectedTokenFacts,
        callRows: selectedToolCalls,
        resultRows: selectedToolResults,
        subagentRows: subagentSessionRows.filter((row) =>
          runIds.has(String(row.cospec_run_id)),
        ),
        compactionRows: selectedCompactions,
      }),
      resourceDistribution: resources,
      subagents: subagentUsage,
    };
  }

  async orphanRawFiles(): Promise<string[]> {
    const registered = new Set(
      this.database
        .prepare("SELECT raw_path FROM chunks")
        .all()
        .map((row) => String(row.raw_path)),
    );
    const rawRoot = join(this.root, "raw");
    const files = await readdir(rawRoot, {
      recursive: true,
      withFileTypes: true,
    });
    return files
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => relative(this.root, join(entry.parentPath, entry.name)))
      .filter((path) => !registered.has(path));
  }

  private async acceptOne(
    metadata: ChunkMetadata,
    bytes: Buffer,
  ): Promise<AcceptedResult> {
    const key = streamKey(metadata);
    const fingerprint = `${key}:${metadata.file.start_offset}:${metadata.file.end_offset}:${metadata.file.sha256}`;
    const byUpload = this.database
      .prepare(
        "SELECT fingerprint, end_offset, '' AS sha256 FROM upload_ids WHERE upload_id=?",
      )
      .get(metadata.upload_id) as ChunkRow | undefined;
    if (byUpload) {
      if (byUpload.fingerprint !== fingerprint)
        throw new RepositoryConflict("upload_id_conflict");
      return { status: "already_accepted", nextOffset: byUpload.end_offset };
    }
    const byRange = this.database
      .prepare(
        "SELECT fingerprint, end_offset, sha256 FROM chunks WHERE stream_key=? AND start_offset=? AND end_offset=?",
      )
      .get(key, metadata.file.start_offset, metadata.file.end_offset) as
      ChunkRow | undefined;
    if (byRange) {
      if (byRange.sha256 !== metadata.file.sha256)
        throw new RepositoryConflict("offset_conflict");
      this.database
        .prepare(
          "INSERT INTO upload_ids(upload_id,fingerprint,end_offset) VALUES(?,?,?)",
        )
        .run(metadata.upload_id, fingerprint, metadata.file.end_offset);
      return { status: "already_accepted", nextOffset: byRange.end_offset };
    }
    const stream = this.database
      .prepare(
        "SELECT next_offset, previous_hash FROM streams WHERE stream_key=?",
      )
      .get(key) as StreamRow | undefined;
    if (!stream) {
      if (metadata.file.previous_chunk_sha256 !== null)
        throw new RepositoryConflict("previous_hash_mismatch");
    } else {
      if (metadata.file.start_offset < stream.next_offset)
        throw new RepositoryConflict("offset_conflict");
      if (metadata.file.start_offset > stream.next_offset)
        throw new RepositoryConflict("offset_gap");
      if (metadata.file.previous_chunk_sha256 !== stream.previous_hash)
        throw new RepositoryConflict("previous_hash_mismatch");
    }

    const rawPath = rawRelativePath(metadata);
    await writeImmutable(join(this.root, rawPath), bytes, metadata.file.sha256);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO chunks
        (upload_id,fingerprint,stream_key,cospec_run_id,start_offset,end_offset,sha256,raw_path,metadata_json,received_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          metadata.upload_id,
          fingerprint,
          key,
          metadata.cospec_run_id,
          metadata.file.start_offset,
          metadata.file.end_offset,
          metadata.file.sha256,
          rawPath,
          JSON.stringify(metadata),
          new Date().toISOString(),
        );
      this.database
        .prepare(
          "INSERT INTO upload_ids(upload_id,fingerprint,end_offset) VALUES(?,?,?)",
        )
        .run(metadata.upload_id, fingerprint, metadata.file.end_offset);
      this.database
        .prepare(
          `INSERT INTO streams(stream_key,next_offset,previous_hash) VALUES(?,?,?)
        ON CONFLICT(stream_key) DO UPDATE SET next_offset=excluded.next_offset, previous_hash=excluded.previous_hash`,
        )
        .run(key, metadata.file.end_offset, metadata.file.sha256);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { status: "accepted", nextOffset: metadata.file.end_offset };
  }
}

async function writeImmutable(
  path: string,
  bytes: Buffer,
  expectedHash: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = await readFile(path);
    if (createHash("sha256").update(existing).digest("hex") !== expectedHash)
      throw new RepositoryConflict("raw_path_conflict");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EISDIR", "EINVAL"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return;
    throw error;
  }
}

function rawRelativePath(metadata: ChunkMetadata): string {
  return join(
    "raw",
    metadata.cospec_run_id,
    metadata.file.source_file_id,
    String(metadata.file.generation),
    `${metadata.file.start_offset}-${metadata.file.end_offset}-${metadata.file.sha256}.jsonl`,
  );
}

function streamKey(metadata: ChunkMetadata): string {
  return `${metadata.cospec_run_id}:${metadata.file.source_file_id}:${metadata.file.generation}`;
}

function artifactKey(metadata: ArtifactMetadata): string {
  return `${metadata.cospec_run_id}:${metadata.skill}:${metadata.attempt_id}:${metadata.artifact_index}:${metadata.sha256}`;
}

function runSummarySql(): string {
  return `SELECT c.cospec_run_id,
    COALESCE(MIN(CASE WHEN json_extract(c.metadata_json,'$.session.role')='main' OR json_extract(c.metadata_json,'$.session.role') IS NULL
      THEN json_extract(c.metadata_json,'$.agent_session_id') END),MIN(json_extract(c.metadata_json,'$.agent_session_id'))) AS agent_session_id,
    COALESCE(MIN(CASE WHEN json_extract(c.metadata_json,'$.session.role')='main' OR json_extract(c.metadata_json,'$.session.role') IS NULL
      THEN json_extract(c.metadata_json,'$.source_type') END),MIN(json_extract(c.metadata_json,'$.source_type'))) AS source_type,
    COALESCE(MIN(CASE WHEN json_extract(c.metadata_json,'$.session.role')='main' OR json_extract(c.metadata_json,'$.session.role') IS NULL
      THEN json_extract(c.metadata_json,'$.source_version') END),MIN(json_extract(c.metadata_json,'$.source_version'))) AS source_version,
    COALESCE(MIN(CASE WHEN json_extract(c.metadata_json,'$.session.role')='main' OR json_extract(c.metadata_json,'$.session.role') IS NULL
      THEN json_extract(c.metadata_json,'$.environment.agent_type') END),MIN(json_extract(c.metadata_json,'$.environment.agent_type'))) AS agent_type,
    COALESCE(MIN(CASE WHEN json_extract(c.metadata_json,'$.session.role')='main' OR json_extract(c.metadata_json,'$.session.role') IS NULL THEN json_extract(c.metadata_json,'$.environment.agent_version') END),MIN(json_extract(c.metadata_json,'$.environment.agent_version'))) AS agent_version,
    COALESCE(MIN(CASE WHEN json_extract(c.metadata_json,'$.session.role')='main' OR json_extract(c.metadata_json,'$.session.role') IS NULL THEN json_extract(c.metadata_json,'$.environment.cospec_plugin_version') END),MIN(json_extract(c.metadata_json,'$.environment.cospec_plugin_version'))) AS cospec_plugin_version,
    COALESCE(MIN(CASE WHEN json_extract(c.metadata_json,'$.session.role')='main' OR json_extract(c.metadata_json,'$.session.role') IS NULL THEN json_extract(c.metadata_json,'$.environment.anonymous_terminal_id') END),MIN(json_extract(c.metadata_json,'$.environment.anonymous_terminal_id'))) AS anonymous_terminal_id,
    COUNT(*) AS chunk_count,SUM(c.end_offset-c.start_offset) AS byte_count,
    MIN(c.start_offset) AS start_offset,MAX(c.end_offset) AS end_offset,
    MIN(c.received_at) AS first_received_at,MAX(c.received_at) AS last_received_at,
    a.parser_version AS active_parser_version
    FROM chunks c LEFT JOIN active_parser_versions a ON a.cospec_run_id=c.cospec_run_id
    GROUP BY c.cospec_run_id`;
}

function toRunListItem(row: Record<string, unknown>): RunListItem {
  return {
    runId: String(row.cospec_run_id),
    agentSessionId: String(row.agent_session_id),
    sourceType: String(row.source_type),
    sourceVersion: String(row.source_version),
    agentType: String(row.agent_type),
    agentVersion: String(row.agent_version),
    cospecPluginVersion: String(row.cospec_plugin_version),
    chunkCount: Number(row.chunk_count),
    byteCount: Number(row.byte_count),
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    activeParserVersion:
      row.active_parser_version === null
        ? null
        : String(row.active_parser_version),
    firstReceivedAt: String(row.first_received_at),
    lastReceivedAt: String(row.last_received_at),
    workflowKind: null,
    workflowName: null,
    workflowStatus: "running",
    employeeId: null,
    displayName: null,
    proposerDept: null,
    identityResolution: "unknown",
    skills: [],
    artifactCount: 0,
    toolFailureCount: 0,
  };
}

type EffectiveIdentityInput = {
  runId: string;
  terminalId: string | null;
  occurredAt: string;
  actor?: {
    employeeId: string;
    displayName: string;
    proposerDept: string | undefined;
  };
};
type EffectiveIdentity = {
  employeeId: string;
  displayName: string;
  proposerDept: string | null;
  resolution: "snapshot" | "person_backfill" | "terminal_backfill";
};

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function resolveEffectiveIdentities(
  inputs: EffectiveIdentityInput[],
): Map<string, EffectiveIdentity> {
  const ordered = [...inputs].sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
  );
  const people = new Map<
    string,
    { displayName: string; proposerDept: string | null }
  >();
  const terminals = new Map<
    string,
    Map<string, { displayName: string; proposerDept: string | null }>
  >();
  for (const input of ordered)
    if (input.actor) {
      const prior = people.get(input.actor.employeeId);
      people.set(input.actor.employeeId, {
        displayName:
          input.actor.displayName ||
          prior?.displayName ||
          input.actor.employeeId,
        proposerDept: input.actor.proposerDept ?? prior?.proposerDept ?? null,
      });
      if (input.terminalId) {
        const owners = terminals.get(input.terminalId) ?? new Map();
        const old = owners.get(input.actor.employeeId);
        owners.set(input.actor.employeeId, {
          displayName:
            input.actor.displayName ||
            old?.displayName ||
            input.actor.employeeId,
          proposerDept: input.actor.proposerDept ?? old?.proposerDept ?? null,
        });
        terminals.set(input.terminalId, owners);
      }
    }
  const result = new Map<string, EffectiveIdentity>();
  for (const input of inputs) {
    if (input.actor) {
      const person = people.get(input.actor.employeeId);
      result.set(input.runId, {
        employeeId: input.actor.employeeId,
        displayName: input.actor.displayName,
        proposerDept: input.actor.proposerDept ?? person?.proposerDept ?? null,
        resolution: input.actor.proposerDept ? "snapshot" : "person_backfill",
      });
      continue;
    }
    const owners = input.terminalId
      ? terminals.get(input.terminalId)
      : undefined;
    if (owners?.size === 1) {
      const [employeeId, person] = [...owners][0]!;
      result.set(input.runId, {
        employeeId,
        displayName: person.displayName,
        proposerDept:
          people.get(employeeId)?.proposerDept ?? person.proposerDept,
        resolution: "terminal_backfill",
      });
    }
  }
  return result;
}

function numericObject(
  row: Record<string, unknown>,
): Record<string, number | null> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value === null ? null : Number(value),
    ]),
  );
}

function toolStatusMetrics(
  counts: Record<string, number | null>,
): Record<string, number | null> {
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

interface SkillExecution {
  runId: string;
  skill: string;
  executionId: string;
  status: "ok" | "failed" | "interrupted" | "open" | "orphan" | "invalid";
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  elapsedMs: number | null;
  waitingForUserMs: number | null;
  waitingForUserCount: number | null;
  waitingIntervalsMs: number[];
  resources?: { inclusive: SkillResourceSummary; self: SkillResourceSummary };
}

function structuredSkillStatus(status: RunEvent["status"]): "ok" | "failed" | "interrupted" | "orphan" {
  if (status === "completed") return "ok";
  if (status === "failed" || status === "interrupted" || status === "orphan") return status;
  return "interrupted";
}

function preferStructuredSkillRows(
  markerRows: Array<Record<string, unknown>>,
  structuredRows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const structuredPhases = new Set(structuredRows.map((row) =>
    `${String(row.cospec_run_id ?? "")}\0${String(row.skill)}\0${String(row.execution_id)}\0${String(row.phase)}`));
  return [...markerRows.filter((row) => !structuredPhases.has(
    `${String(row.cospec_run_id ?? "")}\0${String(row.skill)}\0${String(row.execution_id)}\0${String(row.phase)}`)), ...structuredRows]
    .sort((left, right) => (Date.parse(String(left.timestamp)) || 0) - (Date.parse(String(right.timestamp)) || 0));
}

interface SkillResourceFacts {
  tokenRows: Array<Record<string, unknown>>;
  callRows: Array<Record<string, unknown>>;
  resultRows: Array<Record<string, unknown>>;
  subagentRows: Array<Record<string, unknown>>;
}

interface SkillResourceSummary {
  tokens: TokenTotals & { observations: number };
  tools: {
    calls: number;
    successes: number;
    failures: number;
    unknown_results: number;
    status_coverage: number | null;
    accumulated_ms: number;
    measured_calls: number;
  };
  subagents: number;
}

function summarizeSkillExecutions(
  rows: Array<Record<string, unknown>>,
  turnRows: Array<Record<string, unknown>>,
  resourceFacts?: SkillResourceFacts,
): Record<string, unknown> {
  const waitsByRun = buildUserWaitIntervals(turnRows);
  const starts = new Map<string, Record<string, unknown>>();
  const executions: SkillExecution[] = [];
  for (const row of rows) {
    const key = `${String(row.cospec_run_id ?? "")}\0${String(row.skill)}\0${String(row.execution_id)}`;
    if (row.phase === "start") {
      if (!starts.has(key)) starts.set(key, row);
      continue;
    }
    const start = starts.get(key);
    if (!start || row.status === "orphan") {
      executions.push({
        runId: String(row.cospec_run_id ?? ""),
        skill: String(row.skill),
        executionId: String(row.execution_id),
        status: "orphan",
        startedAt: null,
        endedAt: typeof row.timestamp === "string" ? row.timestamp : null,
        durationMs: null,
        elapsedMs: null,
        waitingForUserMs: null,
        waitingForUserCount: null,
        waitingIntervalsMs: [],
      });
      continue;
    }
    starts.delete(key);
    const startMs = timestampMs(start.timestamp);
    const endMs = timestampMs(row.timestamp);
    const elapsedMs =
      startMs !== null && endMs !== null && endMs >= startMs
        ? endMs - startMs
        : null;
    const runId = String(row.cospec_run_id ?? "");
    const waitingIntervalsMs =
      elapsedMs === null
        ? []
        : overlapDurations(startMs!, endMs!, waitsByRun.get(runId) ?? []);
    const waitingForUserMs =
      elapsedMs === null
        ? null
        : waitingIntervalsMs.reduce((sum, value) => sum + value, 0);
    const durationMs =
      elapsedMs === null ? null : elapsedMs - waitingForUserMs!;
    executions.push({
      runId,
      skill: String(row.skill),
      executionId: String(row.execution_id),
      status:
        elapsedMs === null && startMs !== null && endMs !== null
          ? "invalid"
          : (String(row.status) as SkillExecution["status"]),
      startedAt: typeof start.timestamp === "string" ? start.timestamp : null,
      endedAt: typeof row.timestamp === "string" ? row.timestamp : null,
      durationMs,
      elapsedMs,
      waitingForUserMs,
      waitingForUserCount:
        elapsedMs === null ? null : waitingIntervalsMs.length,
      waitingIntervalsMs,
    });
  }
  for (const start of starts.values())
    executions.push({
      runId: String(start.cospec_run_id ?? ""),
      skill: String(start.skill),
      executionId: String(start.execution_id),
      status: "open",
      startedAt: typeof start.timestamp === "string" ? start.timestamp : null,
      endedAt: null,
      durationMs: null,
      elapsedMs: null,
      waitingForUserMs: null,
      waitingForUserCount: null,
      waitingIntervalsMs: [],
    });
  executions.sort(
    (left, right) =>
      (Date.parse(left.startedAt ?? left.endedAt ?? "") || 0) -
      (Date.parse(right.startedAt ?? right.endedAt ?? "") || 0),
  );
  const resourceCoverage = resourceFacts
    ? attributeSkillResources(executions, resourceFacts)
    : null;
  const summarize = (items: SkillExecution[]) => {
    const durations = items
      .flatMap((item) => (item.durationMs === null ? [] : [item.durationMs]))
      .sort((a, b) => a - b);
    const elapsed = items
      .flatMap((item) => (item.elapsedMs === null ? [] : [item.elapsedMs]))
      .sort((a, b) => a - b);
    const waits = items
      .flatMap((item) =>
        item.waitingForUserMs === null ? [] : [item.waitingForUserMs],
      )
      .sort((a, b) => a - b);
    const waitIntervals = items
      .flatMap((item) => item.waitingIntervalsMs)
      .sort((a, b) => a - b);
    const measuredItems = items.filter((item) => item.elapsedMs !== null);
    const result: Record<string, unknown> = {
      executions: items.length,
      completed: items.filter((item) => item.status === "ok").length,
      failed: items.filter((item) => item.status === "failed").length,
      interrupted: items.filter((item) => item.status === "interrupted").length,
      open: items.filter((item) => item.status === "open").length,
      orphan_ends: items.filter((item) => item.status === "orphan").length,
      invalid_intervals: items.filter((item) => item.status === "invalid")
        .length,
      measured_executions: durations.length,
      duration_coverage:
        items.length === 0 ? null : durations.length / items.length,
      accumulated_ms: durations.reduce((sum, value) => sum + value, 0),
      p50_ms: percentile(durations, 0.5),
      p90_ms: percentile(durations, 0.9),
      elapsed_accumulated_ms: elapsed.reduce((sum, value) => sum + value, 0),
      waiting_for_user_accumulated_ms: waits.reduce(
        (sum, value) => sum + value,
        0,
      ),
      waiting_for_user_interactions: waitIntervals.length,
      waiting_for_user_p50_ms: percentile(waitIntervals, 0.5),
      waiting_for_user_p90_ms: percentile(waitIntervals, 0.9),
      executions_without_user_wait: measuredItems.filter(
        (item) => item.waitingIntervalsMs.length === 0,
      ).length,
      no_user_wait_rate: measuredItems.length
        ? measuredItems.filter((item) => item.waitingIntervalsMs.length === 0)
            .length / measuredItems.length
        : null,
      waiting_share_of_elapsed:
        elapsed.reduce((sum, value) => sum + value, 0) > 0
          ? waits.reduce((sum, value) => sum + value, 0) /
            elapsed.reduce((sum, value) => sum + value, 0)
          : null,
      elapsed_p50_ms: percentile(elapsed, 0.5),
      elapsed_p90_ms: percentile(elapsed, 0.9),
    };
    if (resourceFacts)
      result.resources = mergeSkillResources(
        items.map((item) => item.resources?.self),
      );
    return result;
  };
  const grouped = new Map<string, SkillExecution[]>();
  for (const execution of executions) {
    const values = grouped.get(execution.skill) ?? [];
    values.push(execution);
    grouped.set(execution.skill, values);
  }
  return {
    ...summarize(executions),
    semantics: "skill_event_interval_excluding_user_wait",
    resourceAttribution: resourceCoverage,
    bySkill: Object.fromEntries(
      [...grouped]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([skill, items]) => [skill, summarize(items)]),
    ),
    items: executions.map(
      ({ runId: _runId, waitingIntervalsMs: _waitingIntervalsMs, ...item }) =>
        item,
    ),
  };
}

function attributeSkillResources(
  executions: SkillExecution[],
  facts: SkillResourceFacts,
): Record<string, unknown> {
  const complete = executions.filter(
    (item) => item.startedAt && item.endedAt && item.elapsedMs !== null,
  );
  const inclusive = new Map<SkillExecution, SkillResourceFacts>();
  const self = new Map<SkillExecution, SkillResourceFacts>();
  const empty = (): SkillResourceFacts => ({
    tokenRows: [],
    callRows: [],
    resultRows: [],
    subagentRows: [],
  });
  for (const execution of complete) {
    inclusive.set(execution, empty());
    self.set(execution, empty());
  }
  const containing = (row: Record<string, unknown>) => {
    const at = timestampMs(row.timestamp ?? row.first_event_at);
    if (at === null) return [];
    return complete.filter(
      (item) =>
        item.runId === String(row.cospec_run_id ?? "") &&
        at >= Date.parse(item.startedAt!) &&
        at <= Date.parse(item.endedAt!),
    );
  };
  const assign = (
    rows: Array<Record<string, unknown>>,
    field: keyof SkillResourceFacts,
  ) => {
    for (const row of rows) {
      const matches = containing(row);
      for (const execution of matches)
        inclusive.get(execution)![field].push(row);
      const deepest = matches.sort(
        (a, b) => Number(a.elapsedMs) - Number(b.elapsedMs),
      )[0];
      if (deepest) self.get(deepest)![field].push(row);
    }
  };
  assign(facts.tokenRows, "tokenRows");
  assign(facts.callRows, "callRows");
  assign(facts.resultRows, "resultRows");
  assign(facts.subagentRows, "subagentRows");
  for (const execution of complete)
    execution.resources = {
      inclusive: summarizeSkillResources(inclusive.get(execution)!),
      self: summarizeSkillResources(self.get(execution)!),
    };
  const totalFacts =
    facts.tokenRows.length + facts.callRows.length + facts.subagentRows.length;
  const timestampedFacts = [
    ...facts.tokenRows,
    ...facts.callRows,
    ...facts.subagentRows,
  ].filter(
    (row) => timestampMs(row.timestamp ?? row.first_event_at) !== null,
  ).length;
  const attributedFacts = [
    ...facts.tokenRows,
    ...facts.callRows,
    ...facts.subagentRows,
  ].filter((row) => containing(row).length > 0).length;
  return {
    semantics: "complete_skill_intervals_inclusive_and_innermost_self",
    total_facts: totalFacts,
    timestamped_facts: timestampedFacts,
    attributed_facts: attributedFacts,
    attribution_coverage: timestampedFacts
      ? attributedFacts / timestampedFacts
      : null,
  };
}

function summarizeSkillResources(
  facts: SkillResourceFacts,
): SkillResourceSummary {
  const tokens = emptyTokenTotals();
  for (const row of facts.tokenRows) {
    tokens.observations += 1;
    TOKEN_TOTAL_FIELDS.forEach((field, index) => {
      if (row[field] !== null && row[field] !== undefined) {
        tokens[field] = (tokens[field] ?? 0) + Number(row[field]);
        tokens[TOKEN_SAMPLE_FIELDS[index]!] += 1;
      }
    });
  }
  const results = new Map(
    facts.resultRows.map((row) => [
      `${String(row.agent_session_id ?? "")}:${String(row.call_id)}`,
      String(row.status),
    ]),
  );
  let successes = 0;
  let failures = 0;
  let unknown = 0;
  const durations: number[] = [];
  const resultTimes = new Map(
    facts.resultRows.map((row) => [
      `${String(row.agent_session_id ?? "")}:${String(row.call_id)}`,
      timestampMs(row.timestamp),
    ]),
  );
  for (const call of facts.callRows) {
    const key = `${String(call.agent_session_id ?? "")}:${String(call.call_id)}`;
    const status = results.get(key);
    if (status === "success") successes += 1;
    else if (status === "failure") failures += 1;
    else unknown += 1;
    const start = timestampMs(call.timestamp);
    const end = resultTimes.get(key);
    if (start !== null && end !== undefined && end !== null && end >= start)
      durations.push(end - start);
  }
  return {
    tokens,
    tools: {
      calls: facts.callRows.length,
      successes,
      failures,
      unknown_results: unknown,
      status_coverage: facts.callRows.length
        ? (successes + failures) / facts.callRows.length
        : null,
      accumulated_ms: durations.reduce((sum, value) => sum + value, 0),
      measured_calls: durations.length,
    },
    subagents: new Set(
      facts.subagentRows.map((row) => String(row.agent_session_id)),
    ).size,
  };
}

function mergeSkillResources(
  values: Array<SkillResourceSummary | undefined>,
): SkillResourceSummary {
  const present = values.filter((value): value is SkillResourceSummary =>
    Boolean(value),
  );
  const token = emptyTokenTotals();
  for (const value of present)
    for (const field of TOKEN_TOTAL_FIELDS) {
      const amount = value.tokens[field];
      if (amount !== null) token[field] = (token[field] ?? 0) + amount;
    }
  const tools = present.reduce(
    (total, value) => ({
      calls: total.calls + value.tools.calls,
      successes: total.successes + value.tools.successes,
      failures: total.failures + value.tools.failures,
      unknown_results: total.unknown_results + value.tools.unknown_results,
      accumulated_ms: total.accumulated_ms + value.tools.accumulated_ms,
      measured_calls: total.measured_calls + value.tools.measured_calls,
    }),
    {
      calls: 0,
      successes: 0,
      failures: 0,
      unknown_results: 0,
      accumulated_ms: 0,
      measured_calls: 0,
    },
  );
  return {
    tokens: {
      ...token,
      observations: present.reduce(
        (sum, value) => sum + value.tokens.observations,
        0,
      ),
    },
    tools: {
      ...tools,
      status_coverage: tools.calls
        ? (tools.successes + tools.failures) / tools.calls
        : null,
    },
    subagents: present.reduce((sum, value) => sum + value.subagents, 0),
  };
}

function buildUserWaitIntervals(
  rows: Array<Record<string, unknown>>,
): Map<string, ToolInterval[]> {
  const result = new Map<string, ToolInterval[]>();
  const lastAgent = new Map<string, number>();
  for (const row of rows) {
    const runId = String(row.cospec_run_id ?? "");
    const at = timestampMs(row.timestamp);
    if (at === null) continue;
    if (row.kind === "agent_message") {
      lastAgent.set(runId, at);
    } else if (row.kind === "user_prompt") {
      const start = lastAgent.get(runId);
      if (start !== undefined && at >= start) {
        const values = result.get(runId) ?? [];
        values.push({ start, end: at });
        result.set(runId, values);
      }
      lastAgent.delete(runId);
    }
  }
  return result;
}

function overlapDurations(
  start: number,
  end: number,
  intervals: ToolInterval[],
): number[] {
  return intervals.flatMap((interval) => {
    const overlapStart = Math.max(start, interval.start);
    const overlapEnd = Math.min(end, interval.end);
    return overlapEnd > overlapStart ? [overlapEnd - overlapStart] : [];
  });
}

function buildTerminalEngagement(
  selected: Array<Record<string, unknown>>,
  history: Array<Record<string, unknown>>,
  from?: string,
): Record<string, unknown> {
  const selectedWithId = selected.filter(
    (row) =>
      typeof row.anonymous_terminal_id === "string" &&
      row.anonymous_terminal_id,
  );
  const runsByTerminal = groupRowsBy(selectedWithId, "anonymous_terminal_id");
  const activeTerminals = runsByTerminal.size;
  let oneRun = 0;
  let twoToThreeRuns = 0;
  let fourOrMoreRuns = 0;
  const activeDays: number[] = [];
  for (const rows of runsByTerminal.values()) {
    if (rows.length === 1) oneRun += 1;
    else if (rows.length <= 3) twoToThreeRuns += 1;
    else fourOrMoreRuns += 1;
    activeDays.push(
      new Set(
        rows.map((row) => new Date(runTime(row)).toISOString().slice(0, 10)),
      ).size,
    );
  }
  const periodStart = from ? Date.parse(from) : null;
  const historyByTerminal = groupRowsBy(
    history.filter(
      (row) =>
        typeof row.anonymous_terminal_id === "string" &&
        row.anonymous_terminal_id,
    ),
    "anonymous_terminal_id",
  );
  let returning = 0;
  let firstObserved = 0;
  if (periodStart !== null && Number.isFinite(periodStart)) {
    for (const terminalId of runsByTerminal.keys()) {
      const prior = (historyByTerminal.get(terminalId) ?? []).some(
        (row) => runTime(row) < periodStart,
      );
      if (prior) returning += 1;
      else firstObserved += 1;
    }
  }
  return {
    eligible_runs: selectedWithId.length,
    runs_per_active_terminal: activeTerminals
      ? selectedWithId.length / activeTerminals
      : null,
    terminals_by_run_frequency: {
      one_run: oneRun,
      two_to_three_runs: twoToThreeRuns,
      four_or_more_runs: fourOrMoreRuns,
    },
    active_days_per_terminal: metricDistribution(activeDays),
    returning_terminals:
      periodStart === null || !Number.isFinite(periodStart) ? null : returning,
    first_observed_terminals:
      periodStart === null || !Number.isFinite(periodStart)
        ? null
        : firstObserved,
    returning_rate:
      periodStart === null ||
      !Number.isFinite(periodStart) ||
      activeTerminals === 0
        ? null
        : returning / activeTerminals,
    semantics: "anonymous_terminal_observation_not_user_identity",
  };
}

function runTime(row: Record<string, unknown>): number {
  return Date.parse(String(row.first_event_at ?? row.first_received_at));
}

function buildRunActivity(
  runs: Array<Record<string, unknown>>,
  markerRows: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const generatedAt = new Date();
  const markersByRun = groupRowsBy(markerRows, "cospec_run_id");
  const items = runs.map((run) => {
    const runId = String(run.cospec_run_id);
    const lastActivityAt = String(
      run.last_event_at ?? run.first_event_at ?? run.first_received_at,
    );
    const lastMs = Date.parse(lastActivityAt);
    const idleMs = Number.isFinite(lastMs)
      ? Math.max(0, generatedAt.getTime() - lastMs)
      : null;
    const markers = (markersByRun.get(runId) ?? [])
      .filter((row) => timestampMs(row.timestamp) !== null)
      .sort((a, b) => timestampMs(b.timestamp)! - timestampMs(a.timestamp)!);
    return {
      runId,
      lastActivityAt,
      idleMs,
      latestSkill: markers[0]?.skill ?? null,
      latestSkillPhase: markers[0]?.phase ?? null,
    };
  });
  const inactive24 = items.filter(
    (item) => item.idleMs !== null && item.idleMs >= 24 * 60 * 60 * 1000,
  );
  const inactive48 = items.filter(
    (item) => item.idleMs !== null && item.idleMs >= 48 * 60 * 60 * 1000,
  );
  return {
    generated_at: generatedAt.toISOString(),
    runs_with_activity_time: items.filter((item) => item.idleMs !== null)
      .length,
    inactive_24h: inactive24.length,
    inactive_48h: inactive48.length,
    items: inactive24
      .sort((a, b) => Number(b.idleMs) - Number(a.idleMs))
      .slice(0, 20),
    semantics: "no_jsonl_activity_not_business_failure",
  };
}

interface VersionFacts extends SkillResourceFacts {
  skillMarkers: Array<Record<string, unknown>>;
  turnEvents: Array<Record<string, unknown>>;
  compactionRows: Array<Record<string, unknown>>;
}

function buildVersionPerformance(
  runs: Array<Record<string, unknown>>,
  facts: VersionFacts,
): Record<string, unknown> {
  const build = (keyOf: (run: Record<string, unknown>) => string) => {
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const run of runs) {
      const key = keyOf(run);
      const values = groups.get(key) ?? [];
      values.push(run);
      groups.set(key, values);
    }
    return Object.fromEntries(
      [...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, values]) => {
          const ids = new Set(values.map((row) => String(row.cospec_run_id)));
          const select = (rows: Array<Record<string, unknown>>) =>
            rows.filter((row) => ids.has(String(row.cospec_run_id)));
          const tokens = emptyTokenTotals();
          for (const row of select(facts.tokenRows)) {
            tokens.observations += 1;
            TOKEN_TOTAL_FIELDS.forEach((field, index) => {
              if (row[field] !== null && row[field] !== undefined) {
                tokens[field] = (tokens[field] ?? 0) + Number(row[field]);
                tokens[TOKEN_SAMPLE_FIELDS[index]!] += 1;
              }
            });
          }
          const calls = select(facts.callRows);
          const results = select(facts.resultRows);
          const failures = results.filter(
            (row) => row.status === "failure",
          ).length;
          const determined = results.filter(
            (row) => row.status === "failure" || row.status === "success",
          ).length;
          const skill = summarizeSkillExecutions(
            select(facts.skillMarkers),
            select(facts.turnEvents),
            {
              tokenRows: select(facts.tokenRows),
              callRows: calls,
              resultRows: results,
              subagentRows: select(facts.subagentRows),
            },
          );
          const skillRecord = skill as Record<string, any>;
          return [
            key,
            {
              sample_runs: values.length,
              active_anonymous_terminals: new Set(
                values.flatMap((row) =>
                  typeof row.anonymous_terminal_id === "string" &&
                  row.anonymous_terminal_id
                    ? [row.anonymous_terminal_id]
                    : [],
                ),
              ).size,
              skills: {
                executions: skillRecord.executions,
                measured_executions: skillRecord.measured_executions,
                active_accumulated_ms: skillRecord.accumulated_ms,
                active_p50_ms: skillRecord.p50_ms,
                waiting_for_user_accumulated_ms:
                  skillRecord.waiting_for_user_accumulated_ms,
                waiting_for_user_interactions:
                  skillRecord.waiting_for_user_interactions,
                bySkill: skillRecord.bySkill,
              },
              tokens,
              tools: {
                calls: calls.length,
                explicit_failures: failures,
                status_coverage: calls.length
                  ? determined / calls.length
                  : null,
              },
              subagents: {
                sessions: select(facts.subagentRows).length,
                runs_with_subagents: new Set(
                  select(facts.subagentRows).map((row) =>
                    String(row.cospec_run_id),
                  ),
                ).size,
              },
              context_compactions: select(facts.compactionRows).length,
            },
          ];
        }),
    );
  };
  return {
    byCospecPluginVersion: build((run) =>
      typeof run.cospec_plugin_version === "string" && run.cospec_plugin_version
        ? run.cospec_plugin_version
        : "<missing>",
    ),
    byAgentVersion: build(
      (run) => `${String(run.agent_type)}@${String(run.agent_version)}`,
    ),
    note: "observational_comparison_show_sample_size_no_causal_claim",
  };
}

interface ToolInterval {
  start: number;
  end: number;
}

function calculateToolDurations(
  callRows: Array<Record<string, unknown>>,
  resultRows: Array<Record<string, unknown>>,
): {
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
      all.unknown += 1;
      tool.unknown += 1;
      continue;
    }
    const end = candidates.find((candidate) => candidate >= start);
    if (end === undefined) {
      all.invalid += 1;
      tool.invalid += 1;
      continue;
    }
    all.intervals.push({ start, end });
    tool.intervals.push({ start, end });
  }
  return {
    overall: summarizeDurations(callRows.length, all),
    byTool: Object.fromEntries(
      [...byTool].map(([name, value]) => [
        name,
        summarizeDurations(
          callRows.filter((row) => String(row.tool_name) === name).length,
          value,
        ),
      ]),
    ),
  };
}

function durationAccumulator(): {
  intervals: ToolInterval[];
  unknown: number;
  invalid: number;
} {
  return { intervals: [], unknown: 0, invalid: 0 };
}

function summarizeDurations(
  total: number,
  value: ReturnType<typeof durationAccumulator>,
): Record<string, number | string | null> {
  const durations = value.intervals
    .map(({ start, end }) => end - start)
    .sort((a, b) => a - b);
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
  const sorted = [...intervals].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  let total = 0;
  let current: ToolInterval | null = null;
  for (const interval of sorted) {
    if (!current) current = { ...interval };
    else if (interval.start <= current.end)
      current.end = Math.max(current.end, interval.end);
    else {
      total += current.end - current.start;
      current = { ...interval };
    }
  }
  return total + (current ? current.end - current.start : 0);
}

const TOKEN_TOTAL_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_write_or_creation_input_tokens",
  "reasoning_output_tokens",
  "reported_total_tokens",
] as const;
const TOKEN_SAMPLE_FIELDS = [
  "input_samples",
  "output_samples",
  "cache_read_samples",
  "cache_write_samples",
  "reasoning_samples",
  "reported_total_samples",
] as const;
type TokenTotalField = (typeof TOKEN_TOTAL_FIELDS)[number];
type TokenSampleField = (typeof TOKEN_SAMPLE_FIELDS)[number];
type TokenTotals = { observations: number } & Record<
  TokenTotalField,
  number | null
> &
  Record<TokenSampleField, number>;
type ModelTotals = TokenTotals & { runs: Set<string> };

function emptyTokenTotals(): TokenTotals {
  return {
    observations: 0,
    input_tokens: null,
    output_tokens: null,
    cache_read_input_tokens: null,
    cache_write_or_creation_input_tokens: null,
    reasoning_output_tokens: null,
    reported_total_tokens: null,
    input_samples: 0,
    output_samples: 0,
    cache_read_samples: 0,
    cache_write_samples: 0,
    reasoning_samples: 0,
    reported_total_samples: 0,
  };
}

function emptyModelTotals(): ModelTotals {
  return { ...emptyTokenTotals(), runs: new Set<string>() };
}

function addTokenRow(target: TokenTotals, row: Record<string, unknown>): void {
  target.observations += Number(row.observations);
  for (const field of TOKEN_SAMPLE_FIELDS) target[field] += Number(row[field]);
  for (const field of TOKEN_TOTAL_FIELDS)
    if (row[field] !== null)
      target[field] = (target[field] ?? 0) + Number(row[field]);
}

function coverageSummary(
  totalRuns: number,
  observedRuns: number,
  details: Record<string, unknown>,
): Record<string, unknown> {
  return { ...details, ...coverageCounts(totalRuns, observedRuns) };
}

function coverageCounts(
  totalRuns: number,
  observedRuns: number,
): Record<string, number | null> {
  return {
    runs_with_data: observedRuns,
    runs_missing_data: totalRuns - observedRuns,
    run_coverage: totalRuns === 0 ? null : observedRuns / totalRuns,
  };
}

function average(total: number | null, count: number): number | null {
  return total === null || count === 0 ? null : total / count;
}

function increment(
  target: Record<string, number>,
  key: string,
  amount = 1,
): void {
  target[key] = (target[key] ?? 0) + amount;
}

interface RunResources {
  agentType: string;
  agentVersion: string;
  models: Set<string>;
  runSpanMs: number | null;
  messages: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number | null;
  toolWallClockMs: number | null;
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
  for (const row of messages)
    messageTotals.set(
      String(row.cospec_run_id),
      (messageTotals.get(String(row.cospec_run_id)) ?? 0) + Number(row.count),
    );
  const tokenTotals = new Map<string, TokenTotals>();
  for (const row of tokens) {
    const runId = String(row.cospec_run_id);
    const total = tokenTotals.get(runId) ?? emptyTokenTotals();
    addTokenRow(total, row);
    tokenTotals.set(runId, total);
  }
  const callsByRun = groupRows(calls);
  const resultsByRun = groupRows(results);
  const values: RunResources[] = runs.map((row) => {
    const runId = String(row.cospec_run_id);
    const parsed = row.parser_version !== null;
    const runCalls = callsByRun.get(runId) ?? [];
    const duration = calculateToolDurations(
      runCalls,
      resultsByRun.get(runId) ?? [],
    ).overall;
    const first = timestampMs(row.first_event_at);
    const last = timestampMs(row.last_event_at);
    return {
      agentType: String(row.agent_type),
      agentVersion: String(row.agent_version),
      models: modelsByRun.get(runId) ?? new Set<string>(),
      runSpanMs:
        first !== null && last !== null && last >= first ? last - first : null,
      messages: parsed ? (messageTotals.get(runId) ?? 0) : null,
      inputTokens: tokenTotals.get(runId)?.input_tokens ?? null,
      outputTokens: tokenTotals.get(runId)?.output_tokens ?? null,
      toolCalls: parsed ? runCalls.length : null,
      toolWallClockMs: !parsed
        ? null
        : runCalls.length === 0
          ? 0
          : duration.coverage === 1
            ? Number(duration.wall_clock_ms)
            : null,
    };
  });
  return {
    overall: resourceMetrics(values),
    byAgent: groupedResourceMetrics(values, (row) => [row.agentType]),
    byAgentVersion: groupedResourceMetrics(values, (row) => [
      `${row.agentType}@${row.agentVersion}`,
    ]),
    byModel: groupedResourceMetrics(values, (row) => [...row.models]),
    modelGroupingNote: "multi_model_run_is_included_in_each_model_group",
  };
}

function groupRows(
  rows: Array<Record<string, unknown>>,
): Map<string, Array<Record<string, unknown>>> {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const runId = String(row.cospec_run_id);
    const values = grouped.get(runId) ?? [];
    values.push(row);
    grouped.set(runId, values);
  }
  return grouped;
}

function groupedResourceMetrics(
  values: RunResources[],
  keys: (value: RunResources) => string[],
): Record<string, unknown> {
  const grouped = new Map<string, RunResources[]>();
  for (const value of values)
    for (const key of keys(value)) {
      const rows = grouped.get(key) ?? [];
      rows.push(value);
      grouped.set(key, rows);
    }
  return Object.fromEntries(
    [...grouped]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, rows]) => [key, resourceMetrics(rows)]),
  );
}

function resourceMetrics(values: RunResources[]): Record<string, unknown> {
  return {
    runs: values.length,
    run_span_ms: metricDistribution(values.map((row) => row.runSpanMs)),
    messages_per_run: metricDistribution(values.map((row) => row.messages)),
    input_tokens_per_run: metricDistribution(
      values.map((row) => row.inputTokens),
    ),
    output_tokens_per_run: metricDistribution(
      values.map((row) => row.outputTokens),
    ),
    tool_calls_per_run: metricDistribution(values.map((row) => row.toolCalls)),
    tool_wall_clock_ms_per_run: metricDistribution(
      values.map((row) => row.toolWallClockMs),
    ),
  };
}

function metricDistribution(
  values: Array<number | null>,
): Record<string, number | null> {
  const measured = values
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  return {
    runs_with_data: measured.length,
    runs_missing_data: values.length - measured.length,
    run_coverage: values.length === 0 ? null : measured.length / values.length,
    average: measured.length
      ? measured.reduce((sum, value) => sum + value, 0) / measured.length
      : null,
    p50: percentile(measured, 0.5),
    p90: percentile(measured, 0.9),
  };
}

function summarizeSubagents(
  sessions: Array<Record<string, unknown>>,
  messages: Array<Record<string, unknown>>,
  tokens: Array<Record<string, unknown>>,
  calls: Array<Record<string, unknown>>,
  results: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const messagesBySession = groupRowsBy(messages, "agent_session_id");
  const tokensBySession = groupRowsBy(tokens, "agent_session_id");
  const callsBySession = groupRowsBy(calls, "agent_session_id");
  const resultsBySession = groupRowsBy(results, "agent_session_id");
  const allTokenTotals = emptyTokenTotals();
  const models: Record<string, ModelTotals> = {};
  for (const row of tokens) {
    addTokenRow(allTokenTotals, row);
    if (row.model !== null) {
      const model = String(row.model);
      models[model] ??= emptyModelTotals();
      addTokenRow(models[model], row);
      models[model].runs.add(String(row.agent_session_id));
    }
  }
  const prefixedCalls = calls.map((row) => ({
    ...row,
    call_id: `${row.agent_session_id}:${row.call_id}`,
  }));
  const prefixedResults = results.map((row) => ({
    ...row,
    call_id: `${row.agent_session_id}:${row.call_id}`,
  }));
  const items = sessions.map((session) => {
    const id = String(session.agent_session_id);
    const roleRows = messagesBySession.get(id) ?? [];
    const byRole = Object.fromEntries(
      roleRows.map((row) => [String(row.role), Number(row.count)]),
    );
    const sessionTokens = emptyTokenTotals();
    for (const row of tokensBySession.get(id) ?? [])
      addTokenRow(sessionTokens, row);
    const sessionCalls = callsBySession.get(id) ?? [];
    const sessionResults = resultsBySession.get(id) ?? [];
    const first = timestampMs(session.first_event_at);
    const last = timestampMs(session.last_event_at);
    return {
      agentSessionId: id,
      parentAgentSessionId:
        session.parent_agent_session_id === null
          ? null
          : String(session.parent_agent_session_id),
      parsed: Number(session.parsed) === 1,
      recordSpanMs:
        first !== null && last !== null && last >= first ? last - first : null,
      messages: {
        total: roleRows.reduce((sum, row) => sum + Number(row.count), 0),
        byRole,
      },
      tokens: sessionTokens,
      tools: {
        calls: sessionCalls.length,
        duration: calculateToolDurations(sessionCalls, sessionResults).overall,
      },
      models: [
        ...new Set(
          (tokensBySession.get(id) ?? []).flatMap((row) =>
            row.model === null ? [] : [String(row.model)],
          ),
        ),
      ].sort(),
    };
  });
  const sessionIds = new Set(items.map((item) => item.agentSessionId));
  const depth = (item: (typeof items)[number]): number => {
    let value = 1;
    let parent = item.parentAgentSessionId;
    const visited = new Set<string>();
    while (parent && sessionIds.has(parent) && !visited.has(parent)) {
      visited.add(parent);
      value += 1;
      parent =
        items.find((candidate) => candidate.agentSessionId === parent)
          ?.parentAgentSessionId ?? null;
    }
    return value;
  };
  return {
    count: items.length,
    parsed_sessions: items.filter((item) => item.parsed).length,
    max_depth: items.length ? Math.max(...items.map(depth)) : 0,
    messages: {
      total: items.reduce((sum, item) => sum + item.messages.total, 0),
    },
    tokens: allTokenTotals,
    tools: {
      calls: calls.length,
      duration: calculateToolDurations(prefixedCalls, prefixedResults).overall,
    },
    byModel: Object.fromEntries(
      Object.entries(models).map(([model, totals]) => {
        const { runs, ...data } = totals;
        return [model, { ...data, sessions: runs.size }];
      }),
    ),
    sessions: items,
  };
}

function groupRowsBy(
  rows: Array<Record<string, unknown>>,
  field: string,
): Map<string, Array<Record<string, unknown>>> {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const key = String(row[field]);
    const values = grouped.get(key) ?? [];
    values.push(row);
    grouped.set(key, values);
  }
  return grouped;
}

interface SubagentUsageRow {
  agentType: string;
  agentVersion: string;
  models: Set<string>;
  sessions: number;
  maxDepth: number;
  sessionSpans: number[];
  messages: number;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number;
  toolWallClockMs: number | null;
  messageShare: number | null;
  inputTokenShare: number | null;
  outputTokenShare: number | null;
  toolCallShare: number | null;
}

function buildSubagentUsage(
  runs: Array<Record<string, unknown>>,
  sessionRows: Array<Record<string, unknown>>,
  messageRows: Array<Record<string, unknown>>,
  childTokenRows: Array<Record<string, unknown>>,
  allMessageRows: Array<Record<string, unknown>>,
  allTokenRows: Array<Record<string, unknown>>,
  allCallRows: Array<Record<string, unknown>>,
  allResultRows: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const eligible = runs.filter((row) => Number(row.subagent_collection) === 1);
  const sessionsByRun = groupRows(sessionRows);
  const childMessages = sumRowsByRun(messageRows, "count");
  const allMessages = sumRowsByRun(allMessageRows, "count");
  const childTokens = tokenTotalsByRun(childTokenRows);
  const allTokens = tokenTotalsByRun(allTokenRows);
  const childCalls = groupRows(
    allCallRows.filter((row) => row.session_role === "subagent"),
  );
  const childResults = groupRows(
    allResultRows.filter((row) => row.session_role === "subagent"),
  );
  const allCalls = groupRows(allCallRows);
  const values: SubagentUsageRow[] = eligible.map((run) => {
    const runId = String(run.cospec_run_id);
    const sessions = sessionsByRun.get(runId) ?? [];
    const ids = new Set(sessions.map((row) => String(row.agent_session_id)));
    const depth = (row: Record<string, unknown>): number => {
      let result = 1;
      let parent =
        row.parent_agent_session_id === null
          ? null
          : String(row.parent_agent_session_id);
      const seen = new Set<string>();
      while (parent && ids.has(parent) && !seen.has(parent)) {
        seen.add(parent);
        result += 1;
        parent =
          (sessions.find(
            (candidate) => String(candidate.agent_session_id) === parent,
          )?.parent_agent_session_id as string | null) ?? null;
      }
      return result;
    };
    const spans = sessions.flatMap((row) => {
      const first = timestampMs(row.first_event_at);
      const last = timestampMs(row.last_event_at);
      return first !== null && last !== null && last >= first
        ? [last - first]
        : [];
    });
    const calls = childCalls.get(runId) ?? [];
    const results = childResults.get(runId) ?? [];
    const prefixedCalls = calls.map((row) => ({
      ...row,
      call_id: `${row.agent_session_id}:${row.call_id}`,
    }));
    const prefixedResults = results.map((row) => ({
      ...row,
      call_id: `${row.agent_session_id}:${row.call_id}`,
    }));
    const duration = calculateToolDurations(
      prefixedCalls,
      prefixedResults,
    ).overall;
    const child = childTokens.get(runId) ?? emptyTokenTotals();
    const total = allTokens.get(runId) ?? emptyTokenTotals();
    const messages = childMessages.get(runId) ?? 0;
    const totalMessages = allMessages.get(runId) ?? 0;
    const models = new Set(
      childTokenRows
        .filter(
          (row) => String(row.cospec_run_id) === runId && row.model !== null,
        )
        .map((row) => String(row.model)),
    );
    return {
      agentType: String(run.agent_type),
      agentVersion: String(run.agent_version),
      models,
      sessions: sessions.length,
      maxDepth: sessions.length ? Math.max(...sessions.map(depth)) : 0,
      sessionSpans: spans,
      messages,
      inputTokens: child.input_tokens,
      outputTokens: child.output_tokens,
      toolCalls: calls.length,
      toolWallClockMs:
        calls.length === 0
          ? 0
          : duration.coverage === 1
            ? Number(duration.wall_clock_ms)
            : null,
      messageShare: ratio(messages, totalMessages),
      inputTokenShare: ratio(child.input_tokens, total.input_tokens),
      outputTokenShare: ratio(child.output_tokens, total.output_tokens),
      toolCallShare: ratio(calls.length, (allCalls.get(runId) ?? []).length),
    };
  });
  return {
    eligible_runs: eligible.length,
    excluded_legacy_runs: runs.length - eligible.length,
    ...subagentGroupMetrics(values),
    byAgent: groupedSubagentMetrics(values, (row) => [row.agentType]),
    byAgentVersion: groupedSubagentMetrics(values, (row) => [
      `${row.agentType}@${row.agentVersion}`,
    ]),
    byModel: groupedSubagentMetrics(values, (row) => [...row.models]),
    modelGroupingNote:
      "multi_model_subagent_run_is_included_in_each_model_group",
  };
}

function subagentGroupMetrics(
  values: SubagentUsageRow[],
): Record<string, unknown> {
  const withSubagents = values.filter((row) => row.sessions > 0).length;
  return {
    runs_with_subagents: withSubagents,
    runs_without_subagents: values.length - withSubagents,
    usage_rate: values.length ? withSubagents / values.length : null,
    sessions: {
      total: values.reduce((sum, row) => sum + row.sessions, 0),
      per_run: metricDistribution(values.map((row) => row.sessions)),
      max_depth_per_run: metricDistribution(values.map((row) => row.maxDepth)),
      span_ms: metricDistribution(values.flatMap((row) => row.sessionSpans)),
    },
    messages: {
      total: values.reduce((sum, row) => sum + row.messages, 0),
      per_run: metricDistribution(values.map((row) => row.messages)),
    },
    input_tokens: nullableTotalAndDistribution(
      values.map((row) => row.inputTokens),
    ),
    output_tokens: nullableTotalAndDistribution(
      values.map((row) => row.outputTokens),
    ),
    tools: {
      calls: values.reduce((sum, row) => sum + row.toolCalls, 0),
      calls_per_run: metricDistribution(values.map((row) => row.toolCalls)),
      wall_clock_ms_per_run: metricDistribution(
        values.map((row) => row.toolWallClockMs),
      ),
    },
    resource_share: {
      messages: metricDistribution(values.map((row) => row.messageShare)),
      input_tokens: metricDistribution(
        values.map((row) => row.inputTokenShare),
      ),
      output_tokens: metricDistribution(
        values.map((row) => row.outputTokenShare),
      ),
      tool_calls: metricDistribution(values.map((row) => row.toolCallShare)),
    },
  };
}

function groupedSubagentMetrics(
  values: SubagentUsageRow[],
  keys: (row: SubagentUsageRow) => string[],
): Record<string, unknown> {
  const grouped = new Map<string, SubagentUsageRow[]>();
  for (const value of values)
    for (const key of keys(value)) {
      const rows = grouped.get(key) ?? [];
      rows.push(value);
      grouped.set(key, rows);
    }
  return Object.fromEntries(
    [...grouped]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, rows]) => [key, subagentGroupMetrics(rows)]),
  );
}

function sumRowsByRun(
  rows: Array<Record<string, unknown>>,
  field: string,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const id = String(row.cospec_run_id);
    totals.set(id, (totals.get(id) ?? 0) + Number(row[field]));
  }
  return totals;
}

function tokenTotalsByRun(
  rows: Array<Record<string, unknown>>,
): Map<string, TokenTotals> {
  const totals = new Map<string, TokenTotals>();
  for (const row of rows) {
    const id = String(row.cospec_run_id);
    const value = totals.get(id) ?? emptyTokenTotals();
    addTokenRow(value, row);
    totals.set(id, value);
  }
  return totals;
}

function nullableTotalAndDistribution(
  values: Array<number | null>,
): Record<string, unknown> {
  const available = values.filter((value): value is number => value !== null);
  return {
    total: available.length
      ? available.reduce((sum, value) => sum + value, 0)
      : null,
    per_run: metricDistribution(values),
  };
}

function ratio(part: number | null, total: number | null): number | null {
  return part === null || total === null || total === 0 ? null : part / total;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
