import type { DecisionProblem } from "./decision-problem.js";
import { computeDecisionPackageHash } from "./decision-package.js";
import type { StrategicDecisionPackage } from "./decision-package.js";
import { ScenarioError } from "./errors.js";
import type { ScenarioSet } from "./scenario.js";
import { computeScenarioSetHash } from "./scenario.js";
import type { ScenarioSimulationResult } from "./simulation-result.js";
import { SIMULATION_ENGINE_VERSION } from "./simulation-result.js";

export const DECISION_PACKAGE_VALIDATION_STEPS = [
  "SCHEMA",
  "VERSION_HASH",
  "BASELINE",
  "SCENARIO_SET",
  "SIMULATION_BINDINGS",
  "REPRODUCIBILITY",
  "AUTHORITY_FINGERPRINT",
  "CRITERIA_AUTHORITY",
  "HARD_CONSTRAINTS",
  "UNIT_CHECKS",
] as const;

export type DecisionPackageValidationStep =
  (typeof DECISION_PACKAGE_VALIDATION_STEPS)[number];

export type DecisionPackageValidationOutcome =
  | "PASS"
  | "BLOCK"
  | "HUMAN_APPROVAL_REQUIRED"
  | "REVISE";

export interface DecisionPackageValidationFinding {
  step: DecisionPackageValidationStep;
  severity: "BLOCK" | "WARN";
  code: string;
  message: string;
}

export interface DecisionPackageValidationResult {
  outcome: DecisionPackageValidationOutcome;
  findings: readonly DecisionPackageValidationFinding[];
}

export interface ScenarioSetValidationResult {
  outcome: DecisionPackageValidationOutcome;
  findings: readonly DecisionPackageValidationFinding[];
}

export function validateScenarioSet(
  problem: DecisionProblem,
  set: ScenarioSet,
): ScenarioSetValidationResult {
  const findings: DecisionPackageValidationFinding[] = [];

  if (set.decisionProblemId !== problem.decisionProblemId) {
    findings.push({
      step: "SCENARIO_SET",
      severity: "BLOCK",
      code: "DECISION_PROBLEM_MISMATCH",
      message: "Scenario set decisionProblemId mismatch",
    });
  }

  if (set.decisionProblemVersion !== problem.decisionProblemVersion) {
    findings.push({
      step: "SCENARIO_SET",
      severity: "BLOCK",
      code: "DECISION_VERSION_MISMATCH",
      message: "Scenario set decisionProblemVersion mismatch",
    });
  }

  const { scenarioSetHash: _ignored, ...rest } = set;
  void _ignored;
  const recomputed = computeScenarioSetHash(rest);
  if (set.scenarioSetHash !== recomputed) {
    findings.push({
      step: "VERSION_HASH",
      severity: "BLOCK",
      code: "SCENARIO_SET_HASH_MISMATCH",
      message: "scenarioSetHash does not match canonical payload",
    });
  }

  if (!set.scenarios.some((s) => s.scenarioId === set.baselineScenarioId)) {
    findings.push({
      step: "BASELINE",
      severity: "BLOCK",
      code: "BASELINE_MISSING",
      message: "Baseline scenario missing from set",
    });
  }

  if (
    problem.truthSnapshotFingerprint &&
    set.truthSnapshotFingerprint !== problem.truthSnapshotFingerprint
  ) {
    findings.push({
      step: "AUTHORITY_FINGERPRINT",
      severity: "BLOCK",
      code: "TRUTH_DRIFT",
      message: "Scenario set truth snapshot does not match grounded problem",
    });
  }

  if (set.scenarios.length > problem.maximumScenarioCount) {
    findings.push({
      step: "SCENARIO_SET",
      severity: "BLOCK",
      code: "SCENARIO_COUNT_EXCEEDED",
      message: `Scenario count ${set.scenarios.length} exceeds maximum ${problem.maximumScenarioCount}`,
    });
  }

  const blocked = findings.some((f) => f.severity === "BLOCK");
  if (blocked) {
    return { outcome: "BLOCK", findings };
  }
  return { outcome: "PASS", findings };
}

export function validateDecisionPackage(input: {
  problem: DecisionProblem;
  scenarioSet: ScenarioSet;
  pkg: Omit<StrategicDecisionPackage, "decisionPackageHash"> & {
    decisionPackageHash?: string;
  };
  simulationResults: readonly ScenarioSimulationResult[];
}): DecisionPackageValidationResult {
  const findings: DecisionPackageValidationFinding[] = [];
  const { problem, scenarioSet, pkg, simulationResults } = input;

  const setResult = validateScenarioSet(problem, scenarioSet);
  findings.push(...setResult.findings);

  if (pkg.decisionPackageHash) {
    const { decisionPackageHash: _ignored, ...rest } =
      pkg as StrategicDecisionPackage;
    void _ignored;
    const recomputed = computeDecisionPackageHash(rest);
    if (pkg.decisionPackageHash !== recomputed) {
      findings.push({
        step: "VERSION_HASH",
        severity: "BLOCK",
        code: "DECISION_PACKAGE_HASH_MISMATCH",
        message: "decisionPackageHash does not match canonical payload",
      });
    }
  }

  if (pkg.scenarioSetHash !== scenarioSet.scenarioSetHash) {
    findings.push({
      step: "SCENARIO_SET",
      severity: "BLOCK",
      code: "SCENARIO_SET_HASH_MISMATCH",
      message: "Package scenarioSetHash mismatch",
    });
  }

  const scenarioIds = new Set(scenarioSet.scenarios.map((s) => s.scenarioId));
  for (const result of simulationResults) {
    if (!scenarioIds.has(result.scenarioId)) {
      findings.push({
        step: "SIMULATION_BINDINGS",
        severity: "BLOCK",
        code: "UNKNOWN_SCENARIO_RESULT",
        message: `Simulation result for unknown scenario ${result.scenarioId}`,
      });
    }
    if (result.engineVersion !== SIMULATION_ENGINE_VERSION) {
      findings.push({
        step: "REPRODUCIBILITY",
        severity: "BLOCK",
        code: "ENGINE_VERSION_MISMATCH",
        message: `Unexpected engine version ${result.engineVersion}`,
      });
    }
    if (result.truthSnapshotFingerprint !== pkg.truthSnapshotFingerprint) {
      findings.push({
        step: "AUTHORITY_FINGERPRINT",
        severity: "BLOCK",
        code: "TRUTH_DRIFT",
        message: "Simulation truth snapshot mismatch",
      });
    }
  }

  if (
    pkg.comparison.baselineScenarioId !== scenarioSet.baselineScenarioId
  ) {
    findings.push({
      step: "BASELINE",
      severity: "BLOCK",
      code: "BASELINE_MISMATCH",
      message: "Comparison baseline does not match scenario set baseline",
    });
  }

  if (pkg.comparison.hardConstraintViolations.length > 0) {
    findings.push({
      step: "HARD_CONSTRAINTS",
      severity: "WARN",
      code: "HARD_CONSTRAINT_VIOLATIONS",
      message: `${pkg.comparison.hardConstraintViolations.length} hard constraint violation(s) excluded from recommendations`,
    });
  }

  const violatingIds = new Set(
    pkg.comparison.hardConstraintViolations.map((v) => v.scenarioId),
  );
  for (const recommendedId of pkg.recommendedScenarioIds) {
    if (violatingIds.has(recommendedId)) {
      findings.push({
        step: "HARD_CONSTRAINTS",
        severity: "BLOCK",
        code: "RECOMMENDED_HARD_CONSTRAINT_VIOLATOR",
        message: `Recommended scenario ${recommendedId} violates hard constraints`,
      });
    }
  }

  if (pkg.recommendedScenarioIds.length === 0) {
    findings.push({
      step: "HARD_CONSTRAINTS",
      severity: "BLOCK",
      code: "NO_ELIGIBLE_RECOMMENDATION",
      message: "No scenarios remain eligible under hard constraints",
    });
  }

  if (
    JSON.stringify(pkg.authoritativeDecisionCriteria) !==
    JSON.stringify(problem.decisionCriteria)
  ) {
    findings.push({
      step: "CRITERIA_AUTHORITY",
      severity: "BLOCK",
      code: "AUTHORITATIVE_CRITERIA_MISMATCH",
      message:
        "Package authoritativeDecisionCriteria must equal DecisionProblem.decisionCriteria",
    });
  }

  if (
    pkg.policyBundleFingerprint !== problem.policyBundleFingerprint ||
    pkg.capabilitySetFingerprint !== problem.capabilitySetFingerprint ||
    pkg.projectConfigurationFingerprint !==
      problem.projectConfigurationFingerprint
  ) {
    findings.push({
      step: "AUTHORITY_FINGERPRINT",
      severity: "BLOCK",
      code: "AUTHORITY_DRIFT",
      message: "Decision package authority fingerprints do not match problem",
    });
  }

  if (!pkg.requiredHumanDecisions.includes("STRATEGY_SELECTOR")) {
    findings.push({
      step: "SCHEMA",
      severity: "BLOCK",
      code: "STRATEGY_SELECTOR_REQUIRED",
      message: "Package must require STRATEGY_SELECTOR human decision",
    });
  }

  const blocked = findings.some((f) => f.severity === "BLOCK");
  if (blocked) {
    return { outcome: "BLOCK", findings };
  }
  if (
    pkg.comparison.rankedScenarios.length === 0 &&
    pkg.comparison.hardConstraintViolations.length > 0
  ) {
    return { outcome: "REVISE", findings };
  }
  return { outcome: "HUMAN_APPROVAL_REQUIRED", findings };
}

export function assertValidDecisionPackage(
  input: Parameters<typeof validateDecisionPackage>[0],
): void {
  const result = validateDecisionPackage(input);
  if (result.outcome === "BLOCK") {
    throw new ScenarioError(
      "DECISION_PACKAGE_INVALID",
      result.findings.map((f) => f.message).join("; "),
      { findings: result.findings },
    );
  }
}
