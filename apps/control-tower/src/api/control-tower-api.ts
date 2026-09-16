import { apiFetch } from "./client.js";

export type RunRecord = {
  runId: string;
  projectId: string;
  objectiveId: string;
  objectiveVersion: number;
  requesterId: string;
  requestedEnvironment: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  traceId: string;
  failureReasonCode?: string;
};

export type TimelineStage = {
  stageId: string;
  label: string;
  status: string;
};

export type Dashboard = {
  counts: {
    active: number;
    awaitingApproval: number;
    executing: number;
    verifying: number;
    completed: number;
    blockedOrFailed: number;
  };
  recentRuns: RunRecord[];
  recentApprovals: Array<{
    approvalRequestId: string;
    runId: string;
    projectId: string;
    objectiveId: string;
    status: string;
    expiresAt: string;
    validationDecision: string;
  }>;
  recentCompletions: Array<{
    runId: string;
    projectId: string;
    completedAt: string;
  }>;
  doctrine: { controlTowerNotAuthority: string; liveNotReady: string };
};

export type RunDetail = {
  run: RunRecord;
  timeline: TimelineStage[];
  objective: unknown;
  repositoryContext: unknown;
  plan: unknown;
  validation: unknown;
  approvalRequest: unknown;
  authorization: unknown;
  execution: unknown;
  verification: unknown;
  completion: unknown;
  doctrine: {
    passNotApproved: string;
    executionSucceededNotVerified: string;
    verifiedSuccessNotCompleted: string;
  };
};

export type PublicApproval = {
  approvalRequestId: string;
  runId: string;
  projectId: string;
  objectiveId: string;
  objectiveVersion: number;
  planId: string;
  planVersion: number;
  planHash: string;
  status: string;
  expiresAt: string;
  validationDecision: string;
  requestedApproverIds: string[];
  createdAt: string;
};

export const controlTowerApi = {
  dashboard: () => apiFetch<Dashboard>("/v1/control-tower/dashboard"),
  listRuns: (projectId?: string) =>
    apiFetch<{ runs: RunRecord[] }>(
      projectId
        ? `/v1/runs?projectId=${encodeURIComponent(projectId)}`
        : "/v1/runs",
    ),
  getRun: (runId: string) => apiFetch<RunDetail>(`/v1/runs/${runId}`),
  getTimeline: (runId: string) =>
    apiFetch<{
      runId: string;
      state: string;
      timeline: TimelineStage[];
      hasCompletion: boolean;
      doctrine: RunDetail["doctrine"];
    }>(`/v1/runs/${runId}/timeline`),
  getEvidence: (runId: string) =>
    apiFetch<Record<string, unknown>>(`/v1/runs/${runId}/evidence`),
  listApprovals: () =>
    apiFetch<{ approvals: PublicApproval[] }>("/v1/approvals"),
  getApproval: (id: string) =>
    apiFetch<{
      request: PublicApproval;
      decisionCard: unknown;
      run: RunRecord | null;
      doctrine: Record<string, string>;
    }>(`/v1/approvals/${id}`),
  localDelivery: (id: string) =>
    apiFetch<{ channel: string; decisionNonce: string }>(
      `/v1/approvals/${id}/local-delivery`,
    ),
  identityMode: () =>
    apiFetch<{
      authenticationMode: string;
      runtimeEnvironment: string;
      developmentIdentityAdapter: boolean;
      localDeliveryEnabled: boolean;
      controlTowerDevAllowAll: boolean;
      doctrine: Record<string, string>;
    }>("/v1/control-tower/identity-mode"),
  projects: () =>
    apiFetch<{
      principalId: string;
      projects: string[];
      unrestricted: boolean;
    }>("/v1/control-tower/projects"),
  decide: (
    approvalRequestId: string,
    body: {
      approverId: string;
      decision: "APPROVE" | "REJECT" | "REQUEST_MODIFICATION";
      submittedAt: string;
      decisionNonce: string;
      note?: string;
    },
  ) =>
    apiFetch(`/v1/approval-requests/${approvalRequestId}/decision`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  submitObjective: (body: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>("/v1/runs", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  healthLive: () => apiFetch<{ alive: boolean }>("/health/live"),
  healthReady: () =>
    apiFetch<{ ready: boolean; draining: boolean }>("/health/ready"),
  assurance: () => apiFetch<Record<string, unknown>>("/v1/system/assurance"),
  qualification: () =>
    apiFetch<Record<string, unknown>>("/v1/system/qualification"),
  revenueRecoveryDashboard: (customerAccountId: string, projectId: string) =>
    apiFetch<{
      doctrine: Record<string, string>;
      funnel: {
        openRecoveryCases: number;
        casesAwaitingApproval: number;
        engagedLeads: number;
        appointmentsRecovered: number;
        confirmedRecoveredRevenue: number;
        bookedRecoveredRevenue: number;
        operatorAttestedRevenue: number;
        estimatedPipelineRecovered: number;
      };
      pilot?: {
        mode: string;
        webIngestConfigured: boolean;
        resendConfigured: boolean;
        livePilotTenantBound: boolean;
      };
      cases: Array<{
        recoveryCaseId: string;
        leadId: string;
        status: string;
        estimatedRecoverableValue: number | null;
        currency: string | null;
        gapDetectedAt: string;
        orchestratorRunId: string | null;
      }>;
    }>(
      `/v1/revenue-recovery/dashboard?customerAccountId=${encodeURIComponent(customerAccountId)}&projectId=${encodeURIComponent(projectId)}`,
    ),
  revenueRecoveryCase: (
    recoveryCaseId: string,
    customerAccountId: string,
    projectId: string,
  ) =>
    apiFetch<{
      doctrine: Record<string, string>;
      recoveryCase: {
        recoveryCaseId: string;
        status: string;
        orchestratorRunId?: string;
      };
      lead: {
        leadId: string;
        serviceRequested?: string;
        phoneMasked?: string;
        emailMasked?: string;
      };
      contactPolicy: { eligible: boolean };
      provider?: {
        mode: string;
        health: {
          mode: string;
          webIngestConfigured: boolean;
          resendConfigured: boolean;
          livePilotTenantBound: boolean;
        };
      };
      attempts: Array<{
        attemptId: string;
        channel: string;
        sentAt: string;
        deliveryOutcome: string;
        providerName?: string | null;
        providerMessageId?: string | null;
        deliveryState?: string | null;
        lastProviderEventKind?: string | null;
        lastProviderEventAt?: string | null;
      }>;
      economics: {
        estimatedRecoverableValue: number | null;
        bookedRecoveredRevenue: number | null;
        confirmedCollectedRevenue: number | null;
        operatorAttestedRevenue: number | null;
        currency: string;
      };
    }>(
      `/v1/revenue-recovery/cases/${encodeURIComponent(recoveryCaseId)}?customerAccountId=${encodeURIComponent(customerAccountId)}&projectId=${encodeURIComponent(projectId)}`,
    ),
};
