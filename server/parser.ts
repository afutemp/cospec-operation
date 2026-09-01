export const PARSER_VERSION = "0.1.0";

const CODEX_KNOWN_TYPES = new Set(["session_meta", "event_msg", "response_item", "turn_context", "compacted"]);
const CLAUDE_CODE_KNOWN_TYPES = new Set(["queue-operation", "user", "assistant", "attachment", "last-prompt", "mode"]);

export interface ParseDiagnostic { line: number; byteOffset: number; code: "invalid_json" }
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
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    totalLines += 1;
    const line = bytes.subarray(lineStart, index).toString("utf8").replace(/\r$/, "");
    try {
      const value = JSON.parse(line) as { type?: unknown; timestamp?: unknown };
      validLines += 1;
      const type = typeof value.type === "string" ? value.type : "<missing>";
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      if (!knownTypes.has(type)) unknownTypeLines += 1;
      if (typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp))) timestamps.push(value.timestamp);
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
    diagnostics,
  };
}
