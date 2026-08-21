import { createHash } from "node:crypto";
import type { PriorityClass } from "./priority.js";
import type { SchedulerWorkKind } from "./work-kind.js";

/**
 * Logical work identity. Repeated discovery must reuse the same item.
 */
export function workLogicalIdentityKey(input: {
  runId: string;
  workKind: SchedulerWorkKind;
  bindingHash: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        bindingHash: input.bindingHash,
        runId: input.runId,
        workKind: input.workKind,
      }),
      "utf8",
    )
    .digest("hex");
}

export function workItemIdFromIdentity(logicalIdentityKey: string): string {
  return `swi_${logicalIdentityKey.slice(0, 32)}`;
}

export function hashSchedulingMetadata(input: {
  priorityClass: PriorityClass;
  projectWeight: number;
  deadlineAt?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        deadlineAt: input.deadlineAt ?? null,
        priorityClass: input.priorityClass,
        projectWeight: input.projectWeight,
      }),
      "utf8",
    )
    .digest("hex");
}

export function hashDependencySet(dependencyIds: readonly string[]): string {
  const sorted = [...dependencyIds].sort();
  return createHash("sha256")
    .update(JSON.stringify(sorted), "utf8")
    .digest("hex");
}

export function emptyDependencySetHash(): string {
  return hashDependencySet([]);
}
