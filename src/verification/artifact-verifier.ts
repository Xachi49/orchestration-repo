import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ExecutionArtifact } from "../domain/execution/index.js";
import type { ExecutionArtifactRepository } from "../execution/artifact-repository.js";
import { artifactRootFor } from "../execution/paths.js";
import { resolveContained } from "../ingestion/workspace-paths.js";
import { sha256Text } from "../ingestion/hashing.js";
import type { VerificationFinding } from "../domain/verification/index.js";
import type { VerificationIdentityGenerator } from "./identity.js";

export interface ArtifactVerificationOutcome {
  ok: boolean;
  findings: VerificationFinding[];
  recomputedHashes: ReadonlyMap<string, string>;
}

/**
 * Independently recompute artifact hashes from disk under dataRoot.
 * Do not trust persisted hashes without recomputation.
 */
export class ExecutionArtifactVerifier {
  constructor(
    private readonly artifacts: ExecutionArtifactRepository,
    private readonly dataRoot: string,
    private readonly identities: VerificationIdentityGenerator,
  ) {}

  async verify(input: {
    runId: string;
    executionAttemptId: string;
    artifactIds: readonly string[];
  }): Promise<ArtifactVerificationOutcome> {
    const findings: VerificationFinding[] = [];
    const recomputedHashes = new Map<string, string>();
    const root = artifactRootFor(this.dataRoot, input.runId);

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

      let absolute: string;
      try {
        absolute = resolveContained(root, meta.relativePath);
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

      let content: string;
      try {
        content = await readFile(absolute, "utf8");
      } catch {
        findings.push(this.finding({
          ruleId: "VERIFICATION_ARTIFACT_MISSING",
          message: `Artifact file missing on disk: ${meta.relativePath}`,
          category: "ARTIFACT_INTEGRITY",
          severity: "CRITICAL",
          blocksVerifiedSuccess: true,
          stepIds: [meta.stepId],
          metadata: { artifactId },
        }));
        continue;
      }

      const hash = sha256Text(content);
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

      try {
        const st = await stat(absolute);
        const byteSizedTypes = new Set([
          "PATCH",
          "PR_PREPARATION",
          "ROLLBACK",
          "OTHER",
        ]);
        // Phase 7 stores summary/description lengths for TEST_RESULT and TASK,
        // not on-disk byte size. Only enforce size for byte-oriented artifacts.
        if (byteSizedTypes.has(meta.artifactType) && st.size !== meta.size) {
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
              observedSize: st.size,
            },
          }));
        }
      } catch {
        // size check optional if stat fails after read succeeded
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
