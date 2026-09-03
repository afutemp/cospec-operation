import { auth } from "./auth";

export interface RunItem {
  runId: string; agentSessionId: string; sourceType: string; sourceVersion: string; agentType: string; agentVersion:string; cospecPluginVersion:string;
  chunkCount: number; byteCount: number; startOffset: number; endOffset: number;
  activeParserVersion: string | null; firstReceivedAt: string; lastReceivedAt: string;
  workflowKind: string | null; workflowName: string | null; workflowStatus: string;
  employeeId: string | null; displayName: string | null; proposerDept: string | null;
  identityResolution:"snapshot"|"person_backfill"|"terminal_backfill"|"unknown";
  skills: string[]; artifactCount: number; toolFailureCount: number;
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
async function send<T>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T> {
  const response = await fetch(path, { method, headers: { authorization: `Bearer ${auth.token.value}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 401) auth.clear();
    throw new ApiError(response.status, result.error ?? `request_failed_${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function download(path: string, fileName: string): Promise<void> {
  const response = await fetch(path, { headers: { authorization: `Bearer ${auth.token.value}` } });
  if (!response.ok) throw new ApiError(response.status, "download_failed");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = fileName; anchor.click();
  URL.revokeObjectURL(url);
}

export const telemetryQueries = {
  health: () => get<{ status: string }>("/health/ready"),
  getCurrentUser: () => get<{ role: "viewer" | "admin"; display_name: string; user_id: string | null; source: "deployment" | "local" }>("/api/v1/auth/me"),
  listDashboardUsers: () => get<{ items: JsonObject[] }>("/api/v1/admin/users"),
  createDashboardUser: (displayName: string, role: "viewer" | "admin") => send<{ user: JsonObject; access_token: string }>("/api/v1/admin/users", "POST", { display_name: displayName, role }),
  updateDashboardUser: (userId: string, changes: { role?: "viewer" | "admin"; status?: "active" | "disabled" }) => send<{ user: JsonObject }>(`/api/v1/admin/users/${encodeURIComponent(userId)}`, "PATCH", changes),
  getRunUsage: (filters: Record<string, string>) => get<JsonObject>(`/api/v1/summaries/run-usage?${new URLSearchParams(filters)}`),
  getWorkflowSummary: (filters: Record<string, string> = {}) => get<JsonObject>(`/api/v1/summaries/workflows?${new URLSearchParams(filters)}`),
  getKnowledgeSummary: (filters: Record<string, string> = {}) => get<JsonObject>(`/api/v1/summaries/knowledge?${new URLSearchParams(filters)}`),
  getRunEvents: (runId: string) => get<{ items: JsonObject[] }>(`/api/v1/runs/${encodeURIComponent(runId)}/events`),
  listRuns: (limit: number, offset: number, filters: Record<string,string> = {}) => get<Page<RunItem>>(`/api/v1/runs?${new URLSearchParams({ limit:String(limit), offset:String(offset), ...filters })}`),
  getRun: (runId: string) => get<RunDetail>(`/api/v1/runs/${encodeURIComponent(runId)}`),
  getRunFacts: (runId: string) => get<JsonObject>(`/api/v1/runs/${encodeURIComponent(runId)}/facts`),
  getRunChunks: (runId: string) => get<{ items: JsonObject[] }>(`/api/v1/runs/${encodeURIComponent(runId)}/chunks`),
  getRunArtifacts: (runId: string) => get<{ items: JsonObject[] }>(`/api/v1/runs/${encodeURIComponent(runId)}/artifacts`),
  downloadArtifact: (uploadId: string, fileName: string) => download(`/api/v1/artifacts/${encodeURIComponent(uploadId)}/download`, fileName),
  getRunReplays: (runId: string) => get<{ items: JsonObject[] }>(`/api/v1/runs/${encodeURIComponent(runId)}/replays`),
  getRunRawSources: (runId: string) => get<{ items: JsonObject[] }>(`/api/v1/runs/${encodeURIComponent(runId)}/raw-sources`),
  downloadRunRawSource: (runId: string, sourceFileId: string, generation: number, fileName: string) => download(`/api/v1/runs/${encodeURIComponent(runId)}/raw-sources/${encodeURIComponent(sourceFileId)}/${generation}/download`, fileName),
};
