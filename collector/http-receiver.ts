import type { ChunkMetadata } from "./types.js";
import type { ChunkReceiver } from "./scanner.js";

export interface HttpReceiverOptions {
  baseUrl: string;
  bearerToken: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

export class HttpChunkReceiver implements ChunkReceiver {
  private readonly fetchImplementation: typeof fetch;
  constructor(private readonly options: HttpReceiverOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async accept(metadata: ChunkMetadata, bytes: Buffer): Promise<void> {
    const form = new FormData();
    form.append("metadata", JSON.stringify(metadata));
    form.append("source", new Blob([Uint8Array.from(bytes)], { type: "application/x-ndjson" }), "chunk.jsonl");
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.options.baseUrl.replace(/\/$/, "")}/api/v1/jsonl-chunks`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.bearerToken}` },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Error("upload_timeout");
      throw new Error("upload_network_error", { cause: error });
    }
    if (!response.ok) throw new Error(`upload_http_${response.status}`);
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new Error("invalid_upload_response"); }
    validateAccepted(body, metadata);
  }
}

function validateAccepted(value: unknown, metadata: ChunkMetadata): void {
  if (!value || typeof value !== "object") throw new Error("invalid_upload_response");
  const body = value as Record<string, unknown>;
  const validStatus = body.status === "accepted" || body.status === "already_accepted";
  if (!validStatus || body.upload_id !== metadata.upload_id || body.source_file_id !== metadata.file.source_file_id ||
      body.generation !== metadata.file.generation || body.accepted_start_offset !== metadata.file.start_offset ||
      body.accepted_end_offset !== metadata.file.end_offset || body.next_offset !== metadata.file.end_offset) {
    throw new Error("invalid_upload_response");
  }
}
