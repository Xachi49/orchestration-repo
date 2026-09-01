import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { GovernanceOrchestrationService } from "../governance/service.js";
import type { InstitutionalAuthorizationProofRepository } from "../governance/repositories.js";
import { isGovernanceError } from "../governance/errors.js";
import { GovernanceQuorumRequirementSchema } from "../governance/quorum.js";
import { SeparationOfDutyRuleSchema } from "../governance/separation.js";

const IdParams = z.object({ id: z.string().min(1) }).strict();

const CreateInstitutionBody = z
  .object({
    name: z.string().min(1).max(500),
    projectIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

const CreateMandateBody = z
  .object({
    institutionId: z.string().min(1),
    createdBy: z.string().min(1).optional(),
    subjectClasses: z.array(z.string().min(1)).min(1),
    requiredAuthorities: z.array(z.string().min(1)).min(1),
    projectScope: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    quorumRequirement: GovernanceQuorumRequirementSchema.optional(),
    separationOfDutyRules: z.array(SeparationOfDutyRuleSchema).optional(),
    effectiveFrom: z.string().datetime().optional(),
    effectiveUntil: z.string().datetime().optional(),
    mandateVersion: z.number().int().positive().optional(),
  })
  .strict();

const CreateDelegationBody = z
  .object({
    delegatorPrincipalId: z.string().min(1).optional(),
    delegatePrincipalId: z.string().min(1),
    authorityRole: z.string().min(1),
    projectScope: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    actionScope: z.array(z.string().min(1)).optional(),
    subjectScope: z.array(z.string().min(1)).optional(),
    effectiveFrom: z.string().datetime().optional(),
    effectiveUntil: z.string().datetime(),
    maximumRisk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    maximumResourceEnvelope: z
      .record(z.string(), z.number().finite().nonnegative())
      .optional(),
    reason: z.string().min(1).max(4000),
    maximumDelegationDepth: z.number().int().nonnegative().optional(),
  })
  .strict();

const OpenCaseBody = z
  .object({
    subjectType: z.string().min(1),
    subjectId: z.string().min(1),
    subjectHash: z.string().min(1),
    subjectVersion: z.number().int().positive().optional(),
    requiredRole: z.string().min(1),
    action: z.string().min(1).optional(),
    projectIds: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    mandateIds: z.array(z.string().min(1)).min(1),
    expiresAt: z.string().datetime(),
  })
  .strict();

const AttestBody = z
  .object({
    principalId: z.string().min(1).optional(),
    authorityRole: z.string().min(1),
    decision: z.enum(["APPROVE", "REJECT"]),
    nonce: z.string().min(1),
    nonceHash: z.string().min(1).optional(),
    subjectHash: z.string().min(1).optional(),
  })
  .strict();

const CreateHoldBody = z
  .object({
    createdBy: z.string().min(1).optional(),
    institutionId: z.string().min(1),
    projectScope: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).optional(),
    subjectClasses: z.array(z.string().min(1)).optional(),
    authorityRoles: z.array(z.string().min(1)).optional(),
    reason: z.string().min(1).max(4000),
    effect: z.enum(["BLOCK", "PAUSE", "CONTAIN"]).optional(),
    effectiveFrom: z.string().datetime().optional(),
    effectiveUntil: z.string().datetime().optional(),
  })
  .strict();

const RevokeBody = z
  .object({
    targetType: z.enum([
      "DIRECT_GRANT",
      "DELEGATION",
      "MANDATE",
      "INSTITUTIONAL_PROOF",
    ]),
    targetId: z.string().min(1),
    reason: z.string().min(1).max(4000),
    principalId: z.string().min(1).optional(),
    effectiveAt: z.string().datetime().optional(),
  })
  .strict();

function principalId(request: FastifyRequest): string {
  return (
    (request as { orchestratorPrincipalId?: string }).orchestratorPrincipalId ??
    "anonymous"
  );
}

function httpStatusForGovernance(code: string): number {
  switch (code) {
    case "INSTITUTION_NOT_FOUND":
    case "GOVERNANCE_MANDATE_NOT_FOUND":
    case "GOVERNANCE_CASE_NOT_FOUND":
    case "GOVERNANCE_PROOF_NOT_FOUND":
    case "GOVERNANCE_HOLD_NOT_FOUND":
    case "AUTHORITY_DELEGATION_NOT_FOUND":
      return 404;
    case "GOVERNANCE_CAS_CONFLICT":
    case "GOVERNANCE_VERSION_CONFLICT":
    case "GOVERNANCE_MANDATE_STATE_CONFLICT":
    case "GOVERNANCE_CASE_STATE_CONFLICT":
    case "DELEGATION_STATE_CONFLICT":
    case "INSTITUTION_STATE_CONFLICT":
      return 409;
    case "GOVERNANCE_ADMIN_SCOPE_INSUFFICIENT":
    case "GOVERNANCE_HOLD_OPERATOR_SCOPE_INSUFFICIENT":
    case "GOVERNANCE_HOLD_SCOPE_INSUFFICIENT":
    case "AUTHORITY_DENIED":
    case "GOVERNANCE_HOLD_ACTIVE":
    case "GOVERNANCE_SELF_ESCALATION":
    case "APPROVAL_LAUNDERING":
      return 403;
    default:
      return 400;
  }
}

export function registerGovernanceRoutes(
  app: FastifyInstance,
  deps: {
    governanceService: GovernanceOrchestrationService;
    governanceProofs: InstitutionalAuthorizationProofRepository;
  },
): void {
  app.post("/v1/governance/institutions", async (request, reply) => {
    try {
      const body = CreateInstitutionBody.parse(request.body);
      return await deps.governanceService.createInstitution({
        name: body.name,
        ...(body.projectIds !== undefined
          ? { projectIds: body.projectIds }
          : {}),
      });
    } catch (error) {
      if (isGovernanceError(error)) {
        return reply
          .code(httpStatusForGovernance(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/governance/mandates", async (request, reply) => {
    try {
      const body = CreateMandateBody.parse(request.body);
      return await deps.governanceService.createMandate({
        institutionId: body.institutionId,
        createdBy: body.createdBy ?? principalId(request),
        subjectClasses: body.subjectClasses,
        requiredAuthorities: body.requiredAuthorities,
        projectScope: body.projectScope,
        environmentScope: body.environmentScope,
        ...(body.quorumRequirement !== undefined
          ? { quorumRequirement: body.quorumRequirement }
          : {}),
        ...(body.separationOfDutyRules !== undefined
          ? { separationOfDutyRules: body.separationOfDutyRules }
          : {}),
        ...(body.effectiveFrom !== undefined
          ? { effectiveFrom: body.effectiveFrom }
          : {}),
        ...(body.effectiveUntil !== undefined
          ? { effectiveUntil: body.effectiveUntil }
          : {}),
        ...(body.mandateVersion !== undefined
          ? { mandateVersion: body.mandateVersion }
          : {}),
      });
    } catch (error) {
      if (isGovernanceError(error)) {
        return reply
          .code(httpStatusForGovernance(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/governance/mandates/:id/activate", async (request, reply) => {
    try {
      const { id } = IdParams.parse(request.params);
      return await deps.governanceService.activateMandate({
        mandateId: id,
        actorPrincipalId: principalId(request),
      });
    } catch (error) {
      if (isGovernanceError(error)) {
        return reply
          .code(httpStatusForGovernance(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/governance/delegations", async (request, reply) => {
    try {
      const body = CreateDelegationBody.parse(request.body);
      return await deps.governanceService.createDelegation({
        delegatorPrincipalId: body.delegatorPrincipalId ?? principalId(request),
        delegatePrincipalId: body.delegatePrincipalId,
        authorityRole: body.authorityRole,
        projectScope: body.projectScope,
        environmentScope: body.environmentScope,
        ...(body.actionScope !== undefined
          ? { actionScope: body.actionScope }
          : {}),
        ...(body.subjectScope !== undefined
          ? { subjectScope: body.subjectScope }
          : {}),
        ...(body.effectiveFrom !== undefined
          ? { effectiveFrom: body.effectiveFrom }
          : {}),
        effectiveUntil: body.effectiveUntil,
        ...(body.maximumRisk !== undefined
          ? { maximumRisk: body.maximumRisk }
          : {}),
        ...(body.maximumResourceEnvelope !== undefined
          ? { maximumResourceEnvelope: body.maximumResourceEnvelope }
          : {}),
        reason: body.reason,
        ...(body.maximumDelegationDepth !== undefined
          ? { maximumDelegationDepth: body.maximumDelegationDepth }
          : {}),
      });
    } catch (error) {
      if (isGovernanceError(error)) {
        return reply
          .code(httpStatusForGovernance(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/governance/cases", async (request, reply) => {
    try {
      const body = OpenCaseBody.parse(request.body);
      return await deps.governanceService.openGovernanceCase({
        subjectType: body.subjectType,
        subjectId: body.subjectId,
        subjectHash: body.subjectHash,
        ...(body.subjectVersion !== undefined
          ? { subjectVersion: body.subjectVersion }
          : {}),
        requiredRole: body.requiredRole,
        ...(body.action !== undefined ? { action: body.action } : {}),
        projectIds: body.projectIds,
        environmentScope: body.environmentScope,
        mandateIds: body.mandateIds,
        expiresAt: body.expiresAt,
      });
    } catch (error) {
      if (isGovernanceError(error)) {
        return reply
          .code(httpStatusForGovernance(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/governance/cases/:id/attest", async (request, reply) => {
    try {
      const { id } = IdParams.parse(request.params);
      const body = AttestBody.parse(request.body);
      return await deps.governanceService.attest({
        governanceCaseId: id,
        principalId: body.principalId ?? principalId(request),
        authorityRole: body.authorityRole,
        decision: body.decision,
        nonce: body.nonce,
        ...(body.nonceHash !== undefined ? { nonceHash: body.nonceHash } : {}),
        ...(body.subjectHash !== undefined
          ? { subjectHash: body.subjectHash }
          : {}),
      });
    } catch (error) {
      if (isGovernanceError(error)) {
        return reply
          .code(httpStatusForGovernance(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/governance/cases/:id/proof", async (request, reply) => {
    try {
      const { id } = IdParams.parse(request.params);
      const proof = await deps.governanceProofs.getByCase(id);
      const query = z
        .object({
          subjectId: z.string().min(1).optional(),
          subjectHash: z.string().min(1).optional(),
          projectId: z.string().min(1).optional(),
          environment: z.string().min(1).optional(),
          atIso: z.string().datetime().optional(),
        })
        .strict()
        .parse(request.query ?? {});

      if (
        proof &&
        query.subjectId &&
        query.subjectHash &&
        query.projectId &&
        query.environment &&
        query.atIso
      ) {
        return await deps.governanceService.getProof({
          proofId: proof.institutionalAuthorizationProofId,
          subjectId: query.subjectId,
          subjectHash: query.subjectHash,
          projectId: query.projectId,
          environment: query.environment,
          atIso: query.atIso,
        });
      }

      if (!proof) {
        return reply.code(404).send({
          error: "GOVERNANCE_PROOF_NOT_FOUND",
          message: `Proof for case ${id} not found`,
        });
      }
      return proof;
    } catch (error) {
      if (isGovernanceError(error)) {
        return reply
          .code(httpStatusForGovernance(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/governance/holds", async (request, reply) => {
    try {
      const body = CreateHoldBody.parse(request.body);
      return await deps.governanceService.createHold({
        createdBy: body.createdBy ?? principalId(request),
        institutionId: body.institutionId,
        projectScope: body.projectScope,
        ...(body.environmentScope !== undefined
          ? { environmentScope: body.environmentScope }
          : {}),
        ...(body.subjectClasses !== undefined
          ? { subjectClasses: body.subjectClasses }
          : {}),
        ...(body.authorityRoles !== undefined
          ? { authorityRoles: body.authorityRoles }
          : {}),
        reason: body.reason,
        ...(body.effect !== undefined ? { effect: body.effect } : {}),
        ...(body.effectiveFrom !== undefined
          ? { effectiveFrom: body.effectiveFrom }
          : {}),
        ...(body.effectiveUntil !== undefined
          ? { effectiveUntil: body.effectiveUntil }
          : {}),
      });
    } catch (error) {
      if (isGovernanceError(error)) {
        return reply
          .code(httpStatusForGovernance(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/governance/holds/:id/release", async (request, reply) => {
    try {
      const { id } = IdParams.parse(request.params);
      return await deps.governanceService.releaseHold({
        holdId: id,
        actorPrincipalId: principalId(request),
      });
    } catch (error) {
      if (isGovernanceError(error)) {
        return reply
          .code(httpStatusForGovernance(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/governance/revocations", async (request, reply) => {
    try {
      const body = RevokeBody.parse(request.body);
      return await deps.governanceService.revokeTarget({
        targetType: body.targetType,
        targetId: body.targetId,
        reason: body.reason,
        principalId: body.principalId ?? principalId(request),
        ...(body.effectiveAt !== undefined
          ? { effectiveAt: body.effectiveAt }
          : {}),
      });
    } catch (error) {
      if (isGovernanceError(error)) {
        return reply
          .code(httpStatusForGovernance(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });
}
