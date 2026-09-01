import type { ChunkMetadata } from "../collector/types.js";

export interface AcceptedChunk {
  metadata: ChunkMetadata;
  bytes: Buffer;
}

export interface AcceptedResult {
  status: "accepted" | "already_accepted";
  nextOffset: number;
}

export interface ChunkRepository {
  accept(metadata: ChunkMetadata, bytes: Buffer): AcceptedResult | Promise<AcceptedResult>;
}

interface StreamState { nextOffset: number; previousHash: string; chunks: Map<string, AcceptedChunk> }

export class MemoryChunkRepository implements ChunkRepository {
  private readonly streams = new Map<string, StreamState>();
  private readonly uploads = new Map<string, string>();

  accept(metadata: ChunkMetadata, bytes: Buffer): AcceptedResult {
    const key = streamKey(metadata);
    const fingerprint = `${key}:${metadata.file.start_offset}:${metadata.file.end_offset}:${metadata.file.sha256}`;
    const priorUpload = this.uploads.get(metadata.upload_id);
    if (priorUpload && priorUpload !== fingerprint) throw new RepositoryConflict("upload_id_conflict");

    const range = `${metadata.file.start_offset}:${metadata.file.end_offset}`;
    const stream = this.streams.get(key);
    const priorRange = stream?.chunks.get(range);
    if (priorRange) {
      if (priorRange.metadata.file.sha256 !== metadata.file.sha256) throw new RepositoryConflict("offset_conflict");
      this.uploads.set(metadata.upload_id, fingerprint);
      return { status: "already_accepted", nextOffset: priorRange.metadata.file.end_offset };
    }

    if (!stream) {
      if (metadata.file.previous_chunk_sha256 !== null) throw new RepositoryConflict("previous_hash_mismatch");
      this.streams.set(key, {
        nextOffset: metadata.file.end_offset,
        previousHash: metadata.file.sha256,
        chunks: new Map([[range, { metadata, bytes: Buffer.from(bytes) }]]),
      });
    } else {
      if (metadata.file.start_offset < stream.nextOffset) throw new RepositoryConflict("offset_conflict");
      if (metadata.file.start_offset > stream.nextOffset) throw new RepositoryConflict("offset_gap");
      if (metadata.file.previous_chunk_sha256 !== stream.previousHash) throw new RepositoryConflict("previous_hash_mismatch");
      stream.chunks.set(range, { metadata, bytes: Buffer.from(bytes) });
      stream.nextOffset = metadata.file.end_offset;
      stream.previousHash = metadata.file.sha256;
    }
    this.uploads.set(metadata.upload_id, fingerprint);
    return { status: "accepted", nextOffset: metadata.file.end_offset };
  }

  get chunkCount(): number {
    return [...this.streams.values()].reduce((count, stream) => count + stream.chunks.size, 0);
  }
}

export class RepositoryConflict extends Error {}

function streamKey(metadata: ChunkMetadata): string {
  return `${metadata.cospec_run_id}:${metadata.file.source_file_id}:${metadata.file.generation}`;
}
