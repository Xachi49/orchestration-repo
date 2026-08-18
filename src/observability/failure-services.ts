import type {
  FailureCategory,
  FailureAttribution,
  RunTelemetryRecord,
} from "../domain/observability/index.js";
import type { RunRecord } from "../admission/run-repository.js";
import { FailureAttributionHasher } from "./hasher.js";
import { SequenceObservabilityIdentityGenerator } from "./identity.js";

const PREFIX_MAP: ReadonlyArray<[RegExp, FailureCategory]> = [
  [/^ADMISSION_/i, "INPUT"],
  [/^AUTHORITY_/i, "AUTHORITY"],
  [/^REPOSITORY_/i, "REPOSITORY_TRUTH"],
  [/^PLANNING_/i, "PLANNING"],
  [/^VALIDATION_/i, "VALIDATION"],
  [/^APPROVAL_/i, "APPROVAL"],
  [/^CAPABILITY_/i, "CAPABILITY"],
  [/^EXECUTION_/i, "EXECUTION"],
  [/^RESOURCE_/i, "RESOURCE"],
  [/^ROLLBACK_/i, "ROLLBACK"],
  [/^CONTAIN/i, "CONTAINMENT"],
  [/^VERIFICATION_/i, "VERIFICATION"],
  [/^EVIDENCE_/i, "EVIDENCE"],
  [/^MEMORY_/i, "MEMORY"],
  [/^INFRA/i, "INFRASTRUCTURE"],
];

export class FailureClassificationService {
  classify(errorCode: string): FailureCategory {
    for (const [pattern, category] of PREFIX_MAP) {
      if (pattern.test(errorCode)) return category;
    }
    return "UNKNOWN";
  }
}

export class FailureAttributionService {
  private readonly classifier = new FailureClassificationService();
  private readonly hasher = new FailureAttributionHasher();

  constructor(
    private readonly identities = new SequenceObservabilityIdentityGenerator(),
  ) {}

  attribute(
    run: RunRecord,
    telemetry: RunTelemetryRecord,
    extras?: {
      affectedCapabilityIds?: string[];
      affectedStepIds?: string[];
      affectedCriterionIds?: string[];
      contributingFailureCodes?: string[];
      containmentReason?: string;
    },
  ): FailureAttribution | null {
    const successStates = ["COMPLETED"];
    if (successStates.includes(run.state)) {
      return null;
    }
    const primaryCode =
      run.failureReasonCode ??
      telemetry.phaseDurations.find(() => false)?.phase ??
      "UNKNOWN_FAILURE";
    const code =
      run.failureReasonCode ??
      (telemetry.containmentOccurred ? "CONTAINMENT" : "TERMINAL_FAILURE");
    const phase =
      telemetry.failureStage ??
      (run.state === "ADMISSION_REJECTED"
        ? "ADMISSION"
        : run.state === "REJECTED" || run.state === "EXPIRED"
          ? "AUTHORIZATION"
          : run.state === "CONTAINED" || run.state === "FAILED"
            ? "EXECUTION"
            : "VALIDATION");

    const partial: Omit<FailureAttribution, "attributionHash"> = {
      attributionId: this.identities.next("fail-attr"),
      runId: run.runId,
      projectId: run.projectId,
      primaryFailurePhase: phase,
      primaryFailureCode: code,
      primaryFailureCategory: this.classifier.classify(code),
      contributingFailureCodes: extras?.contributingFailureCodes ?? [],
      retryCount:
        telemetry.executionAttemptCount +
        telemetry.validationAttemptCount -
        2,
      affectedCapabilityIds: extras?.affectedCapabilityIds ?? [],
      affectedStepIds: extras?.affectedStepIds ?? [],
      affectedCriterionIds: extras?.affectedCriterionIds ?? [],
    };
    if (extras?.containmentReason !== undefined) {
      partial.containmentReason = extras.containmentReason;
    }
    void primaryCode;
    return {
      ...partial,
      attributionHash: this.hasher.hash(partial),
    };
  }
}
