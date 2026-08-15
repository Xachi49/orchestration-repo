import type { EvidenceRecord } from "../domain/evidence/evidence.js";
import { PlanningError } from "./errors.js";

export class EvidenceReferenceValidator {
  validate(input: {
    evidenceRefs: readonly string[];
    evidenceById: ReadonlyMap<string, EvidenceRecord>;
    runId: string;
    projectId: string;
    lockedCommitSha: string;
  }): void {
    for (const ref of input.evidenceRefs) {
      const record = input.evidenceById.get(ref);
      if (!record) {
        throw new PlanningError(
          "INVALID_EVIDENCE_REFERENCE",
          `Unknown evidence reference: ${ref}`,
          { evidenceId: ref },
        );
      }
      if (record.runId && record.runId !== input.runId) {
        throw new PlanningError(
          "INVALID_EVIDENCE_REFERENCE",
          `Evidence ${ref} does not belong to run ${input.runId}`,
          { evidenceId: ref },
        );
      }
      if (record.projectId && record.projectId !== input.projectId) {
        throw new PlanningError(
          "INVALID_EVIDENCE_REFERENCE",
          `Evidence ${ref} does not belong to project ${input.projectId}`,
          { evidenceId: ref },
        );
      }
      if (
        record.commitSha &&
        record.commitSha.toLowerCase() !== input.lockedCommitSha.toLowerCase()
      ) {
        throw new PlanningError(
          "INVALID_EVIDENCE_REFERENCE",
          `Evidence ${ref} commit does not match locked SHA`,
          {
            evidenceId: ref,
            evidenceCommit: record.commitSha,
            lockedCommitSha: input.lockedCommitSha,
          },
        );
      }
    }
  }
}
