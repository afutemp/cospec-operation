import { randomUUID } from "node:crypto";
import type { AgentType, CollectorState, RunBinding } from "./types.js";
import { locateClaudeCodeSession, locateCodexSession, type LocatedSession } from "./session.js";

export class RunRegistry {
  private readonly roots: Record<AgentType, string>;
  constructor(sessionsRoot: string | Record<AgentType, string>) {
    this.roots = typeof sessionsRoot === "string"
      ? { codex: sessionsRoot, claude_code: sessionsRoot }
      : sessionsRoot;
  }

  async ensure(state: CollectorState, agentType: AgentType, sessionId: string, runId: string): Promise<RunBinding> {
    const existing = state.runs[runId];
    if (existing) {
      if (existing.agentType !== agentType || existing.agentSessionId !== sessionId) throw new Error("run_binding_conflict");
      return existing;
    }
    const openForSession = Object.values(state.runs).find((run) => run.agentType === agentType && run.agentSessionId === sessionId && (run.status === "open" || run.status === "pending"));
    if (openForSession) throw new Error("session_has_active_run");
    const located = await this.locate(agentType, sessionId);
    const now = new Date().toISOString();
    const binding: RunBinding = {
      schemaVersion: "0.1.0", cospecRunId: runId, agentType, agentSessionId: sessionId,
      sourceFileId: null, generation: null, startOffset: null, endOffset: null,
      startedAt: now, endedAt: null, status: "pending",
    };
    if (located) {
      const file = state.files[located.path] ?? {
        sourceFileId: randomUUID(), canonicalPath: located.path, agentType, agentSessionId: sessionId,
        sourceVersion: located.sourceVersion,
        generation: 1, confirmedOffset: 0, previousChunkSha256: null,
        observedFileIdentity: located.identity, pendingUpload: null, lastDiagnostic: null,
      };
      state.files[located.path] = file;
      file.confirmedOffset = located.completeOffset;
      file.previousChunkSha256 = null;
      file.pendingUpload = null;
      binding.sourceFileId = file.sourceFileId;
      binding.generation = file.generation;
      binding.startOffset = located.completeOffset;
      binding.status = "open";
    }
    state.runs[runId] = binding;
    return binding;
  }

  async resolvePending(state: CollectorState): Promise<number> {
    let resolved = 0;
    for (const binding of Object.values(state.runs)) {
      if (binding.status !== "pending") continue;
      const located = await this.locate(binding.agentType, binding.agentSessionId);
      if (!located) continue;
      const file = state.files[located.path] ?? {
        sourceFileId: randomUUID(), canonicalPath: located.path, agentType: binding.agentType,
        agentSessionId: binding.agentSessionId, sourceVersion: located.sourceVersion,
        generation: 1, confirmedOffset: 0, previousChunkSha256: null,
        observedFileIdentity: located.identity, pendingUpload: null, lastDiagnostic: null,
      };
      state.files[located.path] = file;
      file.confirmedOffset = located.completeOffset;
      file.previousChunkSha256 = null;
      file.pendingUpload = null;
      binding.sourceFileId = file.sourceFileId;
      binding.generation = file.generation;
      binding.startOffset = located.completeOffset;
      binding.status = "open";
      resolved += 1;
    }
    return resolved;
  }

  async finish(state: CollectorState, runId: string, status: "completed" | "failed" | "interrupted"): Promise<RunBinding> {
    const binding = state.runs[runId];
    if (!binding) throw new Error("run_not_found");
    if (binding.status === status) return binding;
    if (binding.status !== "open") throw new Error("run_finish_conflict");
    const located = await this.locate(binding.agentType, binding.agentSessionId);
    if (!located || !binding.sourceFileId) throw new Error("session_file_not_found");
    binding.endOffset = located.completeOffset;
    binding.endedAt = new Date().toISOString();
    binding.status = status;
    return binding;
  }

  private locate(agentType: AgentType, sessionId: string): Promise<LocatedSession | null> {
    return agentType === "codex"
      ? locateCodexSession(this.roots.codex, sessionId)
      : locateClaudeCodeSession(this.roots.claude_code, sessionId);
  }
}

export function runBindingContract(binding: RunBinding): Record<string, unknown> {
  return {
    schema_version: binding.schemaVersion,
    cospec_run_id: binding.cospecRunId,
    agent_type: binding.agentType,
    agent_session_id: binding.agentSessionId,
    source_file_id: binding.sourceFileId,
    generation: binding.generation,
    start_offset: binding.startOffset,
    end_offset: binding.endOffset,
    started_at: binding.startedAt,
    ended_at: binding.endedAt,
    status: binding.status,
  };
}
