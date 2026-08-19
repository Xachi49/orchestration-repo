import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionArtifact } from "../domain/execution/index.js";
import type { ExecutionArtifactRepository } from "../execution/artifact-repository.js";
import type { ArtifactBlobStore } from "../durability/artifacts.js";
import { artifactRootFor } from "../execution/paths.js";
import { resolveContained } from "../ingestion/workspace-paths.js";
import { sha256Buffer } from "../ingestion/hashing.js";
import type { VerificationFinding } from "../domain/verification/index.js";
import type { VerificationIdentityGenerator } from "./identity.js";

export type VerificationArtifactSource = "BLOB" | "LOCAL_FILE";

export interface VerificationArtifactBytes {
  bytes: Uint8Array;
  source: VerificationArtifactSource;
}

export interface ReadVerificationArtifactInput {
  artifactId: string;
  relativePath: string;
  runId: string;
  dataRoot: string;
  blobStore?: ArtifactBlobStore;
}

/**
 * Canonical artifact body for verification: durable blob first, local path second.
 * LOCAL FILE PATH != DISTRIBUTED ARTIFACT AUTHORITY.
 */
export async function readVerificationArtifactBytes(
  input: ReadVerificationArtifactInput,
): Promise<VerificationArtifactBytes | null> {
  if (input.blobStore) {
    const bytes = await input.blobStore.getBytes(input.artifactId);
    if (bytes) {
      return { bytes, source: "BLOB" };
    }
  }
  try {
    const root = artifactRootFor(input.dataRoot, input.runId);
    const absolute = resolveContained(root, input.relativePath);
    const buf = await readFile(absolute);
    return { bytes: new Uint8Array(buf), source: "LOCAL_FILE" };
  } catch {
    return null;
  }
}

export function utf8FromVerificationBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

export async function readVerificationArtifactUtf8(
  input: ReadVerificationArtifactInput,
): Promise<string | null> {
  const body = await readVerificationArtifactBytes(input);
  return body ? utf8FromVerificationBytes(body.bytes) : null;
}

const BYTE_SIZED_ARTIFACT_TYPES = new Set([
  "PATCH",
  "PR_PREPARATION",
  "ROLLBACK",
  "OTHER",
]);

export interface ArtifactVerificationOutcome {
  ok: boolean;
  findings: VerificationFinding[];
  recomputedHashes: ReadonlyMap<string, string>;
}

/**
 * Independently recompute artifact hashes from durable bytes (or local fallback).
 * Do not trust persisted hashes without recomputation.
 */
export class ExecutionArtifactVerifier {
  constructor(
    private readonly artifacts: ExecutionArtifactRepository,
    private readonly dataRoot: string,
    private readonly identities: VerificationIdentityGenerator,
    private readonly blobStore?: ArtifactBlobStore,
  ) {}

  async verify(input: {
    runId: string;
    executionAttemptId: string;
    artifactIds: readonly string[];
  }): Promise<ArtifactVerificationOutcome> {
    const findings: VerificationFinding[] = [];
    const recomputedHashes = new Map<string, string>();

    for (const artifactId of input.artifactIds) {
      const meta = await this.artifacts.getById(artifactId);
      if (!meta) {
        findings.push(this.finding({
          ruleId: "VERIFICATION_ARTIFACT_MISSING",
          message: `Artifact metadata missing: ${artifactId}`,
          category: "ARTIFACT_INTEGRITY",
          severity: "CRITICAL",
          blocksVerifiedSuccess: true,
          metadata: { artifactId },
        }));
        continue;
      }

      const identityIssues = this.checkIdentity(meta, input);
      findings.push(...identityIssues);
      if (identityIssues.length > 0) {
        continue;
      }

      try {
        resolveContained(
          artifactRootFor(this.dataRoot, input.runId),
          meta.relativePath,
        );
      } catch {
        findings.push(this.finding({
          ruleId: "VERIFICATION_ARTIFACT_MISSING",
          message: `Artifact path escapes artifact root: ${meta.relativePath}`,
          category: "ARTIFACT_INTEGRITY",
          severity: "CRITICAL",
          blocksVerifiedSuccess: true,
          stepIds: [meta.stepId],
          metadata: { artifactId, relativePath: meta.relativePath },
        }));
        continue;
      }

      const body = await readVerificationArtifactBytes({
        artifactId,
        relativePath: meta.relativePath,
        runId: input.runId,
        dataRoot: this.dataRoot,
        ...(this.blobStore !== undefined ? { blobStore: this.blobStore } : {}),
      });
      if (body === null) {
        findings.push(this.finding({
          ruleId: "VERIFICATION_ARTIFACT_MISSING",
          message: `Artifact bytes missing for ${artifactId}`,
          category: "ARTIFACT_INTEGRITY",
          severity: "CRITICAL",
          blocksVerifiedSuccess: true,
          stepIds: [meta.stepId],
          metadata: { artifactId },
        }));
        continue;
      }

      const observedSize = body.bytes.byteLength;
      const hash = sha256Buffer(Buffer.from(body.bytes));
      recomputedHashes.set(artifactId, hash);
      if (hash !== meta.contentHash) {
        findings.push(this.finding({
          ruleId: "VERIFICATION_ARTIFACT_HASH_MISMATCH",
          message: `Artifact content hash mismatch for ${artifactId}`,
          category: "ARTIFACT_INTEGRITY",
          severity: "CRITICAL",
          blocksVerifiedSuccess: true,
          stepIds: [meta.stepId],
          metadata: {
            artifactId,
            expectedHash: meta.contentHash,
            recomputedHash: hash,
          },
        }));
      }

      if (this.blobStore) {
        const blob = await this.blobStore.get(artifactId);
        if (blob) {
          if (blob.byteSize !== observedSize) {
            findings.push(this.finding({
              ruleId: "VERIFICATION_ARTIFACT_HASH_MISMATCH",
              message: `Artifact blob byteSize mismatch for ${artifactId}`,
              category: "ARTIFACT_INTEGRITY",
              severity: "ERROR",
              blocksVerifiedSuccess: true,
              stepIds: [meta.stepId],
              metadata: {
                artifactId,
                expectedSize: blob.byteSize,
                observedSize,
              },
            }));
          }
          if (blob.contentHash !== hash) {
            findings.push(this.finding({
              ruleId: "VERIFICATION_ARTIFACT_HASH_MISMATCH",
              message: `Artifact blob content hash mismatch for ${artifactId}`,
              category: "ARTIFACT_INTEGRITY",
              severity: "CRITICAL",
              blocksVerifiedSuccess: true,
              stepIds: [meta.stepId],
              metadata: {
                artifactId,
                expectedHash: blob.contentHash,
                recomputedHash: hash,
              },
            }));
          }
        }
      }

      // TEST_RESULT / TASK metadata.size is summary/description length, not file bytes.
      if (
        BYTE_SIZED_ARTIFACT_TYPES.has(meta.artifactType) &&
        observedSize !== meta.size
      ) {
        findings.push(this.finding({
          ruleId: "VERIFICATION_ARTIFACT_HASH_MISMATCH",
          message: `Artifact size mismatch for ${artifactId}`,
          category: "ARTIFACT_INTEGRITY",
          severity: "ERROR",
          blocksVerifiedSuccess: true,
          stepIds: [meta.stepId],
          metadata: {
            artifactId,
            expectedSize: meta.size,
            observedSize,
          },
        }));
      }

      if (path.isAbsolute(meta.relativePath) || meta.relativePath.includes("..")) {
        findings.push(this.finding({
          ruleId: "VERIFICATION_SCOPE_VIOLATION",
          message: `Unsafe artifact relative path: ${meta.relativePath}`,
          category: "BOUNDARY",
          severity: "CRITICAL",
          blocksVerifiedSuccess: true,
          stepIds: [meta.stepId],
        }));
      }
    }

    return {
      ok: findings.every((f) => !f.blocksVerifiedSuccess),
      findings,
      recomputedHashes,
    };
  }

  private checkIdentity(
    meta: ExecutionArtifact,
    input: { runId: string; executionAttemptId: string },
  ): VerificationFinding[] {
    const findings: VerificationFinding[] = [];
    if (
      meta.runId !== input.runId ||
      meta.executionAttemptId !== input.executionAttemptId
    ) {
      findings.push(this.finding({
        ruleId: "VERIFICATION_ARTIFACT_IDENTITY_MISMATCH",
        message: `Artifact ${meta.artifactId} identity mismatch`,
        category: "ARTIFACT_INTEGRITY",
        severity: "CRITICAL",
        blocksVerifiedSuccess: true,
        stepIds: [meta.stepId],
        metadata: {
          artifactId: meta.artifactId,
          expectedRunId: input.runId,
          observedRunId: meta.runId,
          expectedAttemptId: input.executionAttemptId,
          observedAttemptId: meta.executionAttemptId,
        },
      }));
    }
    return findings;
  }

  private finding(input: {
    ruleId: string;
    message: string;
    category: VerificationFinding["category"];
    severity: VerificationFinding["severity"];
    blocksVerifiedSuccess: boolean;
    stepIds?: string[];
    metadata?: Record<string, unknown>;
  }): VerificationFinding {
    return {
      findingId: this.identities.nextFindingId(),
      category: input.category,
      severity: input.severity,
      ruleId: input.ruleId,
      message: input.message,
      criterionIds: [],
      stepIds: input.stepIds ?? [],
      evidenceRefs: [],
      blocksVerifiedSuccess: input.blocksVerifiedSuccess,
      metadata: input.metadata ?? {},
    };
  }
}
