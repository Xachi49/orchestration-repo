export type ProvisionRecordOutcome =
  | "CREATE"
  | "UNCHANGED"
  | "CONFLICT"
  | "MISSING";

export type ProvisionConflict = {
  recordType: string;
  identity: string;
  reasonCode: string;
  message: string;
};

export type ProvisionPlanItem = {
  recordType: string;
  identity: string;
  outcome: Exclude<ProvisionRecordOutcome, "MISSING" | "CONFLICT">;
};

export type ControlPlaneInspectResult = {
  projectId: string;
  project: unknown | null;
  projectMissing: boolean;
  activePolicyBundle: unknown | null;
  activePolicyBundleMissing: boolean;
  resourceBudgetProfile: unknown | null;
  resourceBudgetProfileMissing: boolean;
  capabilities: unknown[];
  requesterGrants: unknown[];
  approverGrants: unknown[];
  repositorySource: unknown | null;
  repositorySourceMissing: boolean;
};

export type ControlPlaneProvisionResult = {
  mode: "dry-run" | "apply";
  projectId: string;
  doctrine: {
    provisioningNotExecutionAuthority: "CONTROL-PLANE PROVISIONING != OUTREACH AUTHORIZATION";
    cliNotPhase6: "BUTTON/CLI INVOCATION != PHASE 6 AUTHORIZATION";
    passNotApproved: "PASS != APPROVED";
  };
  conflicts: ProvisionConflict[];
  plan: ProvisionPlanItem[];
  applied: boolean;
  /** Present on successful --apply only. */
  provisioningOperationId?: string;
  operatorId?: string;
  manifestFingerprint?: string;
  verified?: ControlPlaneInspectResult;
};

/** Durable ops provenance — not a Phase 6/7 authority grant. */
export type ControlPlaneProvisioningAuditRecord = {
  provisioningOperationId: string;
  operatorId: string;
  projectId: string;
  manifestFingerprint: string;
  occurredAt: string;
  mode: "apply";
  planSummary: readonly ProvisionPlanItem[];
  outcome: "SUCCEEDED";
};
