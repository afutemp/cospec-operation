export type AgentType = "codex" | "claude_code";
export type RunStatus = "pending" | "open" | "completed" | "failed" | "interrupted";
export type WorkflowKind = "large" | "small" | "custom";
export interface RunEvent {
  schema_version: "0.1.0"; event_id: string; cospec_run_id: string;
  event_type: "run_started" | "stage_started" | "stage_finished" | "skill_started" | "skill_finished" | "knowledge_query_finished" | "run_finished";
  occurred_at: string; workflow_kind?: WorkflowKind; workflow_name?: string;
  stage?: string; status?: "completed" | "failed" | "interrupted" | "skipped" | "orphan";
  skill?: string; execution_id?: string;
  query_id?: string; kb_name?: string; kb_version?: string; kb_revision?: string;
  query_status?: "completed" | "degraded" | "failed" | "incomplete";
  query_source?: "workflow" | "user"; consumer_skill?: string;
  answerability?: "answerable" | "partially_answerable" | "unanswerable" | "conflicted";
  hit_count?: number; citation_count?: number; warning_count?: number;
  actor?: { employee_id: string; display_name: string; proposer_dept?: string };
}

export interface FileState {
  agentType?: AgentType;
  sourceFileId: string;
  canonicalPath: string;
  agentSessionId: string;
  sourceVersion: string;
  generation: number;
  confirmedOffset: number;
  previousChunkSha256: string | null;
  observedFileIdentity: string;
  pendingUpload: ChunkMetadata | null;
  lastDiagnostic: { code: "source_truncated" | "source_rotated"; observedAt: string } | null;
  cospecRunId?: string;
  sessionRole?: "main" | "subagent";
  rootAgentSessionId?: string;
  parentAgentSessionId?: string | null;
  collectionEndOffset?: number | null;
}

export interface RunBinding {
  schemaVersion: "0.1.0";
  cospecRunId: string;
  agentType: AgentType;
  agentSessionId: string;
  sourceFileId: string | null;
  generation: number | null;
  startOffset: number | null;
  endOffset: number | null;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  workflowKind?: WorkflowKind;
  workflowName?: string;
  actor?: { employeeId: string; displayName: string; proposerDept?: string };
}

export interface CollectorState {
  schemaVersion: 1;
  files: Record<string, FileState>;
  runs: Record<string, RunBinding>;
  diagnostics?: CollectorDiagnostics;
  pendingEvents?: RunEvent[];
  artifacts?: Record<string, ArtifactState>;
}

export interface ArtifactMetadata {
  schema_version: "0.1.0"; upload_id: string; cospec_run_id: string;
  skill: string; attempt_id: string; artifact_index: number; artifact_role: string;
  file_name: string; logical_path: string; content_type: string; size_bytes: number; sha256: string; created_at: string;
}

export interface ArtifactState {
  key: string; metadata: ArtifactMetadata; spoolPath: string;
  status: "pending" | "uploaded" | "rejected"; error?: string; uploadedAt?: string;
}

export interface CollectorDiagnostics {
  lastScanAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: {
    at: string;
    stage: "scan" | "upload";
    code: string;
    cospecRunId?: string;
    sourceFileId?: string;
  } | null;
  recoveredAt: string | null;
}

export type CollectorCommand =
  | { type: "ensure"; agentType: AgentType; agentSessionId: string; cospecRunId: string; workflowKind?: WorkflowKind; workflowName?: string; actor?: { employeeId: string; displayName: string; proposerDept?: string } }
  | { type: "event"; event: RunEvent }
  | { type: "sync_artifacts"; cospecRunId: string; manifestPath: string }
  | { type: "finish"; cospecRunId: string; status: "completed" | "failed" | "interrupted" }
  | { type: "status" }
  | { type: "scan" }
  | { type: "shutdown" };

export interface CommandResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
  collectorVersion?: string;
  protocolVersion?: number;
}

export interface ChunkMetadata {
  schema_version: "0.1.0";
  upload_id: string;
  cospec_run_id: string;
  source_type: "codex_jsonl" | "claude_code_jsonl";
  source_version: string;
  agent_session_id: string;
  collected_at: string;
  collector_version: string;
  session?: {
    role: "main" | "subagent";
    root_agent_session_id: string;
    parent_agent_session_id: string | null;
  };
  file: {
    source_file_id: string; generation: number; path_hint: string;
    start_offset: number; end_offset: number; byte_count: number; line_count: number;
    sha256: string; previous_chunk_sha256: string | null; ends_with_newline: true;
  };
  environment: {
    captured_at: string; agent_type: AgentType; agent_version: string;
    os_platform: "linux" | "darwin" | "win32"; os_arch: string;
    cospec_plugin_version: string; timezone: string; anonymous_terminal_id?: string;
  };
}
