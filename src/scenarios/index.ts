export {
  DECISION_PROBLEM_STATES,
  DecisionProblemStateSchema,
  canTransitionDecisionProblem,
  DISCOVERABLE_DECISION_PROBLEM_STATES,
  isTerminalDecisionProblemState,
  TERMINAL_DECISION_PROBLEM_STATES,
  type DecisionProblemState,
} from "./decision-state.js";
export {
  ScenarioError,
  isScenarioError,
  SCENARIO_ERROR_CODES,
  type ScenarioErrorCode,
} from "./errors.js";
export {
  SCENARIO_EVIDENCE_AUTHORITY_CLASSES,
  ScenarioEvidenceAuthorityClassSchema,
  LabeledScenarioEvidenceSchema,
  labelScenarioEvidence,
  SCENARIO_DOCTRINE,
  type ScenarioEvidenceAuthorityClass,
  type LabeledScenarioEvidence,
} from "./evidence-classes.js";
export {
  QUANTITY_UNITS,
  QuantityUnitSchema,
  QuantifiedValueSchema,
  ScenarioAssumptionSchema,
  AssumptionSetSchema,
  parseAssumptions,
  validateAssumptionSet,
  assumptionSetHash,
  withAssumptionSetHash,
  assertCompatibleUnits,
  type QuantityUnit,
  type QuantifiedValue,
  type ScenarioAssumption,
  type AssumptionSet,
} from "./assumptions.js";
export {
  DecisionCriterionSchema,
  DecisionProblemSchema,
  INITIAL_DECISION_PROBLEM_VERSION,
  parseDecisionProblem,
  assertDecisionTransition,
  validateDecisionCriteria,
  decisionProblemContentFingerprint,
  decisionProblemIdempotencyKey,
  mintDecisionProblemId,
  type DecisionCriterion,
  type DecisionProblem,
} from "./decision-problem.js";
export {
  ScenarioDefinitionSchema,
  ScenarioSetSchema,
  INITIAL_SCENARIO_SET_VERSION,
  BASELINE_SEMANTICS,
  validateScenarioSet,
  scenarioSetCanonicalPayload,
  computeScenarioSetHash,
  withScenarioSetHash,
  mintScenarioSetId,
  mintScenarioId,
  type ScenarioDefinition,
  type ScenarioSet,
} from "./scenario.js";
export {
  SIMULATION_ENGINE_VERSION,
  SIMULATION_RESULT_CAVEAT,
  UncertaintyRepresentationSchema,
  ScenarioSimulationResultSchema,
  simulationInputFingerprint,
  mintSimulationRunId,
  simulationConfigurationFingerprint,
  type UncertaintyRepresentation,
  type ScenarioSimulationResult,
} from "./simulation-result.js";
export {
  FakeScenarioGenerationModel,
  ScenarioGenerationProposalSchema,
  type ScenarioGenerationModel,
  type ScenarioGenerationProposal,
} from "./generation-model.js";
export {
  FakeScenarioSimulationEngine,
  type ScenarioSimulationEngine,
  type ScenarioSimulationInput,
} from "./simulation-engine.js";
export {
  compareScenarios,
  scenarioDominates,
  checkHardConstraints,
  DefaultScenarioComparisonService,
  AUTHORITATIVE_WEIGHT_POLICY,
  normalizeAuthoritativeWeights,
  CriterionDeltaSchema,
  HardConstraintViolationSchema,
  RankedScenarioSchema,
  ScenarioComparisonResultSchema,
  type ScenarioComparisonService,
  type CriterionDelta,
  type HardConstraintViolation,
  type RankedScenario,
  type ScenarioComparisonResult,
} from "./comparison.js";
export {
  runSensitivity,
  DefaultScenarioRobustnessAnalyzer,
  SensitivityFindingSchema,
  SensitivityAnalysisResultSchema,
  type ScenarioRobustnessAnalyzer,
  type SensitivityFinding,
  type SensitivityAnalysisResult,
} from "./sensitivity.js";
export {
  StrategicDecisionPackageSchema,
  INITIAL_DECISION_PACKAGE_VERSION,
  MODEL_WEIGHT_AUTHORITY,
  withDecisionPackageHash,
  computeDecisionPackageHash,
  mintDecisionPackageId,
  assertAuthoritativeCriteriaMatchProblem,
  assertModelWeightsNotUsedAsAuthority,
  type StrategicDecisionPackage,
} from "./decision-package.js";
export {
  STRATEGY_SELECTION_DECISIONS,
  StrategySelectionDecisionSchema,
  StrategySelectionRequestSchema,
  StrategySelectionRecordSchema,
  STRATEGY_SELECTION_AUTHORITY_BOUNDARIES,
  computeSelectionSubjectHash,
  mintSelectionId,
  mintSelectionRecordId,
  assertStrategySelectionDoesNotAllocate,
  assertStrategySelectorDistinctFromApprover,
  assertStrategySelectorDistinctFromPortfolioAllocator,
  assertStrategySelectorDistinctFromProgramMaterializer,
  type StrategySelectionDecision,
  type StrategySelectionRequest,
  type StrategySelectionRecord,
} from "./selection.js";
export {
  ScenarioPortfolioLineageSchema,
  ScenarioCalibrationRecordSchema,
  scenarioPortfolioLineageIdFor,
  mintCalibrationId,
  assertSelectionDoesNotAllocateCapital,
  assertCalibrationIsObservationalOnly,
  type ScenarioPortfolioLineage,
  type ScenarioCalibrationRecord,
} from "./lineage.js";
export {
  Phase15PortfolioProposalAdmissionPort,
  FakePortfolioProposalAdmissionPort,
  type PortfolioProposalAdmissionPort,
  type PortfolioProposalAdmissionOutcome,
  type PortfolioProposalAdmissionRequest,
} from "./portfolio-admission-port.js";
export {
  defaultPortfolioIntentFromDecisionProblem,
  compileProposedPortfolioIntent,
  compiledPortfolioIntentHash,
} from "./portfolio-intent-compiler.js";
export {
  validateDecisionPackage,
  validateScenarioSet as validateDecisionScenarioSet,
  assertValidDecisionPackage,
  DECISION_PACKAGE_VALIDATION_STEPS,
  type DecisionPackageValidationStep,
  type DecisionPackageValidationOutcome,
  type DecisionPackageValidationFinding,
  type DecisionPackageValidationResult,
  type ScenarioSetValidationResult,
} from "./validator.js";
export type {
  DecisionProblemRepository,
  ScenarioSetRepository,
  SimulationResultRepository,
  DecisionPackageRepository,
  StrategySelectionRequestRepository,
  StrategySelectionRecordRepository,
  ScenarioPortfolioLineageRepository,
  ScenarioCalibrationRepository,
  SimulationUsageLedger,
  SimulationUsageLedgerRepository,
} from "./repositories.js";
export {
  InMemoryDecisionProblemRepository,
  InMemoryScenarioSetRepository,
  InMemorySimulationResultRepository,
  InMemoryDecisionPackageRepository,
  InMemoryStrategySelectionRequestRepository,
  InMemoryStrategySelectionRecordRepository,
  InMemoryScenarioPortfolioLineageRepository,
  InMemoryScenarioCalibrationRepository,
  InMemorySimulationUsageLedgerRepository,
} from "./memory-repositories.js";
export {
  ScenarioOrchestrationService,
  SCENARIO_AUTHORITY_BOUNDARIES,
  assertScenarioAuthoritySeparation,
  type DecisionProblemAdmissionRequest,
  type DecisionProblemAdmissionOutcome,
  type ScenarioOrchestrationServiceDeps,
  type ScenarioSimulationFailpoint,
} from "./service.js";
export { ScenarioProgressionLoop } from "./loops.js";
export { ScenarioWorkMaterializer } from "./work-materializer.js";
