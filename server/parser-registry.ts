import { PARSER_VERSION, parseCodexJsonl, type ParseResult } from "./parser.js";

export type InstalledParser = (bytes: Buffer) => ParseResult;

export class ParserRegistry {
  private readonly parsers = new Map<string, InstalledParser>();
  constructor(entries: Record<string, InstalledParser> = {
    [PARSER_VERSION]: (bytes) => parseCodexJsonl(bytes, PARSER_VERSION),
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
