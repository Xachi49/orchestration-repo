import { assertTransition } from "../domain/run/run-state.js";
import { commitRunTransition } from "../admission/run-transition.js";
import type { RunRepository } from "../admission/run-repository.js";
import type { ControlPlaneService } from "../control-plane/index.js";
import type { ProjectControlContext } from "../control-plane/index.js";
import type { ControlPlaneClock } from "../control-plane/service.js";
import {
  parseGitHubRemoteUrl,
  type RepositoryIdentity,
  type RepositorySource,
  type RepositorySourceRegistry,
} from "./repository-source.js";
import { IngestionError, isIngestionError } from "./errors.js";
import {
  SNAPSHOT_VERSION,
  type CommitSha,
  type RemoteRepositoryService,
  type RemoteRepositorySnapshot,
} from "./remote-repository.js";
import type { LockedRepositoryState, LockedRepositoryStore } from "./locked-state.js";
import type { RepositoryWorkspaceService } from "./workspace.js";
import type {
  ProjectIndex,
  ProjectIndexer,
  RepositoryFingerprintService,
  RepositoryIndexStore,
} from "./index-model.js";
import { INDEX_VERSION } from "./index-model.js";
import { DEFAULT_INDEX_CONFIGURATION_FINGERPRINT } from "./index-configuration.js";
import type {
  EvidenceRegistry,
  VerifiedRepositoryContext,
  VerifiedRepositoryContextStore,
} from "./context.js";
import { CONTEXT_SCHEMA_VERSION } from "./index-model.js";
import { hashCanonical, posixRelative } from "./hashing.js";
import { evidenceIdFor } from "./evidence-ids.js";
import { compareLockedToRemote, type DriftResult } from "./drift.js";
import { parseEvidenceRecord } from "../domain/evidence/evidence.js";
import type { RepositoryIngestionCoordinator } from "./coordinator.js";

export interface RepositoryTruthServiceDeps {
  runs: RunRepository;
  controlPlane: ControlPlaneService;
  sources: RepositorySourceRegistry;
  remote: RemoteRepositoryService;
  locks: LockedRepositoryStore;
  workspace: RepositoryWorkspaceService;
  indexer: ProjectIndexer;
  fingerprints: RepositoryFingerprintService;
  indexStore: RepositoryIndexStore;
  evidence: EvidenceRegistry;
  contexts: VerifiedRepositoryContextStore;
  coordinator: RepositoryIngestionCoordinator;
  clock: ControlPlaneClock;
  indexConfigurationFingerprint?: string;
}

function snapshotHashOf(snapshot: RemoteRepositorySnapshot): string {
  const { observedAt: _observedAt, ...rest } = snapshot;
  return hashCanonical(rest);
}

/**
 * Establishes immutable, evidence-backed repository truth for an admitted run.
 * Does not plan, approve, or execute. Does not replace a locked SHA.
 */
export class RepositoryTruthService {
  constructor(private readonly deps: RepositoryTruthServiceDeps) {}

  async ingest(
    runId: string,
    projectId: string,
    requestedEnvironment: string,
  ): Promise<VerifiedRepositoryContext> {
    const run = await this.deps.runs.getById(runId);
    if (!run || run.projectId !== projectId) {
      throw new IngestionError(
        "INVALID_INGESTION_STATE",
        `Run ${runId} is not eligible for ingestion`,
        { runId, projectId },
      );
    }
    if (run.requestedEnvironment !== requestedEnvironment) {
      throw new IngestionError(
        "INVALID_INGESTION_STATE",
        "requestedEnvironment does not match the admitted run",
        { runId, requestedEnvironment },
      );
    }
    if (run.state !== "ADMITTED" && run.state !== "INGESTING") {
      throw new IngestionError(
        "INVALID_INGESTION_STATE",
        `Run ${runId} is in ${run.state}, not ADMITTED/INGESTING`,
        { runId, state: run.state },
      );
    }

    const now = this.deps.clock.nowIso();
    const existing = await this.deps.contexts.getByRunId(runId);
    if (existing?.status === "VERIFIED") {
      await this.deps.coordinator.reconcileVerified(runId, now);
      return existing;
    }

    const begin = await this.deps.coordinator.begin(runId, now);
    if (begin.outcome === "ALREADY_VERIFIED") {
      const verified = await this.deps.contexts.getByRunId(runId);
      if (verified?.status === "VERIFIED") {
        return verified;
      }
      throw new IngestionError(
        "INVALID_INGESTION_STATE",
        "Ingestion fence is VERIFIED but no verified context exists",
        { runId },
      );
    }

    try {
      const controlContext = await this.deps.controlPlane.resolve(
        projectId,
        requestedEnvironment,
      );
      const source = await this.resolveSource(projectId, controlContext);
      const existingLock = await this.deps.locks.getByRunId(runId);
      const identity: RepositoryIdentity = {
        provider: source.provider,
        owner: source.owner,
        repository: source.repository,
      };
      const ref = { owner: source.owner, repository: source.repository };

      const snapshot = await this.buildSnapshot({
        projectId,
        source,
        identity,
        ref,
        existingLock,
        now,
      });
      const snapshotHash = snapshotHashOf(snapshot);

      let locked = existingLock;
      if (locked) {
        if (
          locked.commitSha.toLowerCase() !==
          snapshot.resolvedCommitSha.toLowerCase()
        ) {
          throw new IngestionError(
            "LOCKED_SHA_MISMATCH",
            "Locked commit SHA cannot be replaced by a newer branch head",
            {
              lockedSha: locked.commitSha,
              resolvedSha: snapshot.resolvedCommitSha,
            },
          );
        }
      } else {
        locked = await this.deps.locks.save({
          runId,
          projectId,
          repositoryIdentity: identity,
          branch: snapshot.requestedBranch,
          commitSha: snapshot.resolvedCommitSha,
          lockedAt: now,
          remoteSnapshotHash: snapshotHash,
          status: "LOCKED",
        });
      }

      if (run.state === "ADMITTED") {
        const next = assertTransition(run.state, "INGESTING");
        await commitRunTransition(
          this.deps.runs,
          run,
          next,
          now,
        );
      }

      const projectIndex = await this.materializeIndex(
        runId,
        source.remoteUrl,
        identity,
        locked.commitSha,
      );

      const evidenceIds = await this.persistEvidence({
        runId,
        projectId,
        lockedSha: locked.commitSha,
        identityLabel: `${identity.owner}/${identity.repository}@${locked.commitSha}`,
        snapshotHash,
        projectIndex,
        now,
      });

      const verifiedLock = await this.deps.locks.save({
        ...locked,
        status: "VERIFIED",
      });

      const context: VerifiedRepositoryContext = {
        schemaVersion: CONTEXT_SCHEMA_VERSION,
        status: "VERIFIED",
        runId,
        projectId,
        environment: requestedEnvironment,
        lockedRepository: verifiedLock,
        remoteSnapshot: snapshot,
        repositoryFingerprint: projectIndex.repositoryFingerprint,
        projectIndex,
        evidenceIds,
        observedAt: now,
        verifiedAt: now,
      };
      const saved = await this.deps.contexts.save(context);
      await this.deps.coordinator.markVerified(runId, begin.ownerToken, now);
      return saved;
    } catch (error) {
      await this.deps.workspace.removeWorkspace(runId).catch(() => undefined);
      const failureCode = isIngestionError(error)
        ? error.code
        : "INDEXING_FAILED";
      await this.deps.coordinator
        .markFailed(runId, begin.ownerToken, {
          failureCode,
          failedAt: this.deps.clock.nowIso(),
          retryable: true,
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async getContext(runId: string): Promise<VerifiedRepositoryContext | null> {
    const context = await this.deps.contexts.getByRunId(runId);
    if (!context || context.status !== "VERIFIED") {
      return null;
    }
    return context;
  }

  async detectDrift(runId: string): Promise<DriftResult> {
    const locked = await this.deps.locks.getByRunId(runId);
    if (!locked) {
      return { result: "INVALID_STATE", reason: "no locked repository state" };
    }
    try {
      const remoteSha = await this.deps.remote.resolveBranchHead(
        {
          owner: locked.repositoryIdentity.owner,
          repository: locked.repositoryIdentity.repository,
        },
        locked.branch,
      );
      const drift = compareLockedToRemote(locked.commitSha, remoteSha);
      if (drift.result === "DRIFT_DETECTED") {
        await this.deps.locks.save({ ...locked, status: "STALE" });
      }
      return drift;
    } catch {
      return { result: "REMOTE_UNAVAILABLE", lockedSha: locked.commitSha };
    }
  }

  private indexConfigFingerprint(): string {
    return (
      this.deps.indexConfigurationFingerprint ??
      DEFAULT_INDEX_CONFIGURATION_FINGERPRINT
    );
  }

  private async buildSnapshot(input: {
    projectId: string;
    source: RepositorySource;
    identity: RepositoryIdentity;
    ref: { owner: string; repository: string };
    existingLock: LockedRepositoryState | null;
    now: string;
  }): Promise<RemoteRepositorySnapshot> {
    try {
      const metadata = await this.deps.remote.getRepositoryMetadata(input.ref);
      const branch = input.source.defaultBranch || metadata.defaultBranch;
      const sha: CommitSha = input.existingLock
        ? input.existingLock.commitSha
        : await this.deps.remote.resolveBranchHead(input.ref, branch);
      const commit = await this.deps.remote.getCommitMetadata(input.ref, sha);
      const [prs, issues, ci] = await Promise.all([
        this.deps.remote.getPullRequestMetadata(input.ref),
        this.deps.remote.getIssueMetadata(input.ref),
        this.deps.remote.getCiStatus(input.ref, sha),
      ]);
      return {
        projectId: input.projectId,
        provider: "GITHUB",
        repositoryIdentity: input.identity,
        requestedBranch: branch,
        resolvedCommitSha: sha,
        commitMetadata: commit,
        openPullRequests: [...prs],
        relevantIssues: [...issues],
        ciStatus: ci,
        observedAt: input.now,
        snapshotVersion: SNAPSHOT_VERSION,
      };
    } catch (error) {
      if (isIngestionError(error)) {
        throw error;
      }
      throw new IngestionError(
        "REMOTE_REPOSITORY_UNAVAILABLE",
        "Failed to resolve remote repository truth",
        { cause: String(error) },
      );
    }
  }

  private async materializeIndex(
    runId: string,
    remoteUrl: string,
    repositoryIdentity: RepositoryIdentity,
    commitSha: CommitSha,
  ): Promise<ProjectIndex> {
    const indexConfigurationFingerprint = this.indexConfigFingerprint();
    const cacheKey = {
      repositoryIdentity,
      commitSha,
      indexVersion: INDEX_VERSION,
      indexConfigurationFingerprint,
    };
    const cached = await this.deps.indexStore.get(cacheKey);

    try {
      const prepared = await this.deps.workspace.prepareWorkspace(
        runId,
        remoteUrl,
      );
      await this.deps.workspace.fetchRemote(prepared);
      await this.deps.workspace.checkoutDetachedCommit(prepared, commitSha);
      const head = await this.deps.workspace.verifyHead(prepared, commitSha);
      if (!head.matchesLockedSha) {
        throw new IngestionError(
          "LOCKED_SHA_MISMATCH",
          "Workspace HEAD does not match locked SHA",
          { headSha: head.headSha, lockedSha: commitSha },
        );
      }

      if (cached) {
        return cached;
      }

      const relativePaths = await this.deps.workspace.listFiles(prepared);
      const files = [];
      for (const relativePath of relativePaths) {
        const normalized = posixRelative(relativePath);
        if (normalized.includes("..") || normalized.startsWith("/")) {
          throw new IngestionError(
            "WORKSPACE_PATH_VIOLATION",
            `Path escapes workspace: ${relativePath}`,
          );
        }
        const content = await this.deps.workspace.readFile(
          prepared,
          normalized,
        );
        files.push({ relativePath: normalized, content });
      }

      let indexed: ProjectIndex;
      try {
        indexed = this.deps.indexer.index({
          commitSha,
          repositoryIdentity,
          files,
          repositoryFingerprint: "pending",
          indexConfigurationFingerprint,
        });
      } catch (error) {
        throw new IngestionError(
          "INDEXING_FAILED",
          "Deterministic project indexing failed",
          { cause: String(error) },
        );
      }

      let fingerprint: string;
      try {
        fingerprint = this.deps.fingerprints.fingerprint({
          commitSha,
          lockfileHashes: indexed.fileManifest.entries
            .filter((entry) => entry.classification === "LOCKFILE")
            .map((entry) => ({
              path: entry.relativePath,
              hash: entry.contentHash,
            })),
          configHashes: indexed.fileManifest.entries
            .filter(
              (entry) =>
                entry.classification === "CONFIG" ||
                entry.classification === "DEPENDENCY_MANIFEST",
            )
            .map((entry) => ({
              path: entry.relativePath,
              hash: entry.contentHash,
            })),
          manifestHash: indexed.fileManifest.manifestHash,
        });
      } catch (error) {
        throw new IngestionError(
          "REPOSITORY_FINGERPRINT_FAILED",
          "Repository fingerprint failed",
          { cause: String(error) },
        );
      }

      return this.deps.indexStore.save({
        ...indexed,
        repositoryFingerprint: fingerprint,
      });
    } catch (error) {
      if (isIngestionError(error)) {
        throw error;
      }
      throw new IngestionError(
        "WORKSPACE_PREPARATION_FAILED",
        "Immutable workspace preparation failed",
        { cause: String(error) },
      );
    }
  }

  private async persistEvidence(input: {
    runId: string;
    projectId: string;
    lockedSha: CommitSha;
    identityLabel: string;
    snapshotHash: string;
    projectIndex: ProjectIndex;
    now: string;
  }): Promise<string[]> {
    const evidenceIds: string[] = [];
    try {
      const remoteEvidence = parseEvidenceRecord({
        evidenceId: evidenceIdFor({
          runId: input.runId,
          sourceType: "REMOTE_SNAPSHOT",
          sourceIdentifier: input.identityLabel,
          contentHash: input.snapshotHash,
        }),
        sourceType: "REMOTE_SNAPSHOT",
        sourceIdentifier: input.identityLabel,
        contentHash: input.snapshotHash,
        trustLevel: "REMOTE_VERIFIED",
        observedAt: input.now,
        summary: `Remote snapshot at ${input.lockedSha}`,
        runId: input.runId,
        projectId: input.projectId,
        commitSha: input.lockedSha,
      });
      await this.deps.evidence.put(remoteEvidence);
      evidenceIds.push(remoteEvidence.evidenceId);

      for (const entry of input.projectIndex.fileManifest.entries) {
        const record = parseEvidenceRecord({
          evidenceId: evidenceIdFor({
            runId: input.runId,
            sourceType: "WORKSPACE_FILE",
            sourceIdentifier: entry.relativePath,
            contentHash: entry.contentHash,
          }),
          sourceType: "WORKSPACE_FILE",
          sourcePath: entry.relativePath,
          contentHash: entry.contentHash,
          trustLevel: "LOCAL_VERIFIED",
          observedAt: input.now,
          summary: `Workspace file ${entry.relativePath}`,
          runId: input.runId,
          projectId: input.projectId,
          commitSha: input.lockedSha,
          metadata: {
            classification: entry.classification,
            binary: entry.binary,
          },
        });
        await this.deps.evidence.put(record);
        evidenceIds.push(record.evidenceId);
      }
      return evidenceIds;
    } catch (error) {
      if (isIngestionError(error)) {
        throw error;
      }
      throw new IngestionError(
        "EVIDENCE_PERSISTENCE_FAILED",
        "Failed to persist repository evidence",
        { cause: String(error) },
      );
    }
  }

  private async resolveSource(
    projectId: string,
    controlContext: ProjectControlContext,
  ): Promise<RepositorySource> {
    const registered = await this.deps.sources.getByProjectId(projectId);
    if (registered && !registered.enabled) {
      throw new IngestionError(
        "REPOSITORY_NOT_CONFIGURED",
        `Repository source is disabled for project ${projectId}`,
        { projectId },
      );
    }
    if (registered) {
      return registered;
    }

    const parsed = parseGitHubRemoteUrl(
      controlContext.project.repositoryUrl,
    );
    if (!parsed) {
      throw new IngestionError(
        "REPOSITORY_NOT_CONFIGURED",
        `No enabled GitHub repository source for project ${projectId}`,
        { projectId },
      );
    }
    const now = this.deps.clock.nowIso();
    return {
      projectId,
      provider: "GITHUB",
      owner: parsed.owner,
      repository: parsed.repository,
      defaultBranch: controlContext.project.defaultBranch,
      remoteUrl: controlContext.project.repositoryUrl,
      enabled: true,
      createdAt: controlContext.project.createdAt,
      updatedAt: now,
    };
  }
}

export { parseGitHubRemoteUrl };
