export interface MemoryIdentityGenerator {
  nextHistoricalRunRecordId(): string;
  nextLearningCandidateId(): string;
  nextPrecedentId(): string;
  nextPromotionDecisionId(): string;
  nextContradictionId(): string;
  nextSupersessionId(): string;
  nextInvalidationId(): string;
  nextFindingId(): string;
  nextLedgerEventId(): string;
  nextInferenceRecordId(): string;
}

export class SequenceMemoryIdentityGenerator
  implements MemoryIdentityGenerator
{
  private historical = 0;
  private candidate = 0;
  private precedent = 0;
  private decision = 0;
  private contradiction = 0;
  private supersession = 0;
  private invalidation = 0;
  private finding = 0;
  private ledger = 0;
  private inference = 0;

  nextHistoricalRunRecordId(): string {
    this.historical += 1;
    return `hist_run_${this.historical}`;
  }

  nextLearningCandidateId(): string {
    this.candidate += 1;
    return `learn_cand_${this.candidate}`;
  }

  nextPrecedentId(): string {
    this.precedent += 1;
    return `precedent_${this.precedent}`;
  }

  nextPromotionDecisionId(): string {
    this.decision += 1;
    return `promo_dec_${this.decision}`;
  }

  nextContradictionId(): string {
    this.contradiction += 1;
    return `contradiction_${this.contradiction}`;
  }

  nextSupersessionId(): string {
    this.supersession += 1;
    return `supersession_${this.supersession}`;
  }

  nextInvalidationId(): string {
    this.invalidation += 1;
    return `invalidation_${this.invalidation}`;
  }

  nextFindingId(): string {
    this.finding += 1;
    return `mem_finding_${this.finding}`;
  }

  nextLedgerEventId(): string {
    this.ledger += 1;
    return `learn_ledger_${this.ledger}`;
  }

  nextInferenceRecordId(): string {
    this.inference += 1;
    return `learn_inf_${this.inference}`;
  }
}
