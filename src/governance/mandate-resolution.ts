import type { GovernanceMandate } from "./mandate.js";

export type MandateResolutionResult =
  | { kind: "RESOLVED_NONE" }
  | {
      kind: "RESOLVED_APPLICABLE";
      mandates: readonly GovernanceMandate[];
    }
  | {
      kind: "MANDATE_CONTEXT_INSUFFICIENT";
      reason: string;
      mandateIds: readonly string[];
    }
  | {
      kind: "MANDATE_RESOLUTION_FAILED";
      reason: string;
    };

export type MandateApplicabilityInput = {
  requiredRole: string;
  projectId: string;
  environment: string;
  subjectClass: string;
  atIso: string;
  action?: string;
  riskLevel?: string;
  materialityContext?: Record<string, number>;
};

function mandateRequiresMaterialityContext(mandate: GovernanceMandate): boolean {
  return Object.keys(mandate.resourceScope).length > 0;
}

function mandateRequiresRiskContext(mandate: GovernanceMandate): boolean {
  return mandate.riskScope.length > 0;
}

function materialityMatchesMandate(
  mandate: GovernanceMandate,
  materialityContext: Record<string, number>,
): boolean {
  for (const [key, threshold] of Object.entries(mandate.resourceScope)) {
    const value = materialityContext[key];
    if (value === undefined) continue;
    if (value >= threshold) return true;
  }
  return Object.keys(mandate.resourceScope).length === 0;
}

function matchesBaseDimensions(
  mandate: GovernanceMandate,
  input: MandateApplicabilityInput,
): boolean {
  if (!mandate.projectScope.includes(input.projectId)) return false;
  if (!mandate.environmentScope.includes(input.environment)) return false;
  if (!mandate.subjectClasses.includes(input.subjectClass)) return false;
  if (!mandate.requiredAuthorities.includes(input.requiredRole)) return false;
  if (mandate.status !== "ACTIVE") return false;
  const t = Date.parse(input.atIso);
  if (Number.isNaN(t)) return false;
  if (t < Date.parse(mandate.effectiveFrom)) return false;
  if (
    mandate.effectiveUntil !== undefined &&
    t > Date.parse(mandate.effectiveUntil)
  ) {
    return false;
  }
  if (
    mandateRequiresRiskContext(mandate) &&
    input.riskLevel !== undefined &&
    !mandate.riskScope.includes(input.riskLevel)
  ) {
    return false;
  }
  if (
    mandateRequiresMaterialityContext(mandate) &&
    input.materialityContext !== undefined &&
    !materialityMatchesMandate(mandate, input.materialityContext)
  ) {
    return false;
  }
  return true;
}

/**
 * Deterministic mandate applicability with explicit outcomes.
 * Missing materiality/risk context fails closed when a candidate mandate requires it.
 */
export function resolveMandateApplicability(
  activeMandates: readonly GovernanceMandate[],
  input: MandateApplicabilityInput,
): MandateResolutionResult {
  const contextInsufficient: string[] = [];

  for (const mandate of activeMandates) {
    if (!matchesBaseDimensions(mandate, input)) continue;

    if (mandateRequiresRiskContext(mandate) && input.riskLevel === undefined) {
      contextInsufficient.push(mandate.mandateId);
      continue;
    }
    if (
      mandateRequiresMaterialityContext(mandate) &&
      input.materialityContext === undefined
    ) {
      contextInsufficient.push(mandate.mandateId);
      continue;
    }
  }

  if (contextInsufficient.length > 0) {
    return {
      kind: "MANDATE_CONTEXT_INSUFFICIENT",
      reason:
        "Active mandate matching requires risk or materiality context that was not supplied",
      mandateIds: [...new Set(contextInsufficient)],
    };
  }

  const applicable = activeMandates.filter((m) => matchesBaseDimensions(m, input));
  if (applicable.length === 0) {
    return { kind: "RESOLVED_NONE" };
  }
  return { kind: "RESOLVED_APPLICABLE", mandates: applicable };
}
