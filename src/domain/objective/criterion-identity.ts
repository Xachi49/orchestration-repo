import { createHash } from "node:crypto";
import type { Objective } from "./objective.js";
import {
  objectiveFingerprint,
  type ObjectiveFingerprintContent,
} from "./fingerprint.js";

/**
 * Shared acceptance-criterion identity (Phase 4–8).
 *
 * IDs are deterministic over objectiveFingerprint + stored ordinal + normalized
 * text. The model never assigns criterion identity.
 */
export function normalizeCriterionText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function criterionTextHash(text: string): string {
  return createHash("sha256")
    .update(normalizeCriterionText(text), "utf8")
    .digest("hex");
}

export interface AcceptanceCriterionIdentity {
  criterionId: string;
  criterionText: string;
  criterionTextHash: string;
  index: number;
}

export function acceptanceCriterionId(input: {
  objectiveFingerprint: string;
  index: number;
  criterionText: string;
}): string {
  const normalized = normalizeCriterionText(input.criterionText);
  const digest = createHash("sha256")
    .update(
      `${input.objectiveFingerprint}:${input.index}:${normalized}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return `crit_${digest}`;
}

/**
 * Derive stable criterion identities from an objective's stored criteria order.
 * Ordering in the stored Objective is authoritative for ordinal identity.
 */
export class AcceptanceCriterionIdentityService {
  deriveFromFingerprintContent(
    content: ObjectiveFingerprintContent,
  ): readonly AcceptanceCriterionIdentity[] {
    const fp = objectiveFingerprint(content);
    return content.acceptanceCriteria.map((criterionText, index) => ({
      criterionId: acceptanceCriterionId({
        objectiveFingerprint: fp,
        index,
        criterionText,
      }),
      criterionText,
      criterionTextHash: criterionTextHash(criterionText),
      index,
    }));
  }

  deriveFromObjective(objective: Objective): readonly AcceptanceCriterionIdentity[] {
    return this.deriveFromFingerprintContent({
      requestedOutcome: objective.requestedOutcome,
      acceptanceCriteria: objective.acceptanceCriteria,
      nonGoals: objective.nonGoals,
      constraints: objective.constraints,
      priority: objective.priority,
      ...(objective.deadline !== undefined
        ? { deadline: objective.deadline }
        : {}),
    });
  }
}

export const acceptanceCriterionIdentity =
  new AcceptanceCriterionIdentityService();
