import {
  parseVerificationEvidence,
  type VerificationEvidence,
} from "../domain/verification/index.js";

export interface VerificationEvidenceRepository {
  save(evidence: VerificationEvidence): Promise<VerificationEvidence>;
  getById(evidenceId: string): Promise<VerificationEvidence | null>;
  listByRun(runId: string): Promise<readonly VerificationEvidence[]>;
  listByExecutionAttempt(
    executionAttemptId: string,
  ): Promise<readonly VerificationEvidence[]>;
  listByCriterion(
    criterionId: string,
  ): Promise<readonly VerificationEvidence[]>;
  exists(evidenceId: string): Promise<boolean>;
}

/**
 * Append-only in-memory evidence store. Existing evidenceIds cannot be mutated.
 */
export class InMemoryVerificationEvidenceRepository
  implements VerificationEvidenceRepository
{
  private readonly byId = new Map<string, VerificationEvidence>();
  private readonly byRun = new Map<string, string[]>();
  private readonly byAttempt = new Map<string, string[]>();
  private readonly byCriterion = new Map<string, string[]>();

  async save(evidence: VerificationEvidence): Promise<VerificationEvidence> {
    const parsed = parseVerificationEvidence(evidence);
    if (this.byId.has(parsed.evidenceId)) {
      throw new Error(
        `Verification evidence already exists: ${parsed.evidenceId}`,
      );
    }
    this.byId.set(parsed.evidenceId, Object.freeze(parsed));
    const runOrder = this.byRun.get(parsed.runId) ?? [];
    runOrder.push(parsed.evidenceId);
    this.byRun.set(parsed.runId, runOrder);
    const attemptOrder =
      this.byAttempt.get(parsed.executionAttemptId) ?? [];
    attemptOrder.push(parsed.evidenceId);
    this.byAttempt.set(parsed.executionAttemptId, attemptOrder);
    for (const criterionId of parsed.criterionIds) {
      const criterionOrder = this.byCriterion.get(criterionId) ?? [];
      criterionOrder.push(parsed.evidenceId);
      this.byCriterion.set(criterionId, criterionOrder);
    }
    return parsed;
  }

  async getById(evidenceId: string): Promise<VerificationEvidence | null> {
    return this.byId.get(evidenceId) ?? null;
  }

  async listByRun(runId: string): Promise<readonly VerificationEvidence[]> {
    const ids = this.byRun.get(runId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((e): e is VerificationEvidence => e !== undefined);
  }

  async listByExecutionAttempt(
    executionAttemptId: string,
  ): Promise<readonly VerificationEvidence[]> {
    const ids = this.byAttempt.get(executionAttemptId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((e): e is VerificationEvidence => e !== undefined);
  }

  async listByCriterion(
    criterionId: string,
  ): Promise<readonly VerificationEvidence[]> {
    const ids = this.byCriterion.get(criterionId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((e): e is VerificationEvidence => e !== undefined);
  }

  async exists(evidenceId: string): Promise<boolean> {
    return this.byId.has(evidenceId);
  }
}
