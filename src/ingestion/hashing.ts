import { createHash } from "node:crypto";

export function sha256Buffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry !== undefined) {
      result[key] = canonicalizeValue(entry);
    }
  }
  return result;
}

export function hashCanonical(value: unknown): string {
  return sha256Text(JSON.stringify(canonicalizeValue(value)));
}

export function posixRelative(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}
