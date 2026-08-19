import { randomUUID } from "node:crypto";
import type { AuthorizationIdentityGenerator } from "../../authorization/identity.js";
import type { ExecutionIdentityGenerator } from "../../execution/identity.js";
import type { MemoryIdentityGenerator } from "../../memory/identity.js";
import type { PlanIdentityGenerator } from "../../planning/plan-compiler.js";
import type { ValidationIdentityGenerator } from "../../validation/service.js";
import type { VerificationIdentityGenerator } from "../../verification/identity.js";
import { SequenceObservabilityIdentityGenerator } from "../../observability/identity.js";

function uuidId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** Globally unique durable document identities for PostgreSQL stacks. */
export class UuidPlanIdentityGenerator implements PlanIdentityGenerator {
  nextPlanId(): string {
    return uuidId("plan");
  }
}

export class UuidValidationIdentityGenerator
  implements ValidationIdentityGenerator
{
  nextValidationDecisionId(): string {
    return uuidId("vd");
  }

  nextRevisionEnvelopeId(): string {
    return uuidId("rev");
  }

  nextExceptionId(): string {
    return uuidId("pex");
  }
}

export class UuidAuthorizationIdentityGenerator
  implements AuthorizationIdentityGenerator
{
  nextApprovalRequestId(): string {
    return uuidId("apr");
  }

  nextAuthorizationRecordId(): string {
    return uuidId("authz");
  }

  nextModificationRequestId(): string {
    return uuidId("mod");
  }
}

export class UuidExecutionIdentityGenerator
  implements ExecutionIdentityGenerator
{
  nextExecutionAttemptId(): string {
    return uuidId("exec_attempt");
  }

  nextAuthoritySnapshotId(): string {
    return uuidId("exec_auth_snap");
  }

  nextArtifactId(): string {
    return uuidId("exec_artifact");
  }

  nextEventId(): string {
    return uuidId("exec_event");
  }
}

export class UuidVerificationIdentityGenerator
  implements VerificationIdentityGenerator
{
  nextVerificationAttemptId(): string {
    return uuidId("ver_attempt");
  }

  nextOutcomeVerificationId(): string {
    return uuidId("outcome_ver");
  }

  nextCompletionRecordId(): string {
    return uuidId("completion");
  }

  nextEvidenceId(): string {
    return uuidId("ver_evidence");
  }

  nextFindingId(): string {
    return uuidId("ver_finding");
  }

  nextEventId(): string {
    return uuidId("ver_event");
  }

  nextSpecificationId(): string {
    return uuidId("ver_spec");
  }
}

export class UuidMemoryIdentityGenerator implements MemoryIdentityGenerator {
  nextHistoricalRunRecordId(): string {
    return uuidId("hist_run");
  }

  nextLearningCandidateId(): string {
    return uuidId("learn_cand");
  }

  nextPrecedentId(): string {
    return uuidId("precedent");
  }

  nextPromotionDecisionId(): string {
    return uuidId("promo_dec");
  }

  nextContradictionId(): string {
    return uuidId("contradiction");
  }

  nextSupersessionId(): string {
    return uuidId("supersession");
  }

  nextInvalidationId(): string {
    return uuidId("invalidation");
  }

  nextFindingId(): string {
    return uuidId("mem_finding");
  }

  nextLedgerEventId(): string {
    return uuidId("learn_ledger");
  }

  nextInferenceRecordId(): string {
    return uuidId("learn_inf");
  }
}

/** Per-stack observability ids must not collide across repeated postgres runs. */
export class UuidObservabilityIdentityGenerator extends SequenceObservabilityIdentityGenerator {
  override next(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}
