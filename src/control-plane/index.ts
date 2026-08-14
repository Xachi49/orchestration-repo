export {
  CONTROL_PLANE_ERROR_CODES,
  ControlPlaneError,
  isControlPlaneError,
  type ControlPlaneErrorCode,
} from "./errors.js";

export {
  ProjectStatusSchema,
  SensitivityClassificationSchema,
  ExecutionModeSchema,
  ProjectSchema,
  parseProject,
  type ProjectStatus,
  type SensitivityClassification,
  type ExecutionMode,
  type Project,
  type ProjectRecord,
  type ProjectRegistry,
  type ProjectRegistryPort,
} from "./projects/index.js";

export {
  CapabilityApprovalRequirementSchema,
  CapabilitySchema,
  ActionAllowanceReasonSchema,
  parseCapability,
  type CapabilityApprovalRequirement,
  type Capability,
  type CapabilityDescriptor,
  type ActionAllowanceReason,
  type ActionAllowance,
  type CapabilityRegistry,
  type CapabilityRegistryPort,
} from "./capabilities/index.js";

export {
  PolicyStatusSchema,
  PolicyEffectSchema,
  PolicyConditionSchema,
  PolicyRuleSchema,
  PolicyBundleSchema,
  parsePolicyBundle,
  type PolicyStatus,
  type PolicyEffect,
  type PolicyCondition,
  type PolicyRule,
  type PolicyBundle,
  type PolicyBundleRef,
  type PolicyRegistry,
  type PolicyRegistryPort,
} from "./policies/index.js";

export {
  ExecutionWindowSchema,
  ResourceBudgetProfileSchema,
  BudgetResourceEstimateSchema,
  BudgetComparisonResultSchema,
  BUDGET_DIMENSIONS,
  BUDGET_LIMIT_BY_DIMENSION,
  parseResourceBudgetProfile,
  compareBudget,
  budgetComparisonResult,
  type ExecutionWindow,
  type ResourceBudgetProfile,
  type BudgetLimit,
  type BudgetResourceEstimate,
  type BudgetComparisonResult,
  type BudgetDimension,
  type BudgetComparison,
  type ResourceBudgetRegistry,
  type BudgetRegistryPort,
} from "./budgets/index.js";

export type { ProjectControlContext } from "./context.js";
export {
  ControlPlaneService,
  type ControlPlaneServiceDeps,
  type ControlPlaneClock,
} from "./service.js";
