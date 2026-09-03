export interface RunListItem {
  runId: string; agentSessionId: string; sourceType: string; sourceVersion: string; agentType: string; agentVersion: string; cospecPluginVersion: string;
  chunkCount: number; byteCount: number; startOffset: number; endOffset: number;
  activeParserVersion: string | null; firstReceivedAt: string; lastReceivedAt: string;
  workflowKind: string | null; workflowName: string | null; workflowStatus: string;
  employeeId: string | null; displayName: string | null; proposerDept: string | null;
  identityResolution: "snapshot" | "person_backfill" | "terminal_backfill" | "unknown";
  skills: string[]; artifactCount: number; toolFailureCount: number;
}

export interface RunListFilters extends RunUsageFilters {
  workflowKind?: "large" | "small" | "custom"; workflowStatus?: "running" | "completed" | "failed" | "interrupted";
  skill?: string; hasArtifact?: boolean; artifactRole?: string; toolFailure?: boolean; inactiveHours?: number; identityMissing?: boolean;
}

export interface RunDetail extends RunListItem {
  parseStatusCounts: Record<string, number>;
  totalLines: number | null; validLines: number | null; invalidLines: number | null;
  unknownTypeLines: number | null; typeCounts: Record<string, number>;
  firstTimestamp: string | null; lastTimestamp: string | null;
}

export interface RunUsageFilters {
  from?: string; to?: string; workflowKind?: "large" | "small" | "custom"; agentType?: "codex" | "claude_code"; agentVersion?: string; model?: string; cospecPluginVersion?: string; employeeId?: string; proposerDept?: string;
}

export interface QueryRepository {
  listRuns(limit: number, offset: number, filters?: RunListFilters): { items: RunListItem[]; total: number };
  getRun(runId: string): RunDetail | null;
  getRunChunks(runId: string): Promise<Array<Record<string, unknown>>>;
  getRunReplays(runId: string): Array<Record<string, unknown>>;
  getRunFacts(runId: string): Record<string, unknown> | null;
  listRunRawSources(runId: string): Array<Record<string, unknown>>;
  getRunRawSource(runId: string, sourceFileId: string, generation: number): Promise<Buffer | null>;
  getRunUsageSummary(filters: RunUsageFilters): Record<string, unknown>;
  getRunEvents?(runId: string): import("../collector/types.js").RunEvent[];
  getKnowledgeSummary?(filters?: { from?: string; to?: string }): Record<string, unknown>;
  getWorkflowSummary?(filters?: { from?: string; to?: string; employeeId?: string; proposerDept?: string }): Record<string, unknown>;
}
