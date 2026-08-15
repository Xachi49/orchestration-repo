import { createHash } from "node:crypto";
import type { ValidationValidatorType } from "../domain/validation/index.js";

export const VIOLATION_FINGERPRINT_VERSION = "1.0.0";

export interface ViolationFingerprintInput {
  validatorType: ValidationValidatorType;
  ruleId: string;
  category: string;
  affectedStepIds?: readonly string[];
  /** Additional normalized discriminators (action type, dimension, sha, ...). */
  subject?: Readonly<Record<string, unknown>>;
}

/**
 * Deterministic semantic fingerprint for a violation.
 *
 * No embeddings, no similarity search, no model involvement: the same semantic
 * violation recurring across plan revisions must produce a byte-identical
 * fingerprint so `ValidationService` can detect a revision loop.
 *
 * Volatile tokens (identifiers, hashes, timestamps, numbers) are normalized out
 * of free text so a reworded message does not disguise the same violation.
 */
export class ViolationFingerprintService {
  readonly version = VIOLATION_FINGERPRINT_VERSION;

  normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
        "<uuid>",
      )
      .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z\b/g, "<timestamp>")
      .replace(/\b[0-9a-f]{8,}\b/g, "<hash>")
      .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
      .replace(/[^a-z0-9<>_./-]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  normalizeIds(ids: readonly string[] | undefined): string[] {
    return [...new Set(ids ?? [])]
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0)
      .sort((a, b) => a.localeCompare(b));
  }

  private normalizeSubject(
    subject: Readonly<Record<string, unknown>> | undefined,
  ): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const key of Object.keys(subject ?? {}).sort()) {
      const value = (subject ?? {})[key];
      if (value === undefined || value === null) {
        continue;
      }
      normalized[key.toLowerCase()] = Array.isArray(value)
        ? this.normalizeIds(value.map((item) => String(item))).join(",")
        : this.normalizeText(String(value));
    }
    return normalized;
  }

  fingerprint(input: ViolationFingerprintInput): string {
    const canonical = JSON.stringify({
      version: this.version,
      validatorType: input.validatorType,
      ruleId: this.normalizeText(input.ruleId),
      category: this.normalizeText(input.category),
      affectedStepIds: this.normalizeIds(input.affectedStepIds),
      subject: this.normalizeSubject(input.subject),
    });
    const digest = createHash("sha256")
      .update(canonical, "utf8")
      .digest("hex")
      .slice(0, 16);
    return `${input.validatorType}:${input.ruleId}:${digest}`;
  }

  matches(left: string, right: string): boolean {
    return left === right;
  }

  /** Fingerprints present in both the prior and current violation sets. */
  repeated(
    previous: Iterable<string>,
    current: Iterable<string>,
  ): string[] {
    const seen = new Set(previous);
    const hits = new Set<string>();
    for (const fingerprint of current) {
      if (seen.has(fingerprint)) {
        hits.add(fingerprint);
      }
    }
    return [...hits].sort((a, b) => a.localeCompare(b));
  }

  hasRepeat(previous: Iterable<string>, current: Iterable<string>): boolean {
    return this.repeated(previous, current).length > 0;
  }
}
