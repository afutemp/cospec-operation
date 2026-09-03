import type { ArtifactMetadata, ChunkMetadata, RunEvent } from "../collector/types.js";

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
export interface RunEventRepository {
  acceptRunEvent(event: RunEvent): "accepted" | "already_accepted";
  getRunEvents(runId: string): RunEvent[];
}
export interface ArtifactRepository {
  acceptArtifact(metadata: ArtifactMetadata, bytes: Buffer): { status: "accepted" | "already_accepted" } | Promise<{ status: "accepted" | "already_accepted" }>;
  listArtifacts(runId: string): Array<Record<string, unknown>>;
  getArtifact(uploadId: string): { metadata: ArtifactMetadata; bytes: Buffer } | Promise<{ metadata: ArtifactMetadata; bytes: Buffer } | null> | null;
}

interface StreamState { nextOffset: number; previousHash: string; chunks: Map<string, AcceptedChunk> }

export class MemoryChunkRepository implements ChunkRepository, RunEventRepository, ArtifactRepository {
  private readonly streams = new Map<string, StreamState>();
  private readonly uploads = new Map<string, string>();
  private readonly events = new Map<string, RunEvent>();
  private readonly artifacts = new Map<string, { metadata: ArtifactMetadata; bytes: Buffer }>();

  acceptArtifact(metadata: ArtifactMetadata, bytes: Buffer): { status: "accepted" | "already_accepted" } {
    const prior = this.artifacts.get(metadata.upload_id);
    if (prior && JSON.stringify(prior.metadata) !== JSON.stringify(metadata)) throw new RepositoryConflict("upload_id_conflict");
    if (prior) return { status: "already_accepted" };
    const same = [...this.artifacts.values()].find((item) => artifactKey(item.metadata) === artifactKey(metadata));
    if (same && same.metadata.sha256 !== metadata.sha256) throw new RepositoryConflict("artifact_version_conflict");
    if (same) return { status: "already_accepted" };
    this.artifacts.set(metadata.upload_id, { metadata: structuredClone(metadata), bytes: Buffer.from(bytes) });
    return { status: "accepted" };
  }
  listArtifacts(runId: string): Array<Record<string, unknown>> { return [...this.artifacts.values()].filter((item) => item.metadata.cospec_run_id === runId).map((item) => ({ ...item.metadata, status: "uploaded" })); }
  getArtifact(uploadId: string): { metadata: ArtifactMetadata; bytes: Buffer } | null { const item = this.artifacts.get(uploadId); return item ? { metadata: structuredClone(item.metadata), bytes: Buffer.from(item.bytes) } : null; }

  acceptRunEvent(event: RunEvent): "accepted" | "already_accepted" {
    const prior = this.events.get(event.event_id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) throw new RepositoryConflict("event_id_conflict");
    if (prior) return "already_accepted";
    this.events.set(event.event_id, structuredClone(event));
    return "accepted";
  }
  getRunEvents(runId: string): RunEvent[] { return [...this.events.values()].filter((event) => event.cospec_run_id === runId); }

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
function artifactKey(metadata: ArtifactMetadata): string { return `${metadata.cospec_run_id}:${metadata.skill}:${metadata.attempt_id}:${metadata.artifact_index}:${metadata.sha256}`; }
