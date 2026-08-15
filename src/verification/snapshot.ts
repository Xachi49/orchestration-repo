import {
  parsePostExecutionSnapshot,
  type PostExecutionSnapshot,
} from "../domain/verification/index.js";
import type { ExecutionResult } from "../domain/execution/index.js";
import type { ExecutionService } from "../execution/service.js";
import type { StepExecutionRepository } from "../execution/step-repository.js";
import type { ExecutionArtifactRepository } from "../execution/artifact-repository.js";
import type { EventStore } from "../admission/event-store.js";
import {
  canonicalizeValue,
  sha256Text,
} from "../ingestion/hashing.js";
import { fingerprintValue } from "../execution/idempotency.js";

export interface PostExecutionTruthServiceDeps {
  execution: ExecutionService;
  steps: StepExecutionRepository;
  artifacts: ExecutionArtifactRepository;
  events?: EventStore;
}

/**
 * Independently reconstructs observable post-execution truth from stores.
 * Does not trust ExecutionResult serialization as sole truth.
 */
export class PostExecutionTruthService {
  constructor(private readonly deps: PostExecutionTruthServiceDeps) {}

  async capture(input: {
    runId: string;
    result: ExecutionResult;
    nowIso: string;
  }): Promise<PostExecutionSnapshot> {
    const { runId, result, nowIso } = input;
    const snapshot = this.deps.execution.getAuthoritySnapshot(
      result.executionAttemptId,
    );
    if (!snapshot) {
      throw new Error("ExecutionAuthoritySnapshot required for snapshot");
    }

    const steps = await this.deps.steps.listByExecutionAttempt(
      result.executionAttemptId,
    );
    const artifacts = await this.deps.artifacts.listByAttempt(
      result.executionAttemptId,
    );

    const stepPayload = steps.map((s) => ({
      stepId: s.stepId,
      idempotencyKey: s.idempotencyKey,
      capabilityId: s.capabilityId,
      actionType: s.actionType,
      status: s.status,
      outputArtifactRefs: [...s.outputArtifactRefs].sort(),
      outputHashes: [...s.outputHashes].sort(),
      affectedTargets: [...s.affectedTargets].sort(),
      errorCode: s.errorCode ?? null,
      executionAttemptId: s.executionAttemptId,
      runId: s.runId,
    }));

    const artifactPayload = artifacts.map((a) => ({
      artifactId: a.artifactId,
      runId: a.runId,
      executionAttemptId: a.executionAttemptId,
      stepId: a.stepId,
      artifactType: a.artifactType,
      relativePath: a.relativePath,
      contentHash: a.contentHash,
      size: a.size,
    }));

    const resourcePayload = {
      stepCount: steps.length,
      succeeded: steps.filter((s) => s.status === "SUCCEEDED").length,
      failed: steps.filter((s) => s.status === "FAILED").length,
      artifactBytes: artifacts.reduce((sum, a) => sum + a.size, 0),
      artifactCount: artifacts.length,
      resultStatus: result.status,
      containmentRequired: result.containmentRequired,
    };

    let auditEventFingerprint = fingerprintValue([]);
    if (this.deps.events) {
      const events = await this.deps.events.listByRunId(runId);
      auditEventFingerprint = fingerprintValue(
        events.map((e) => ({
          eventType: e.eventType,
          idempotencyKey: e.idempotencyKey,
          runId: e.runId,
        })),
      );
    }

    return parsePostExecutionSnapshot({
      runId,
      executionAttemptId: result.executionAttemptId,
      planId: result.planId,
      planVersion: result.planVersion,
      planHash: result.planHash,
      authorizationRecordId: result.authorizationRecordId,
      executionAuthoritySnapshotId: snapshot.authoritySnapshotId,
      stepResultFingerprint: fingerprintValue(stepPayload),
      artifactManifestFingerprint: fingerprintValue(artifactPayload),
      resourceLedgerFingerprint: fingerprintValue(resourcePayload),
      auditEventFingerprint,
      executionResultStatus: result.status,
      containmentRequired: result.containmentRequired,
      observedAt: nowIso,
    });
  }
}

/**
 * Canonical hash of post-execution snapshot authority-bearing fields.
 * Excludes timestamps, display text, and absolute machine paths.
 */
export class PostExecutionSnapshotHasher {
  hash(snapshot: PostExecutionSnapshot): string {
    const payload = {
      runId: snapshot.runId,
      executionAttemptId: snapshot.executionAttemptId,
      planId: snapshot.planId,
      planVersion: snapshot.planVersion,
      planHash: snapshot.planHash,
      authorizationRecordId: snapshot.authorizationRecordId,
      executionAuthoritySnapshotId: snapshot.executionAuthoritySnapshotId,
      stepResultFingerprint: snapshot.stepResultFingerprint,
      artifactManifestFingerprint: snapshot.artifactManifestFingerprint,
      resourceLedgerFingerprint: snapshot.resourceLedgerFingerprint,
      auditEventFingerprint: snapshot.auditEventFingerprint,
      workspaceObservationFingerprint:
        snapshot.workspaceObservationFingerprint ?? null,
      executionResultStatus: snapshot.executionResultStatus,
      containmentRequired: snapshot.containmentRequired,
    };
    return sha256Text(JSON.stringify(canonicalizeValue(payload)));
  }
}
