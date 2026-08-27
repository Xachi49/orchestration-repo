import type { GovernedExperiment } from "./experiment.js";
import type { ExperimentPlan } from "./plan.js";
import { ExperimentError } from "./errors.js";
import { validateHypothesisMeasurability } from "./hypothesis.js";
import { assertCompatibleUnits } from "./hypothesis.js";

export const EXPERIMENT_VALIDATION_STEPS = [
  "SCHEMA",
  "VERSION_HASH",
  "HYPOTHESIS_MEASURABILITY",
  "MEASUREMENT_UNITS",
  "ASSUMPTION_BINDINGS",
  "SCOPE",
  "BUDGET",
  "STOPPING_RULES",
  "AUTHORITY_FINGERPRINT",
  "SECURITY",
] as const;

export type ExperimentValidationStep =
  (typeof EXPERIMENT_VALIDATION_STEPS)[number];

export type ExperimentValidationOutcome =
  | "PASS"
  | "BLOCK"
  | "HUMAN_APPROVAL_REQUIRED"
  | "REVISE";

export interface ExperimentValidationFinding {
  step: ExperimentValidationStep;
  severity: "BLOCK" | "WARN";
  code: string;
  message: string;
}

export interface ExperimentValidationResult {
  outcome: ExperimentValidationOutcome;
  findings: readonly ExperimentValidationFinding[];
}

export function validateExperimentPlan(input: {
  experiment: GovernedExperiment;
  plan: ExperimentPlan;
}): ExperimentValidationResult {
  const findings: ExperimentValidationFinding[] = [];
  const { experiment, plan } = input;

  if (plan.experimentId !== experiment.experimentId) {
    findings.push({
      step: "SCHEMA",
      severity: "BLOCK",
      code: "EXPERIMENT_ID_MISMATCH",
      message: "Plan experimentId must match experiment",
    });
  }

  for (const h of plan.hypotheses) {
    try {
      validateHypothesisMeasurability(h);
    } catch (err) {
      findings.push({
        step: "HYPOTHESIS_MEASURABILITY",
        severity: "BLOCK",
        code: "HYPOTHESIS_INVALID",
        message: err instanceof Error ? err.message : "Invalid hypothesis",
      });
    }
  }

  const units = new Set(plan.measurements.map((m) => m.unit));
  if (units.size !== plan.measurements.length) {
    // Multiple measurements may share units — only reject cross-unit ops in analysis.
  }
  for (const m of plan.measurements) {
    try {
      assertCompatibleUnits(m.unit, m.unit, "identity");
    } catch {
      findings.push({
        step: "MEASUREMENT_UNITS",
        severity: "BLOCK",
        code: "UNIT_INVALID",
        message: `Invalid unit on measurement ${m.measurementId}`,
      });
    }
  }

  for (const binding of plan.assumptionBindings) {
    if (!experiment.sourceAssumptionIds.includes(binding.assumptionId)) {
      // Allow binding declared assumptions on experiment or plan
      if (
        !plan.hypotheses.some((h) => h.sourceAssumptionId === binding.assumptionId)
      ) {
        findings.push({
          step: "ASSUMPTION_BINDINGS",
          severity: "BLOCK",
          code: "UNBOUND_ASSUMPTION",
          message: `Binding assumption ${binding.assumptionId} not declared on experiment`,
        });
      }
    }
  }

  if (plan.stoppingRules.length === 0) {
    findings.push({
      step: "STOPPING_RULES",
      severity: "BLOCK",
      code: "STOPPING_RULES_REQUIRED",
      message: "At least one stopping rule required",
    });
  }

  if (
    plan.resourceEstimate.maximumActions > experiment.budgetEnvelope.maximumActions ||
    plan.resourceEstimate.maximumSampleSize >
      experiment.budgetEnvelope.maximumSampleSize
  ) {
    findings.push({
      step: "BUDGET",
      severity: "BLOCK",
      code: "BUDGET_OVERFLOW",
      message: "Plan resource estimate exceeds experiment budget envelope",
    });
  }

  if (
    plan.policyBundleFingerprint !== experiment.policyBundleFingerprint ||
    plan.capabilitySetFingerprint !== experiment.capabilitySetFingerprint ||
    plan.projectConfigurationFingerprint !==
      experiment.projectConfigurationFingerprint
  ) {
    findings.push({
      step: "AUTHORITY_FINGERPRINT",
      severity: "BLOCK",
      code: "AUTHORITY_DRIFT",
      message: "Plan authority fingerprints do not match experiment freeze",
    });
  }

  // Model-suggested risk must never override experiment riskClass.
  if (plan.riskClass !== experiment.riskClass) {
    findings.push({
      step: "SECURITY",
      severity: "BLOCK",
      code: "RISK_CLASS_MISMATCH",
      message: "Plan riskClass must equal experiment.riskClass (authoritative)",
    });
  }

  const blocked = findings.some((f) => f.severity === "BLOCK");
  if (blocked) {
    return { outcome: "BLOCK", findings };
  }
  return { outcome: "HUMAN_APPROVAL_REQUIRED", findings };
}

export function assertValidExperimentPlan(
  input: Parameters<typeof validateExperimentPlan>[0],
): void {
  const result = validateExperimentPlan(input);
  if (result.outcome === "BLOCK") {
    throw new ExperimentError(
      "EXPERIMENT_PLAN_INVALID",
      result.findings.map((f) => f.message).join("; "),
      { findings: result.findings },
    );
  }
}
