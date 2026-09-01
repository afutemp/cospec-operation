export interface RunListItem {
  runId: string; agentSessionId: string; sourceType: string; sourceVersion: string; agentType: string;
  chunkCount: number; byteCount: number; startOffset: number; endOffset: number;
  activeParserVersion: string | null; firstReceivedAt: string; lastReceivedAt: string;
}

export interface RunDetail extends RunListItem {
  parseStatusCounts: Record<string, number>;
  totalLines: number | null; validLines: number | null; invalidLines: number | null;
  unknownTypeLines: number | null; typeCounts: Record<string, number>;
  firstTimestamp: string | null; lastTimestamp: string | null;
}

export interface RunUsageFilters {
  from?: string; to?: string; agentType?: "codex" | "claude_code"; agentVersion?: string; model?: string; cospecPluginVersion?: string;
}

export interface QueryRepository {
  listRuns(limit: number, offset: number): { items: RunListItem[]; total: number };
  getRun(runId: string): RunDetail | null;
  getRunChunks(runId: string): Promise<Array<Record<string, unknown>>>;
  getRunReplays(runId: string): Array<Record<string, unknown>>;
  getRunFacts(runId: string): Record<string, unknown> | null;
  getRunUsageSummary(filters: RunUsageFilters): Record<string, unknown>;
}
