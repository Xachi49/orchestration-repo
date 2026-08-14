import { createHash } from "node:crypto";
import type { ExecutionPlanForHash } from "./execution-plan.js";

/**
 * Recursively sorts object keys and normalizes arrays of objects by
 * stable JSON canonicalization so field order does not affect hashes.
 */
export function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    result[key] = canonicalizeValue(record[key]);
  }
  return result;
}

export function canonicalizePlan(plan: ExecutionPlanForHash): string {
  const withoutHash = { ...plan } as Record<string, unknown>;
  delete withoutHash["planHash"];
  return JSON.stringify(canonicalizeValue(withoutHash));
}

export interface PlanHasher {
  hash(plan: ExecutionPlanForHash): string;
  canonicalize(plan: ExecutionPlanForHash): string;
}

export class Sha256PlanHasher implements PlanHasher {
  canonicalize(plan: ExecutionPlanForHash): string {
    return canonicalizePlan(plan);
  }

  hash(plan: ExecutionPlanForHash): string {
    const canonical = this.canonicalize(plan);
    return createHash("sha256").update(canonical, "utf8").digest("hex");
  }
}
