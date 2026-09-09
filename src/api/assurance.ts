import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  isAssuranceError,
  type AssuranceOrchestrationService,
  AssuranceTargetIdentitySchema,
} from "../assurance/index.js";

function httpStatusForAssurance(code: string): number {
  switch (code) {
    case "ASSURANCE_NOT_FOUND":
      return 404;
    case "ASSURANCE_SEPARATION_VIOLATION":
    case "ASSURANCE_AUTHORITY_REQUIRED":
    case "ASSURANCE_CERTIFIER_REQUIRED":
    case "ASSURANCE_FAULT_INJECTION_DENIED":
      return 403;
    case "ASSURANCE_CAS_CONFLICT":
    case "ASSURANCE_CERTIFICATION_CONFLICT":
    case "ASSURANCE_STATE_CONFLICT":
      return 409;
    case "ASSURANCE_TARGET_DRIFT":
    case "ASSURANCE_EVIDENCE_STALE":
    case "ASSURANCE_EVIDENCE_TAMPERED":
    case "ASSURANCE_PROOF_STALE":
    case "ASSURANCE_NOT_QUALIFIED":
    case "ASSURANCE_INCONCLUSIVE":
      return 422;
    default:
      return 400;
  }
}

export function registerAssuranceRoutes(
  app: FastifyInstance,
  deps: { assuranceService: AssuranceOrchestrationService },
): void {
  const service = deps.assuranceService;

  app.post("/v1/assurance/runs", async (request, reply) => {
    const body = z
      .object({
        target: AssuranceTargetIdentitySchema,
        profileId: z.string().min(1),
        profileVersion: z.number().int().positive(),
        initiatedByPrincipalId: z.string().min(1),
        institutionalAuthorizationProofId: z.string().min(1),
        projectId: z.string().min(1),
        environment: z.enum(["TEST", "STAGING", "PRODUCTION"]),
      })
      .strict()
      .parse(request.body);
    try {
      const run = await service.createRun(body);
      return reply.code(201).send(run);
    } catch (error) {
      if (isAssuranceError(error)) {
        return reply.code(httpStatusForAssurance(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get("/v1/assurance/runs/:runId", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    const run = await service.getRun(params.runId);
    if (!run) {
      return reply.code(404).send({ error: "ASSURANCE_NOT_FOUND" });
    }
    return reply.send(run);
  });

  app.post("/v1/assurance/runs/:runId/evaluate", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    try {
      await service.compilePlan(params.runId);
      const result = await service.evaluate(params.runId);
      return reply.send(result);
    } catch (error) {
      if (isAssuranceError(error)) {
        return reply.code(httpStatusForAssurance(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get("/v1/assurance/runs/:runId/findings", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    const findings = await service.listFindings(params.runId);
    return reply.send({ findings });
  });

  app.post("/v1/assurance/runs/:runId/certify", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        certifierPrincipalId: z.string().min(1),
        institutionalAuthorizationProofId: z.string().min(1),
        projectId: z.string().min(1),
        environment: z.string().min(1),
      })
      .strict()
      .parse(request.body);
    // Reject trusted PASS evidence injection via HTTP — body has no evidence fields.
    try {
      const certificate = await service.certify({
        assuranceRunId: params.runId,
        ...body,
      });
      return reply.code(201).send(certificate);
    } catch (error) {
      if (isAssuranceError(error)) {
        return reply.code(httpStatusForAssurance(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get(
    "/v1/assurance/certificates/:certificateId",
    async (request, reply) => {
      const params = z
        .object({ certificateId: z.string().min(1) })
        .parse(request.params);
      const certificate = await service.getCertificate(params.certificateId);
      if (!certificate) {
        return reply.code(404).send({ error: "ASSURANCE_NOT_FOUND" });
      }
      return reply.send(certificate);
    },
  );

  app.post(
    "/v1/assurance/certificates/:certificateId/revoke",
    async (request, reply) => {
      const params = z
        .object({ certificateId: z.string().min(1) })
        .parse(request.params);
      const body = z
        .object({
          reason: z.string().min(1),
          revokedByPrincipalId: z.string().min(1),
          institutionalAuthorizationProofId: z.string().min(1),
          projectId: z.string().min(1),
          environment: z.string().min(1),
        })
        .strict()
        .parse(request.body);
      try {
        const revocation = await service.revokeCertificate({
          certificateId: params.certificateId,
          ...body,
        });
        return reply.send(revocation);
      } catch (error) {
        if (isAssuranceError(error)) {
          return reply.code(httpStatusForAssurance(error.code)).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );
}
