import { z } from "zod";

export const ObservabilityPhaseSchema = z.enum([
  "ADMISSION",
  "INGESTION",
  "PLANNING",
  "VALIDATION",
  "AUTHORIZATION",
  "EXECUTION",
  "VERIFICATION",
  "LEARNING",
]);
export type ObservabilityPhase = z.infer<typeof ObservabilityPhaseSchema>;
