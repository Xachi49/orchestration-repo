import type { FastifyInstance } from "fastify";
import type { ObjectiveAdmissionService } from "../admission/service.js";
import type { AdmissionResult } from "../admission/result.js";
import { isAdmissionError } from "../admission/errors.js";

/**
 * ACTIVE_DUPLICATE maps to 409 (fail closed: the run already exists).
 * COMPLETED_DUPLICATE maps to 200 (idempotent replay of a finished admission).
 */
export function httpStatusForAdmission(result: AdmissionResult): number {
  switch (result.outcome) {
    case "ADMITTED":
      return 201;
    case "COMPLETED_DUPLICATE":
      return 200;
    case "ACTIVE_DUPLICATE":
    case "CONFLICT":
      return 409;
    case "REJECTED":
      if (result.reasonCode === "INVALID_ADMISSION_REQUEST") {
        return 400;
      }
      if (
        result.reasonCode === "REQUESTER_UNAUTHORIZED" ||
        result.reasonCode === "UNKNOWN_REQUESTER"
      ) {
        return 403;
      }
      if (result.reasonCode === "PROJECT_NOT_FOUND") {
        return 404;
      }
      return 409;
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

export function registerRunRoutes(
  app: FastifyInstance,
  admission: ObjectiveAdmissionService,
): void {
  app.post("/v1/runs", async (request, reply) => {
    try {
      const result = await admission.admit(request.body);
      return reply.status(httpStatusForAdmission(result)).send(result);
    } catch (error) {
      if (isAdmissionError(error)) {
        const status =
          error.code === "ADMISSION_COMPENSATION_FAILED" ||
          error.code === "RUN_CREATION_FAILED" ||
          error.code === "EVENT_CREATION_FAILED" ||
          error.code === "INVALID_RUN_TRANSITION"
            ? 500
            : 409;
        return reply.status(status).send({
          outcome: "REJECTED",
          reasonCode: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });
}
