import { z } from "zod";
import { AssuranceError } from "./errors.js";

export const FAULT_INJECTION_POINTS = [
  "AFTER_CERTIFICATE_MATERIAL_BEFORE_COMMIT",
  "AFTER_ASSESSMENT_BEFORE_AUDIT",
  "WORKER_LEASE_LOSS",
  "TRANSACTION_ROLLBACK",
] as const;

export type FaultInjectionPoint = (typeof FAULT_INJECTION_POINTS)[number];

export const FaultInjectionRequestSchema = z
  .object({
    point: z.enum(FAULT_INJECTION_POINTS),
    assuranceRunId: z.string().min(1),
    environment: z.enum(["TEST", "STAGING", "PRODUCTION"]),
  })
  .strict();

export type FaultInjectionRequest = z.infer<typeof FaultInjectionRequestSchema>;

export function assertFaultInjectionAllowed(
  request: FaultInjectionRequest,
): void {
  const parsed = FaultInjectionRequestSchema.parse(request);
  if (parsed.environment === "PRODUCTION") {
    throw new AssuranceError(
      "ASSURANCE_FAULT_INJECTION_DENIED",
      "Fault injection is denied in PRODUCTION before any mutation",
      { point: parsed.point, environment: parsed.environment },
    );
  }
}

export type FaultInjectionRegistry = {
  armed?: FaultInjectionRequest | undefined;
  arm(request: FaultInjectionRequest): void;
  maybeTrigger(point: FaultInjectionPoint, assuranceRunId: string): void;
};

export function createFaultInjectionRegistry(): FaultInjectionRegistry {
  let armed: FaultInjectionRequest | undefined;
  return {
    get armed(): FaultInjectionRequest | undefined {
      return armed;
    },
    arm(request) {
      assertFaultInjectionAllowed(request);
      armed = request;
    },
    maybeTrigger(point, assuranceRunId) {
      if (!armed) return;
      if (armed.point !== point) return;
      if (armed.assuranceRunId !== assuranceRunId) return;
      assertFaultInjectionAllowed(armed);
      const payload = armed;
      armed = undefined;
      throw new AssuranceError(
        "ASSURANCE_EVALUATION_FAILED",
        `Fault injection triggered at ${payload.point}`,
        { point: payload.point, assuranceRunId },
      );
    },
  };
}
