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

/**
 * Rendering variables the server can supply at Phase7 actuation.
 * Values resolve from the canonical Lead / RecoveryConfiguration only.
 */
export const SUPPORTED_RECOVERY_TEMPLATE_VARIABLES = [
  "firstName",
  "lastName",
  "businessName",
  "serviceRequested",
  "serviceArea",
  "bookingLink",
] as const;

export type SupportedRecoveryTemplateVariable =
  (typeof SUPPORTED_RECOVERY_TEMPLATE_VARIABLES)[number];

const SUPPORTED_VARIABLE_SET = new Set<string>(
  SUPPORTED_RECOVERY_TEMPLATE_VARIABLES,
);

/**
 * Operator-supplied template identity. Excludes `:` and `@` so the value
 * round-trips through `rr_template:<templateId>@<version>`.
 */
export const RECOVERY_TEMPLATE_ID_PATTERN = /^rtpl_[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const RecoveryTemplateProvisionInputSchema = z
  .object({
    templateId: z.string().max(100).regex(RECOVERY_TEMPLATE_ID_PATTERN),
    version: z.number().int().positive(),
    customerAccountId: z.string().min(1).max(200).regex(IDENTIFIER_PATTERN),
    projectId: z.string().min(1).max(200).regex(IDENTIFIER_PATTERN),
    channel: z.enum(["SMS", "EMAIL"]),
    body: z.string().min(1).max(2000),
    allowedVariables: z.array(z.string().min(1)).max(32),
    // Disable is not supported; a disabled row could never become bindable.
    enabled: z.literal(true),
  })
  .strict();

export type RecoveryTemplateProvisionInput = z.infer<
  typeof RecoveryTemplateProvisionInputSchema
>;

export type TemplatePlaceholderValidation =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "BODY_EMPTY"
        | "UNSUPPORTED_VARIABLE"
        | "DUPLICATE_VARIABLE"
        | "UNDECLARED_PLACEHOLDER"
        | "MALFORMED_PLACEHOLDER";
      variables: readonly string[];
    };

const VAR_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Fail-closed placeholder contract: every `{{name}}` in body must be declared
 * in allowedVariables, and every declared variable must be server-supported.
 */
export function validateTemplatePlaceholders(input: {
  body: string;
  allowedVariables: readonly string[];
}): TemplatePlaceholderValidation {
  if (input.body.trim().length === 0) {
    return { ok: false, reason: "BODY_EMPTY", variables: [] };
  }

  const unsupported = input.allowedVariables.filter(
    (v) => !SUPPORTED_VARIABLE_SET.has(v),
  );
  if (unsupported.length > 0) {
    return { ok: false, reason: "UNSUPPORTED_VARIABLE", variables: unsupported };
  }
  const duplicates = input.allowedVariables.filter(
    (v, i) => input.allowedVariables.indexOf(v) !== i,
  );
  if (duplicates.length > 0) {
    return { ok: false, reason: "DUPLICATE_VARIABLE", variables: duplicates };
  }

  const placeholders = [...input.body.matchAll(VAR_RE)].map((m) => m[1]!);
  const unsupportedPlaceholders = placeholders.filter(
    (p) => !SUPPORTED_VARIABLE_SET.has(p),
  );
  if (unsupportedPlaceholders.length > 0) {
    return {
      ok: false,
      reason: "UNSUPPORTED_VARIABLE",
      variables: [...new Set(unsupportedPlaceholders)],
    };
  }
  const declared = new Set(input.allowedVariables);
  const undeclared = placeholders.filter((p) => !declared.has(p));
  if (undeclared.length > 0) {
    return {
      ok: false,
      reason: "UNDECLARED_PLACEHOLDER",
      variables: [...new Set(undeclared)],
    };
  }

  const residue = input.body.replace(VAR_RE, "");
  if (residue.includes("{{") || residue.includes("}}")) {
    return { ok: false, reason: "MALFORMED_PLACEHOLDER", variables: [] };
  }
  return { ok: true };
}

/** Write-once comparison over every caller-controlled field (excludes createdAt). */
export function sameImmutableTemplateContent(
  a: Omit<RecoveryMessageTemplate, "createdAt">,
  b: Omit<RecoveryMessageTemplate, "createdAt">,
): boolean {
  return (
    a.templateId === b.templateId &&
    a.version === b.version &&
    a.customerAccountId === b.customerAccountId &&
    a.projectId === b.projectId &&
    a.channel === b.channel &&
    a.body === b.body &&
    a.enabled === b.enabled &&
    a.allowedVariables.length === b.allowedVariables.length &&
    a.allowedVariables.every((v, i) => v === b.allowedVariables[i])
  );
}

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
