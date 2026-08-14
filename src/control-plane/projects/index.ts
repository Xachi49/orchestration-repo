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
} from "./project.js";

export type { ProjectRegistry, ProjectRegistryPort } from "./registry.js";

/** Phase 0 placeholder name. */
export type { Project as ProjectRecord } from "./project.js";
