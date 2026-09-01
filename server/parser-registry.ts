import { PARSER_VERSION, parseSourceJsonl, type ParseResult } from "./parser.js";

export type InstalledParser = (bytes: Buffer, sourceType: "codex_jsonl" | "claude_code_jsonl") => ParseResult;

export class ParserRegistry {
  private readonly parsers = new Map<string, InstalledParser>();
  constructor(entries: Record<string, InstalledParser> = {
    [PARSER_VERSION]: (bytes, sourceType) => parseSourceJsonl(bytes, sourceType, PARSER_VERSION),
  }) {
    for (const [version, parser] of Object.entries(entries)) this.parsers.set(version, parser);
  }
  get(version: string): InstalledParser {
    const parser = this.parsers.get(version);
    if (!parser) throw new Error("parser_version_not_installed");
    return parser;
  }
  versions(): string[] { return [...this.parsers.keys()].sort(); }
}
