import { createHash } from "node:crypto";
import {
  parseValidationFinding,
  type ValidationFinding,
  type ValidationFindingSeverity,
  type ValidationValidatorType,
} from "../domain/validation/index.js";
import { ViolationFingerprintService } from "./fingerprint.js";

export interface ValidationFindingDraft {
  validatorType: ValidationValidatorType;
  category: string;
  severity: ValidationFindingSeverity;
  ruleId: string;
  message: string;
  /** Structural repair by a bounded revision could plausibly resolve this. */
  repairable: boolean;
  /** A human approver may authorize the plan despite this finding. */
  approvalEligible: boolean;
  /** Prevents PASS. */
  blocking: boolean;
  evidenceRefs?: readonly string[];
  affectedStepIds?: readonly string[];
  /** Normalized discriminators folded into the semantic fingerprint. */
  subject?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Builds structured findings. Validators never emit prose-only output and never
 * assign their own decision class — severity/blocking/repairable/approvalEligible
 * are the only signals the deterministic decision engine consumes.
 */
export class ValidationFindingFactory {
  constructor(
    private readonly fingerprints: ViolationFingerprintService = new ViolationFingerprintService(),
  ) {}

  create(draft: ValidationFindingDraft): ValidationFinding {
    const fingerprintInput: {
      validatorType: ValidationValidatorType;
      ruleId: string;
      category: string;
      affectedStepIds?: readonly string[];
      subject?: Readonly<Record<string, unknown>>;
    } = {
      validatorType: draft.validatorType,
      ruleId: draft.ruleId,
      category: draft.category,
      affectedStepIds: draft.affectedStepIds ?? [],
    };
    if (draft.subject !== undefined) {
      fingerprintInput.subject = draft.subject;
    }
    const semanticFingerprint = this.fingerprints.fingerprint(fingerprintInput);
    const findingId = `vf_${createHash("sha256")
      .update(
        `${semanticFingerprint}|${this.fingerprints.normalizeText(draft.message)}`,
        "utf8",
      )
      .digest("hex")
      .slice(0, 20)}`;

    return parseValidationFinding({
      findingId,
      validatorType: draft.validatorType,
      category: draft.category,
      severity: draft.severity,
      ruleId: draft.ruleId,
      message: draft.message,
      evidenceRefs: [...(draft.evidenceRefs ?? [])],
      affectedStepIds: [...(draft.affectedStepIds ?? [])],
      repairable: draft.repairable,
      approvalEligible: draft.approvalEligible,
      blocking: draft.blocking,
      semanticFingerprint,
      metadata: { ...(draft.metadata ?? {}) },
    });
  }

  createMany(
    drafts: readonly ValidationFindingDraft[],
  ): ValidationFinding[] {
    return drafts.map((draft) => this.create(draft));
  }
}

/** Blocking findings that no bounded revision may repair. */
export function isUnrepairableBlocking(finding: ValidationFinding): boolean {
  return finding.blocking && !finding.repairable;
}

export function blockingFindings(
  findings: readonly ValidationFinding[],
): ValidationFinding[] {
  return findings.filter((finding) => finding.blocking);
}

export function repairableBlockingFindings(
  findings: readonly ValidationFinding[],
): ValidationFinding[] {
  return findings.filter((finding) => finding.blocking && finding.repairable);
}

export function semanticFingerprintsOf(
  findings: readonly ValidationFinding[],
): string[] {
  return [...new Set(findings.map((finding) => finding.semanticFingerprint))].sort(
    (a, b) => a.localeCompare(b),
  );
}
