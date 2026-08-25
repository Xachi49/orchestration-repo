import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ProgramOrchestrationService } from "../programs/service.js";
import type {
  ProgramRepository,
  ProgramPlanRepository,
} from "../programs/repositories.js";
import { isProgramError } from "../programs/errors.js";
import { DelegationEnvelopeSchema } from "../programs/delegation-envelope.js";
import { ProgramRootIntentSchema } from "../programs/program.js";

const ProgramParams = z.object({ programId: z.string().min(1) }).strict();

const AdmitBody = z
  .object({
    programId: z.string().min(1).optional(),
    programVersion: z.number().int().positive().optional(),
    projectId: z.string().min(1),
    requesterId: z.string().min(1).optional(),
    requestedEnvironment: z.string().min(1),
    rootIntent: ProgramRootIntentSchema,
    delegationEnvelope: DelegationEnvelopeSchema,
    submittedAt: z.string().datetime().optional(),
  })
  .strict();

const DecideBody = z
  .object({
    approverId: z.string().min(1).optional(),
    decision: z.enum(["APPROVE", "REJECT"]),
    decisionNonce: z.string().min(1),
    submittedAt: z.string().datetime().optional(),
  })
  .strict();

function principalId(request: FastifyRequest): string {
  return (
    (request as { orchestratorPrincipalId?: string }).orchestratorPrincipalId ??
    "anonymous"
  );
}

function httpStatusForProgram(code: string): number {
  switch (code) {
    case "PROGRAM_NOT_FOUND":
      return 404;
    case "PROGRAM_VERSION_CONFLICT":
    case "PROGRAM_STATE_CONFLICT":
    case "PROGRAM_CAS_CONFLICT":
      return 409;
    case "MATERIALIZATION_APPROVAL_REQUIRED":
    case "MATERIALIZATION_APPROVAL_INVALID":
    case "MATERIALIZATION_APPROVAL_EXPIRED":
      return 403;
    default:
      return 400;
  }
}

export function registerProgramRoutes(
  app: FastifyInstance,
  deps: {
    programService: ProgramOrchestrationService;
    programs: ProgramRepository;
    programPlans: ProgramPlanRepository;
  },
): void {
  app.post("/v1/programs", async (request, reply) => {
    try {
      const body = AdmitBody.parse(request.body);
      const result = await deps.programService.admit({
        projectId: body.projectId,
        requesterId: body.requesterId ?? principalId(request),
        requestedEnvironment: body.requestedEnvironment,
        rootIntent: body.rootIntent,
        delegationEnvelope: body.delegationEnvelope,
        submittedAt: body.submittedAt ?? new Date().toISOString(),
        ...(body.programId ? { programId: body.programId } : {}),
        ...(body.programVersion !== undefined
          ? { programVersion: body.programVersion }
          : {}),
      });
      if (result.outcome === "ADMITTED") {
        return reply.code(201).send(result);
      }
      if (result.outcome === "DUPLICATE") {
        return reply.code(200).send(result);
      }
      return reply.code(409).send(result);
    } catch (error) {
      if (isProgramError(error)) {
        return reply.code(httpStatusForProgram(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get("/v1/programs/:programId", async (request, reply) => {
    const { programId } = ProgramParams.parse(request.params);
    const program = await deps.programs.getById(programId);
    if (!program) {
      return reply.code(404).send({ error: "PROGRAM_NOT_FOUND" });
    }
    return { program };
  });

  app.get("/v1/programs/:programId/plan", async (request, reply) => {
    const { programId } = ProgramParams.parse(request.params);
    const plan = await deps.programPlans.getLatest(programId);
    if (!plan) {
      return reply.code(404).send({ error: "PROGRAM_PLAN_INVALID" });
    }
    return { plan };
  });

  app.get("/v1/programs/:programId/graph", async (request, reply) => {
    const { programId } = ProgramParams.parse(request.params);
    const plan = await deps.programPlans.getLatest(programId);
    if (!plan) {
      return reply.code(404).send({ error: "PROGRAM_PLAN_INVALID" });
    }
    return {
      nodes: plan.nodes.map((n) => ({
        nodeId: n.nodeId,
        title: n.title,
        requirement: n.requirement,
        depth: n.depth,
      })),
      edges: plan.edges,
    };
  });

  app.get("/v1/programs/:programId/progress", async (request, reply) => {
    try {
      const { programId } = ProgramParams.parse(request.params);
      const progress = await deps.programService.reconcile(programId);
      return progress;
    } catch (error) {
      if (isProgramError(error)) {
        return reply.code(httpStatusForProgram(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.post(
    "/v1/programs/:programId/materialization-approvals/:approvalId/decision",
    async (request, reply) => {
      try {
        const params = z
          .object({
            programId: z.string().min(1),
            approvalId: z.string().min(1),
          })
          .strict()
          .parse(request.params);
        const body = DecideBody.parse(request.body);
        const approval = await deps.programService.decideMaterialization({
          approvalId: params.approvalId,
          approverId: body.approverId ?? principalId(request),
          decision: body.decision,
          decisionNonce: body.decisionNonce,
          submittedAt: body.submittedAt ?? new Date().toISOString(),
        });
        return { approval };
      } catch (error) {
        if (isProgramError(error)) {
          return reply.code(httpStatusForProgram(error.code)).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );
}
