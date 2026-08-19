import {
  MAX_ARTIFACT_BYTES,
  type ArtifactBlobRecord,
} from "../../domain/durability/index.js";
import { sha256Buffer } from "../../ingestion/hashing.js";
import { DurabilityError } from "../../durability/errors.js";
import { assertProjectScope } from "../../domain/project-scope.js";
import type { ArtifactBlobStore } from "../../durability/artifacts.js";
import type { PostgresDatabase } from "./database.js";

export class PostgresArtifactBlobStore implements ArtifactBlobStore {
  constructor(private readonly db: PostgresDatabase) {}

  async put(input: {
    artifactId: string;
    runId: string;
    projectId: string;
    executionAttemptId: string;
    stepId: string;
    artifactType: string;
    bytes: Uint8Array;
    mediaType?: string;
    createdAt: string;
  }): Promise<ArtifactBlobRecord> {
    if (input.bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new DurabilityError(
        "ARTIFACT_PERSISTENCE_FAILED",
        `Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`,
        { artifactId: input.artifactId, byteSize: input.bytes.byteLength },
      );
    }
    const buffer = Buffer.from(input.bytes);
    const contentHash = sha256Buffer(buffer);
    const mediaType = input.mediaType ?? "application/octet-stream";
    try {
      await this.db.query(
        `INSERT INTO artifact_blobs (
           artifact_id, run_id, project_id, execution_attempt_id, step_id,
           artifact_type, content_hash, byte_size, media_type, content, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
         ON CONFLICT (artifact_id) DO NOTHING`,
        [
          input.artifactId,
          input.runId,
          input.projectId,
          input.executionAttemptId,
          input.stepId,
          input.artifactType,
          contentHash,
          buffer.byteLength,
          mediaType,
          buffer,
          input.createdAt,
        ],
      );
    } catch (error) {
      throw new DurabilityError(
        "ARTIFACT_PERSISTENCE_FAILED",
        error instanceof Error ? error.message : "Artifact persist failed",
        { artifactId: input.artifactId },
      );
    }
    const stored = await this.get(input.artifactId);
    if (!stored) {
      throw new DurabilityError(
        "ARTIFACT_PERSISTENCE_FAILED",
        `Artifact ${input.artifactId} was not stored`,
      );
    }
    return stored;
  }

  async get(artifactId: string): Promise<ArtifactBlobRecord | null> {
    const result = await this.db.query<{
      artifact_id: string;
      run_id: string;
      project_id: string;
      execution_attempt_id: string;
      step_id: string;
      artifact_type: string;
      content_hash: string;
      byte_size: number;
      media_type: string;
      created_at: Date;
    }>(
      `SELECT artifact_id, run_id, project_id, execution_attempt_id, step_id,
              artifact_type, content_hash, byte_size, media_type, created_at
       FROM artifact_blobs WHERE artifact_id = $1`,
      [artifactId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      artifactId: row.artifact_id,
      runId: row.run_id,
      projectId: row.project_id,
      executionAttemptId: row.execution_attempt_id,
      stepId: row.step_id,
      artifactType: row.artifact_type,
      contentHash: row.content_hash,
      byteSize: row.byte_size,
      mediaType: row.media_type,
      createdAt: row.created_at.toISOString(),
    };
  }

  async getBytes(artifactId: string): Promise<Uint8Array | null> {
    const result = await this.db.query<{ content: Buffer }>(
      `SELECT content FROM artifact_blobs WHERE artifact_id = $1`,
      [artifactId],
    );
    const row = result.rows[0];
    return row ? new Uint8Array(row.content) : null;
  }

  async getInProject(
    artifactId: string,
    projectId: string,
  ): Promise<ArtifactBlobRecord | null> {
    const record = await this.get(artifactId);
    if (!record) {
      return null;
    }
    assertProjectScope(record.projectId, projectId, "artifact", artifactId);
    return record;
  }

  async getBytesInProject(
    artifactId: string,
    projectId: string,
  ): Promise<Uint8Array | null> {
    const record = await this.getInProject(artifactId, projectId);
    if (!record) {
      return null;
    }
    return this.getBytes(artifactId);
  }
}
