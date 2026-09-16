import { z } from "zod";
import { hashCanonical } from "./hash.js";

export const RecoveryMessageTemplateSchema = z
  .object({
    templateId: z.string().min(1),
    customerAccountId: z.string().min(1),
    projectId: z.string().min(1),
    channel: z.enum(["SMS", "EMAIL"]),
    version: z.number().int().positive(),
    body: z.string().min(1).max(2000),
    allowedVariables: z.array(z.string().min(1)).max(32),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type RecoveryMessageTemplate = z.infer<
  typeof RecoveryMessageTemplateSchema
>;

export function parseRecoveryMessageTemplate(
  input: unknown,
): RecoveryMessageTemplate {
  return RecoveryMessageTemplateSchema.parse(input);
}

export function newTemplateId(input: {
  customerAccountId: string;
  channel: string;
  version: number;
}): string {
  return `rtpl_${hashCanonical(input).slice(0, 24)}`;
}

const VAR_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export function renderTemplate(
  body: string,
  allowedVariables: readonly string[],
  values: Record<string, string>,
): string {
  const allowed = new Set(allowedVariables);
  return body.replace(VAR_RE, (_m, name: string) => {
    if (!allowed.has(name)) return "";
    return values[name] ?? "";
  });
}
