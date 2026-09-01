import { auth } from "./auth";

export interface RunItem {
  runId: string; agentSessionId: string; sourceType: string; sourceVersion: string; agentType: string;
  chunkCount: number; byteCount: number; startOffset: number; endOffset: number;
  activeParserVersion: string | null; firstReceivedAt: string; lastReceivedAt: string;
}
export interface RunDetail extends RunItem {
  parseStatusCounts: Record<string, number>; totalLines: number | null; validLines: number | null;
  invalidLines: number | null; unknownTypeLines: number | null; typeCounts: Record<string, number>;
  firstTimestamp: string | null; lastTimestamp: string | null;
}
export interface Page<T> { items: T[]; total: number; limit: number; offset: number }
export type JsonObject = Record<string, any>;

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { authorization: `Bearer ${auth.token.value}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 401) auth.clear();
    throw new ApiError(response.status, body.error ?? `request_failed_${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const telemetryQueries = {
  health: () => get<{ status: string }>("/health/ready"),
  getRunUsage: (filters: Record<string, string>) => get<JsonObject>(`/api/v1/summaries/run-usage?${new URLSearchParams(filters)}`),
  listRuns: (limit: number, offset: number) => get<Page<RunItem>>(`/api/v1/runs?limit=${limit}&offset=${offset}`),
  getRun: (runId: string) => get<RunDetail>(`/api/v1/runs/${encodeURIComponent(runId)}`),
  getRunFacts: (runId: string) => get<JsonObject>(`/api/v1/runs/${encodeURIComponent(runId)}/facts`),
  getRunChunks: (runId: string) => get<{ items: JsonObject[] }>(`/api/v1/runs/${encodeURIComponent(runId)}/chunks`),
  getRunReplays: (runId: string) => get<{ items: JsonObject[] }>(`/api/v1/runs/${encodeURIComponent(runId)}/replays`),
};
