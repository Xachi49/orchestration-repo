import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { OutcomeVerificationService } from "../verification/service.js";
import type { VerificationReadinessService } from "../verification/readiness.js";
import {
  isVerificationError,
  type VerificationErrorCode,
} from "../verification/errors.js";

const RunParamsSchema = z.object({ runId: z.string().min(1) }).strict();

export function httpStatusForVerification(
  code: VerificationErrorCode,
): number {
  switch (code) {
    case "VERIFICATION_EXECUTION_RESULT_MISSING":
      return 404;
    case "VERIFICATION_IN_PROGRESS":
    case "VERIFICATION_ALREADY_DECIDED":
    case "VERIFICATION_NOT_READY":
    case "VERIFICATION_BINDING_MISMATCH":
    case "VERIFICATION_AUTHORITY_MISMATCH":
    case "VERIFICATION_STEP_STATE_UNKNOWN":
    case "COMPLETION_RECORD_CONFLICT":
    case "COMPLETION_NOT_AUTHORIZED":
    case "INVALID_VERIFICATION_STATE":
      return 409;
    case "VERIFICATION_RESOURCE_BUDGET_EXCEEDED":
      return 429;
    default:
      return 409;
  }
}

export interface VerificationRouteDeps {
  verification: OutcomeVerificationService;
  readiness: VerificationReadinessService;
}

export function registerVerificationRoutes(
  app: FastifyInstance,
  deps: VerificationRouteDeps,
): void {
  app.post("/v1/runs/:runId/verify", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_VERIFICATION_REQUEST",
        message: "runId is required",
      });
    }
    try {
      const result = await deps.verification.verify(params.data.runId);
      return reply.status(200).send(result);
    } catch (error) {
      if (isVerificationError(error)) {
        return reply.status(httpStatusForVerification(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get("/v1/runs/:runId/verification", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_VERIFICATION_REQUEST",
        message: "runId is required",
      });
    }
    const result = await deps.verification.getLatestResult(params.data.runId);
    if (!result) {
      return reply.status(404).send({
        error: "VERIFICATION_NOT_FOUND",
        message: `No verification result for run ${params.data.runId}`,
      });
    }
    return reply.status(200).send(result);
  });

  app.get(
    "/v1/runs/:runId/verification-evidence",
    async (request, reply) => {
      const params = RunParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: "INVALID_VERIFICATION_REQUEST",
          message: "runId is required",
        });
      }
      const evidence = await deps.verification.listEvidence(params.data.runId);
      return reply.status(200).send({ evidence });
    },
  );

  app.get(
    "/v1/runs/:runId/verification-readiness",
    async (request, reply) => {
      const params = RunParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: "INVALID_VERIFICATION_REQUEST",
          message: "runId is required",
        });
      }
      const readiness = await deps.readiness.assess(params.data.runId);
      return reply.status(200).send(readiness);
    },
  );
}
