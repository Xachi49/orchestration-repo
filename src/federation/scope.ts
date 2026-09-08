import { createHash } from "node:crypto";
import { z } from "zod";
import { FEDERATION_ACTIONS, type FederationAction } from "./doctrine.js";
import { FederationError } from "./errors.js";

export const FederationInstitutionPairSchema = z
  .object({
    sourceInstitutionId: z.string().min(1),
    targetInstitutionId: z.string().min(1),
  })
  .strict();

export type FederationInstitutionPair = z.infer<
  typeof FederationInstitutionPairSchema
>;

export const FederationResourceRequestCeilingSchema = z
  .object({
    cpuMillis: z.number().finite().nonnegative().optional(),
    memoryMb: z.number().finite().nonnegative().optional(),
    maxDurationMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export type FederationResourceRequestCeiling = z.infer<
  typeof FederationResourceRequestCeilingSchema
>;

/** FederationScope limits what may be requested. It does NOT create authority. */
export const FederationScopeSchema = z
  .object({
    participantInstitutionIds: z.array(z.string().min(1)).min(2),
    permittedPairs: z.array(FederationInstitutionPairSchema).min(1),
    permittedSourceProjectIds: z.array(z.string().min(1)).min(1),
    permittedTargetProjectIds: z.array(z.string().min(1)).min(1),
    permittedEnvironments: z.array(z.string().min(1)).min(1),
    permittedIntentKinds: z.array(z.literal("OBJECTIVE")).min(1),
    evidenceSharingClasses: z.array(z.string().min(1)).default([]),
    maximumResourceRequest: FederationResourceRequestCeilingSchema.optional(),
    effectiveFrom: z.string().datetime(),
    effectiveUntil: z.string().datetime().optional(),
  })
  .strict();

export type FederationScope = z.infer<typeof FederationScopeSchema>;

export function computeScopeHash(scope: FederationScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        participantInstitutionIds: [...scope.participantInstitutionIds].sort(),
        permittedPairs: [...scope.permittedPairs]
          .map((p) => ({
            sourceInstitutionId: p.sourceInstitutionId,
            targetInstitutionId: p.targetInstitutionId,
          }))
          .sort(
            (a, b) =>
              a.sourceInstitutionId.localeCompare(b.sourceInstitutionId) ||
              a.targetInstitutionId.localeCompare(b.targetInstitutionId),
          ),
        permittedSourceProjectIds: [...scope.permittedSourceProjectIds].sort(),
        permittedTargetProjectIds: [...scope.permittedTargetProjectIds].sort(),
        permittedEnvironments: [...scope.permittedEnvironments].sort(),
        permittedIntentKinds: [...scope.permittedIntentKinds].sort(),
        evidenceSharingClasses: [...scope.evidenceSharingClasses].sort(),
        maximumResourceRequest: scope.maximumResourceRequest ?? null,
        effectiveFrom: scope.effectiveFrom,
        effectiveUntil: scope.effectiveUntil ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

export function canonicalizeParticipantIds(
  ids: readonly string[],
): string[] {
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) {
    throw new FederationError(
      "FEDERATION_PARTICIPANT_INVALID",
      "Duplicate participant institution rejected",
    );
  }
  if (unique.length < 2) {
    throw new FederationError(
      "FEDERATION_PARTICIPANT_INVALID",
      "Federation agreement requires >= 2 distinct institutions",
    );
  }
  return unique.sort((a, b) => a.localeCompare(b));
}

export function computeParticipantSetHash(
  participantInstitutionIds: readonly string[],
): string {
  const sorted = canonicalizeParticipantIds(participantInstitutionIds);
  return createHash("sha256")
    .update(JSON.stringify(sorted), "utf8")
    .digest("hex");
}

export function assertPairInScope(
  scope: FederationScope,
  sourceInstitutionId: string,
  targetInstitutionId: string,
): void {
  const ok = scope.permittedPairs.some(
    (p) =>
      p.sourceInstitutionId === sourceInstitutionId &&
      p.targetInstitutionId === targetInstitutionId,
  );
  if (!ok) {
    throw new FederationError(
      "FEDERATION_TRANSITIVE_TRUST_DENIED",
      `Pair ${sourceInstitutionId}→${targetInstitutionId} is not in agreement scope`,
      { sourceInstitutionId, targetInstitutionId },
    );
  }
}

export function assertWorkIntentInScope(input: {
  scope: FederationScope;
  sourceInstitutionId: string;
  targetInstitutionId: string;
  sourceProjectId: string;
  targetProjectId: string;
  environment: string;
  intentKind: "OBJECTIVE";
  atIso: string;
  resourceRequest?: FederationResourceRequestCeiling;
}): void {
  const { scope } = input;
  if (!scope.participantInstitutionIds.includes(input.sourceInstitutionId)) {
    throw new FederationError(
      "FEDERATION_TRANSITIVE_TRUST_DENIED",
      "Source institution not a participant of this agreement — no transitive trust",
      { sourceInstitutionId: input.sourceInstitutionId },
    );
  }
  if (!scope.participantInstitutionIds.includes(input.targetInstitutionId)) {
    throw new FederationError(
      "FEDERATION_TRANSITIVE_TRUST_DENIED",
      "Target institution not a participant of this agreement — no transitive trust",
      { targetInstitutionId: input.targetInstitutionId },
    );
  }
  assertPairInScope(
    scope,
    input.sourceInstitutionId,
    input.targetInstitutionId,
  );
  if (!scope.permittedSourceProjectIds.includes(input.sourceProjectId)) {
    throw new FederationError(
      "FEDERATED_TARGET_SCOPE_DENIED",
      "Source project not permitted by federation scope",
      { sourceProjectId: input.sourceProjectId },
    );
  }
  if (!scope.permittedTargetProjectIds.includes(input.targetProjectId)) {
    throw new FederationError(
      "FEDERATED_TARGET_SCOPE_DENIED",
      "Target project not permitted by federation scope",
      { targetProjectId: input.targetProjectId },
    );
  }
  if (!scope.permittedEnvironments.includes(input.environment)) {
    throw new FederationError(
      "FEDERATED_TARGET_SCOPE_DENIED",
      "Environment not permitted by federation scope",
      { environment: input.environment },
    );
  }
  if (!scope.permittedIntentKinds.includes(input.intentKind)) {
    throw new FederationError(
      "FEDERATION_SCOPE_VIOLATION",
      `Intent kind ${input.intentKind} not permitted`,
    );
  }
  const at = Date.parse(input.atIso);
  if (at < Date.parse(scope.effectiveFrom)) {
    throw new FederationError(
      "FEDERATION_SCOPE_VIOLATION",
      "Intent before scope effectiveFrom",
    );
  }
  if (
    scope.effectiveUntil !== undefined &&
    at > Date.parse(scope.effectiveUntil)
  ) {
    throw new FederationError(
      "FEDERATION_SCOPE_VIOLATION",
      "Intent after scope effectiveUntil",
    );
  }
  if (input.resourceRequest && scope.maximumResourceRequest) {
    const ceiling = scope.maximumResourceRequest;
    const req = input.resourceRequest;
    if (
      req.cpuMillis !== undefined &&
      ceiling.cpuMillis !== undefined &&
      req.cpuMillis > ceiling.cpuMillis
    ) {
      throw new FederationError(
        "FEDERATION_SCOPE_VIOLATION",
        "Resource request exceeds federation ceiling (request only — not a reservation)",
      );
    }
    if (
      req.memoryMb !== undefined &&
      ceiling.memoryMb !== undefined &&
      req.memoryMb > ceiling.memoryMb
    ) {
      throw new FederationError(
        "FEDERATION_SCOPE_VIOLATION",
        "Resource request exceeds federation ceiling (request only — not a reservation)",
      );
    }
    if (
      req.maxDurationMs !== undefined &&
      ceiling.maxDurationMs !== undefined &&
      req.maxDurationMs > ceiling.maxDurationMs
    ) {
      throw new FederationError(
        "FEDERATION_SCOPE_VIOLATION",
        "Resource request exceeds federation ceiling (request only — not a reservation)",
      );
    }
  }
}

export function assertAllowedActions(
  actions: readonly string[],
): asserts actions is FederationAction[] {
  for (const action of actions) {
    if (!(FEDERATION_ACTIONS as readonly string[]).includes(action)) {
      throw new FederationError(
        "FEDERATION_ACTION_UNSUPPORTED",
        `Unsupported federation action: ${action}`,
      );
    }
  }
  if (actions.length === 0) {
    throw new FederationError(
      "FEDERATION_AGREEMENT_INVALID",
      "At least one allowed federation action required",
    );
  }
}
