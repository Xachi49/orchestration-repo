import type { ArtifactBlobRecord } from "../domain/durability/index.js";

/**
 * Durable artifact bytes. LOCAL FILE PATH != DISTRIBUTED ARTIFACT AUTHORITY.
 *
 * Memory/dev mode may use a filesystem adapter. PostgreSQL mode must not
 * require a process-local path to exist for verification.
 */
export interface ArtifactBlobStore {
  put(input: {
    artifactId: string;
    runId: string;
    projectId: string;
    executionAttemptId: string;
    stepId: string;
    artifactType: string;
    bytes: Uint8Array;
    mediaType?: string;
    createdAt: string;
  }): Promise<ArtifactBlobRecord>;
  get(artifactId: string): Promise<ArtifactBlobRecord | null>;
  getBytes(artifactId: string): Promise<Uint8Array | null>;
}

export interface ArtifactContentReader {
  readUtf8(artifactId: string): Promise<string | null>;
  readBytes(artifactId: string): Promise<Uint8Array | null>;
}
