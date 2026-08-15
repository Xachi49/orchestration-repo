export interface VerificationIdentityGenerator {
  nextVerificationAttemptId(): string;
  nextOutcomeVerificationId(): string;
  nextCompletionRecordId(): string;
  nextEvidenceId(): string;
  nextFindingId(): string;
  nextEventId(): string;
  nextSpecificationId(): string;
}

export class SequenceVerificationIdentityGenerator
  implements VerificationIdentityGenerator
{
  private attempt = 0;
  private outcome = 0;
  private completion = 0;
  private evidence = 0;
  private finding = 0;
  private event = 0;
  private specification = 0;

  nextVerificationAttemptId(): string {
    this.attempt += 1;
    return `ver_attempt_${this.attempt}`;
  }

  nextOutcomeVerificationId(): string {
    this.outcome += 1;
    return `outcome_ver_${this.outcome}`;
  }

  nextCompletionRecordId(): string {
    this.completion += 1;
    return `completion_${this.completion}`;
  }

  nextEvidenceId(): string {
    this.evidence += 1;
    return `ver_evidence_${this.evidence}`;
  }

  nextFindingId(): string {
    this.finding += 1;
    return `ver_finding_${this.finding}`;
  }

  nextEventId(): string {
    this.event += 1;
    return `ver_event_${this.event}`;
  }

  nextSpecificationId(): string {
    this.specification += 1;
    return `ver_spec_${this.specification}`;
  }
}
