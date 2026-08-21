/**
 * Priority is a scheduling hint.
 * PRIORITY != POLICY. PRIORITY != APPROVAL. PRIORITY != BUDGET.
 */
export const PRIORITY_CLASSES = [
  "CRITICAL",
  "HIGH",
  "NORMAL",
  "LOW",
  "BACKGROUND",
] as const;

export type PriorityClass = (typeof PRIORITY_CLASSES)[number];

export const PRIORITY_RANK: Readonly<Record<PriorityClass, number>> = {
  CRITICAL: 1000,
  HIGH: 800,
  NORMAL: 500,
  LOW: 200,
  BACKGROUND: 50,
};

export function parsePriorityClass(raw: string | undefined): PriorityClass {
  if (
    raw &&
    (PRIORITY_CLASSES as readonly string[]).includes(raw)
  ) {
    return raw as PriorityClass;
  }
  return "NORMAL";
}
