export const PARSER_VERSION = "0.5.1";

const CODEX_KNOWN_TYPES = new Set(["session_meta", "event_msg", "response_item", "turn_context", "compacted"]);
const CLAUDE_CODE_KNOWN_TYPES = new Set(["queue-operation", "user", "assistant", "attachment", "last-prompt", "mode", "system"]);

export interface ParseDiagnostic { line: number; byteOffset: number; code: "invalid_json" }
export interface MessageFact { recordIndex: number; timestamp: string | null; role: string; model: string | null }
export interface TokenUsageFact {
  recordIndex: number; timestamp: string | null; model: string | null;
  inputTokens: number | null; outputTokens: number | null; cacheReadInputTokens: number | null;
  cacheWriteOrCreationInputTokens: number | null; reasoningOutputTokens: number | null; reportedTotalTokens: number | null;
}
export interface ToolCallFact { recordIndex: number; itemIndex: number; timestamp: string | null; callId: string; toolName: string }
export interface ToolResultFact {
  recordIndex: number; itemIndex: number; timestamp: string | null; callId: string;
  status: "success" | "failure" | "unknown"; failureCode: "nonzero_exit_code" | "explicit_is_error" | null;
}
export interface CompactionFact {
  recordIndex: number; timestamp: string | null; trigger: "auto" | "manual" | "unknown";
  preTokens: number | null; postTokens: number | null;
}
export interface ContextWindowFact { recordIndex: number; timestamp: string | null; contextWindowTokens: number }
export interface SkillMarkerFact {
  recordIndex: number; itemIndex: number; markerIndex: number; timestamp: string | null;
  phase: "start" | "end"; skill: string; executionId: string;
  status: "ok" | "failed" | "interrupted" | "orphan" | null;
}
export interface TurnEventFact {
  recordIndex: number; itemIndex: number; timestamp: string | null;
  kind: "agent_message" | "user_prompt";
}
export interface ParseResult {
  parserVersion: string;
  status: "completed" | "completed_with_errors";
  totalLines: number;
  validLines: number;
  invalidLines: number;
  unknownTypeLines: number;
  typeCounts: Record<string, number>;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  diagnostics: ParseDiagnostic[];
  messageFacts: MessageFact[];
  tokenUsageFacts: TokenUsageFact[];
  toolCallFacts: ToolCallFact[];
  toolResultFacts: ToolResultFact[];
  compactionFacts: CompactionFact[];
  contextWindowFacts: ContextWindowFact[];
  skillMarkerFacts: SkillMarkerFact[];
  turnEventFacts: TurnEventFact[];
}

export function parseCodexJsonl(bytes: Buffer, parserVersion = PARSER_VERSION): ParseResult {
  return parseJsonl(bytes, CODEX_KNOWN_TYPES, parserVersion);
}

export function parseClaudeCodeJsonl(bytes: Buffer, parserVersion = PARSER_VERSION): ParseResult {
  return parseJsonl(bytes, CLAUDE_CODE_KNOWN_TYPES, parserVersion);
}

export function parseSourceJsonl(bytes: Buffer, sourceType: "codex_jsonl" | "claude_code_jsonl", parserVersion = PARSER_VERSION): ParseResult {
  return sourceType === "claude_code_jsonl" ? parseClaudeCodeJsonl(bytes, parserVersion) : parseCodexJsonl(bytes, parserVersion);
}

function parseJsonl(bytes: Buffer, knownTypes: ReadonlySet<string>, parserVersion: string): ParseResult {
  let totalLines = 0;
  let validLines = 0;
  let invalidLines = 0;
  let unknownTypeLines = 0;
  let lineStart = 0;
  const typeCounts: Record<string, number> = {};
  const diagnostics: ParseDiagnostic[] = [];
  const timestamps: string[] = [];
  const messageFacts: MessageFact[] = [];
  const tokenUsageFacts: TokenUsageFact[] = [];
  const toolCallFacts: ToolCallFact[] = [];
  const toolResultFacts: ToolResultFact[] = [];
  const compactionFacts: CompactionFact[] = [];
  const contextWindowFacts: ContextWindowFact[] = [];
  const skillMarkerFacts: SkillMarkerFact[] = [];
  const turnEventFacts: TurnEventFact[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    totalLines += 1;
    const line = bytes.subarray(lineStart, index).toString("utf8").replace(/\r$/, "");
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      validLines += 1;
      const type = typeof value.type === "string" ? value.type : "<missing>";
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      if (!knownTypes.has(type)) unknownTypeLines += 1;
      if (typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp))) timestamps.push(value.timestamp);
      if (knownTypes === CODEX_KNOWN_TYPES) extractCodexFacts(value, totalLines, messageFacts, tokenUsageFacts, toolCallFacts, toolResultFacts, compactionFacts, contextWindowFacts, skillMarkerFacts, turnEventFacts);
      else extractClaudeCodeFacts(value, totalLines, messageFacts, tokenUsageFacts, toolCallFacts, toolResultFacts, compactionFacts, skillMarkerFacts, turnEventFacts);
    } catch {
      invalidLines += 1;
      diagnostics.push({ line: totalLines, byteOffset: lineStart, code: "invalid_json" });
    }
    lineStart = index + 1;
  }
  timestamps.sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    parserVersion,
    status: invalidLines > 0 ? "completed_with_errors" : "completed",
    totalLines, validLines, invalidLines, unknownTypeLines, typeCounts,
    firstTimestamp: timestamps[0] ?? null,
    lastTimestamp: timestamps.at(-1) ?? null,
    diagnostics, messageFacts, tokenUsageFacts, toolCallFacts, toolResultFacts, compactionFacts, contextWindowFacts, skillMarkerFacts, turnEventFacts,
  };
}

function extractCodexFacts(value: Record<string, unknown>, recordIndex: number, messages: MessageFact[], tokens: TokenUsageFact[], calls: ToolCallFact[], results: ToolResultFact[], compactions: CompactionFact[], contextWindows: ContextWindowFact[], skillMarkers: SkillMarkerFact[], turnEvents: TurnEventFact[]): void {
  const timestamp = validTimestamp(value.timestamp);
  const payload = object(value.payload);
  if (!payload) return;
  if (value.type === "compacted") compactions.push({ recordIndex, timestamp, trigger: "unknown", preTokens: null, postTokens: null });
  const contextWindowTokens = integer(payload.model_context_window) ?? integer(object(payload.info)?.model_context_window);
  if (contextWindowTokens !== null) contextWindows.push({ recordIndex, timestamp, contextWindowTokens });
  if (value.type === "response_item" && payload.type === "message" && typeof payload.role === "string") {
    messages.push({ recordIndex, timestamp, role: payload.role, model: null });
    if (payload.role === "user") turnEvents.push({ recordIndex, itemIndex: 0, timestamp, kind: "user_prompt" });
    else if (payload.role === "assistant" && hasVisibleText(payload.content)) turnEvents.push({ recordIndex, itemIndex: 0, timestamp, kind: "agent_message" });
  }
  if (value.type === "event_msg" && payload.type === "token_count") {
    const usage = object(object(payload.info)?.last_token_usage);
    if (usage) tokens.push(tokenFact(recordIndex, timestamp, null, usage, "codex"));
  }
  if (value.type !== "response_item") return;
  if ((payload.type === "custom_tool_call" || payload.type === "function_call") && typeof payload.call_id === "string" && typeof payload.name === "string") {
    calls.push({ recordIndex, itemIndex: 0, timestamp, callId: payload.call_id, toolName: payload.name });
  }
  if ((payload.type === "custom_tool_call_output" || payload.type === "function_call_output") && typeof payload.call_id === "string") {
    const exitCode = findExitCode(payload.output);
    results.push({ recordIndex, itemIndex: 0, timestamp, callId: payload.call_id,
      status: exitCode === null ? "unknown" : exitCode === 0 ? "success" : "failure",
      failureCode: exitCode !== null && exitCode !== 0 ? "nonzero_exit_code" : null });
    extractSkillMarkers(payload.output, recordIndex, 0, timestamp, skillMarkers);
  }
}

function extractClaudeCodeFacts(value: Record<string, unknown>, recordIndex: number, messages: MessageFact[], tokens: TokenUsageFact[], calls: ToolCallFact[], results: ToolResultFact[], compactions: CompactionFact[], skillMarkers: SkillMarkerFact[], turnEvents: TurnEventFact[]): void {
  const timestamp = validTimestamp(value.timestamp);
  if (value.type === "system" && value.subtype === "compact_boundary") {
    const metadata = object(value.compactMetadata);
    const rawTrigger = metadata?.trigger;
    const trigger = rawTrigger === "auto" || rawTrigger === "manual" ? rawTrigger : "unknown";
    compactions.push({ recordIndex, timestamp, trigger, preTokens: integer(metadata?.preTokens), postTokens: integer(metadata?.postTokens) });
  }
  const message = object(value.message);
  if (!message) return;
  const role = typeof message.role === "string" ? message.role : typeof value.type === "string" ? value.type : null;
  const model = typeof message.model === "string" ? message.model : null;
  if ((value.type === "user" || value.type === "assistant") && role) messages.push({ recordIndex, timestamp, role, model });
  if (value.type === "user" && value.isCompactSummary !== true && value.isMeta !== true && isHumanPrompt(message.content)) {
    turnEvents.push({ recordIndex, itemIndex: 0, timestamp, kind: "user_prompt" });
  } else if (value.type === "assistant" && hasVisibleText(message.content)) {
    turnEvents.push({ recordIndex, itemIndex: 0, timestamp, kind: "agent_message" });
  }
  const usage = object(message.usage);
  if (usage) tokens.push(tokenFact(recordIndex, timestamp, model, usage, "claude_code"));
  if (!Array.isArray(message.content)) return;
  message.content.forEach((item, itemIndex) => {
    const block = object(item);
    if (!block) return;
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      calls.push({ recordIndex, itemIndex, timestamp, callId: block.id, toolName: block.name });
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const explicit = typeof block.is_error === "boolean" ? block.is_error : null;
      results.push({ recordIndex, itemIndex, timestamp, callId: block.tool_use_id,
        status: explicit === null ? "unknown" : explicit ? "failure" : "success",
        failureCode: explicit ? "explicit_is_error" : null });
      extractSkillMarkers(block.content, recordIndex, itemIndex, timestamp, skillMarkers);
    }
  });
}

const SKILL_MARKER = /^\[COSPEC:SKILL:(START|END):([A-Za-z0-9][A-Za-z0-9._:-]{0,127}):([A-Za-z0-9]{8})(?::(OK|FAILED|INTERRUPTED|ORPHAN))?\]$/;

function extractSkillMarkers(value: unknown, recordIndex: number, itemIndex: number, timestamp: string | null, facts: SkillMarkerFact[]): void {
  let markerIndex = 0;
  for (const text of nestedStrings(value)) {
    for (const line of text.split(/\r?\n/)) {
      const match = SKILL_MARKER.exec(line.trim());
      if (!match) continue;
      const phase = match[1] === "START" ? "start" : "end";
      const rawStatus = match[4];
      if ((phase === "start" && rawStatus) || (phase === "end" && !rawStatus)) continue;
      facts.push({
        recordIndex, itemIndex, markerIndex, timestamp, phase, skill: match[2]!, executionId: match[3]!,
        status: rawStatus ? rawStatus.toLowerCase() as SkillMarkerFact["status"] : null,
      });
      markerIndex += 1;
    }
  }
}

function nestedStrings(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === "string") return value.length <= 1_000_000 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => nestedStrings(item, depth + 1));
  const record = object(value);
  return record ? Object.values(record).flatMap((item) => nestedStrings(item, depth + 1)) : [];
}

function isHumanPrompt(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    const block = object(item);
    return block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
  }) && !content.some((item) => object(item)?.type === "tool_result");
}

function hasVisibleText(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    const block = object(item);
    return (block?.type === "text" || block?.type === "output_text")
      && typeof block.text === "string" && block.text.trim().length > 0;
  });
}

function tokenFact(recordIndex: number, timestamp: string | null, model: string | null, usage: Record<string, unknown>, source: "codex" | "claude_code"): TokenUsageFact {
  return {
    recordIndex, timestamp, model,
    inputTokens: integer(usage.input_tokens), outputTokens: integer(usage.output_tokens),
    cacheReadInputTokens: integer(source === "codex" ? usage.cached_input_tokens : usage.cache_read_input_tokens),
    cacheWriteOrCreationInputTokens: integer(source === "codex" ? usage.cache_write_input_tokens : usage.cache_creation_input_tokens),
    reasoningOutputTokens: integer(usage.reasoning_output_tokens), reportedTotalTokens: integer(usage.total_tokens),
  };
}

function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function integer(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function validTimestamp(value: unknown): string | null { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null; }

function findExitCode(value: unknown, depth = 0): number | null {
  if (depth > 4) return null;
  const record = object(value);
  if (record) {
    const direct = integer(record.exit_code);
    if (direct !== null) return direct;
    for (const nested of Object.values(record)) { const found = findExitCode(nested, depth + 1); if (found !== null) return found; }
  } else if (Array.isArray(value)) {
    for (const nested of value) { const found = findExitCode(nested, depth + 1); if (found !== null) return found; }
  } else if (typeof value === "string" && value.length <= 1_000_000) {
    try { return findExitCode(JSON.parse(value), depth + 1); } catch { return null; }
  }
  return null;
}
