import { createHash } from "node:crypto";
import type { PortfolioAuthorizationEnvelope } from "../portfolio/authorization-envelope.js";
import type { PortfolioGoal } from "../portfolio/goals.js";
import type { PortfolioIntent } from "../portfolio/intent.js";
import type { PortfolioOrchestrationService } from "../portfolio/service.js";
import { defaultPortfolioEnvelope } from "../portfolio/authorization-envelope.js";
import type { DecisionProblem } from "./decision-problem.js";
import type { ScenarioDefinition } from "./scenario.js";
import { compileProposedPortfolioIntent } from "./portfolio-intent-compiler.js";

/**
 * Narrow Phase 15 handoff for strategy materialization.
 * Must never authorize capital, Programs, or child execution.
 */
export type PortfolioProposalAdmissionOutcome =
  | {
      outcome: "ADMITTED";
      portfolioId: string;
      /** Must remain ADMITTED — never AUTHORIZED from this path. */
      portfolioStatus: "ADMITTED";
    }
  | {
      outcome: "DUPLICATE";
      portfolioId: string;
      portfolioStatus: "ADMITTED";
    }
  | { outcome: "REJECTED"; reason: string }
  | { outcome: "UNAVAILABLE"; reason: string };

export interface PortfolioProposalAdmissionRequest {
  decisionProblem: DecisionProblem;
  selectedScenario: ScenarioDefinition;
  intent: PortfolioIntent;
  submittedAt: string;
}

export interface PortfolioProposalAdmissionPort {
  admitProposal(
    request: PortfolioProposalAdmissionRequest,
  ): Promise<PortfolioProposalAdmissionOutcome>;
}

function goalsFromIntent(intent: PortfolioIntent): PortfolioGoal[] {
  const n = Math.max(1, intent.strategicGoals.length);
  return intent.strategicGoals.map((name, index) => ({
    goalId: `goal_${index + 1}`,
    description: name,
    successCriteria: [intent.successCriteria[index] ?? name],
    weight: 1 / n,
    classification: "REQUIRED" as const,
    dependencies: [] as string[],
    evidenceRequirements: ["PROGRAM_COMPLETION_AUTHORITY"],
    status: "OPEN" as const,
  }));
}

function envelopeForProblem(
  problem: DecisionProblem,
  intent: PortfolioIntent,
): PortfolioAuthorizationEnvelope {
  const env =
    intent.requestedEnvironmentScopes[0] ?? problem.allowedEnvironments[0]!;
  return {
    ...defaultPortfolioEnvelope({
      projectId: problem.primaryProjectId,
      environment: env,
      repositoryIdentities: problem.allowedRepositoryIdentities,
    }),
    allowedProjectIds: [...problem.allowedProjectIds],
    allowedEnvironments: [...problem.allowedEnvironments],
    allowedRepositoryIdentities: [...problem.allowedRepositoryIdentities],
    crossProjectDelegationAllowed: problem.allowedProjectIds.length > 1,
    maximumCrossProjectPrograms: Math.max(
      0,
      problem.allowedProjectIds.length - 1,
    ),
  };
}

/**
 * Production adapter: delegates to Phase 15 portfolioService.admit.
 * Never authorizes allocation or reserves capital.
 */
export class Phase15PortfolioProposalAdmissionPort
  implements PortfolioProposalAdmissionPort
{
  constructor(private readonly portfolioService: PortfolioOrchestrationService) {}

  async admitProposal(
    request: PortfolioProposalAdmissionRequest,
  ): Promise<PortfolioProposalAdmissionOutcome> {
    const { decisionProblem: problem, intent, submittedAt } = request;
    const env =
      intent.requestedEnvironmentScopes[0] ?? problem.allowedEnvironments[0]!;
    try {
      const admitted = await this.portfolioService.admit({
        primaryProjectId: problem.primaryProjectId,
        requesterId: problem.createdBy,
        requestedEnvironment: env,
        intent,
        goals: goalsFromIntent(intent),
        authorizationEnvelope: envelopeForProblem(problem, intent),
        submittedAt,
        correlationId: problem.correlationId,
        traceId: problem.traceId,
      });
      if (admitted.outcome === "ADMITTED" || admitted.outcome === "DUPLICATE") {
        if (
          admitted.portfolio.status === "AUTHORIZED" ||
          admitted.portfolio.status === "ACTIVE"
        ) {
          return {
            outcome: "REJECTED",
            reason:
              "Strategy selection must not produce AUTHORIZED/ACTIVE Portfolio",
          };
        }
        return {
          outcome: admitted.outcome === "ADMITTED" ? "ADMITTED" : "DUPLICATE",
          portfolioId: admitted.portfolio.portfolioId,
          portfolioStatus: "ADMITTED",
        };
      }
      return {
        outcome: "REJECTED",
        reason: "Portfolio admission version conflict",
      };
    } catch (err) {
      return {
        outcome: "REJECTED",
        reason: err instanceof Error ? err.message : "Portfolio admission failed",
      };
    }
  }
}

/**
 * Deterministic fake for unit tests. Models ADMITTED / DUPLICATE / REJECTED /
 * UNAVAILABLE without inventing capital authorization.
 */
export class FakePortfolioProposalAdmissionPort
  implements PortfolioProposalAdmissionPort
{
  admitCallCount = 0;
  mode: "ADMITTED" | "DUPLICATE" | "REJECTED" | "UNAVAILABLE" = "ADMITTED";
  /** Crash after recording an admit (simulates post-admit, pre-lineage failure). */
  crashAfterAdmit = false;
  private readonly byIntentHash = new Map<string, string>();

  deterministicPortfolioId(intent: PortfolioIntent, problem: DecisionProblem): string {
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          intent,
          primaryProjectId: problem.primaryProjectId,
          createdBy: problem.createdBy,
        }),
        "utf8",
      )
      .digest("hex")
      .slice(0, 24);
    return `pf_fake_${digest}`;
  }

  async admitProposal(
    request: PortfolioProposalAdmissionRequest,
  ): Promise<PortfolioProposalAdmissionOutcome> {
    if (this.mode === "UNAVAILABLE") {
      return {
        outcome: "UNAVAILABLE",
        reason: "Fake portfolio admission port unavailable",
      };
    }
    if (this.mode === "REJECTED") {
      return { outcome: "REJECTED", reason: "Fake portfolio admission rejected" };
    }

    const intent =
      request.intent ??
      compileProposedPortfolioIntent(
        request.selectedScenario,
        request.decisionProblem,
      );
    const portfolioId = this.deterministicPortfolioId(
      intent,
      request.decisionProblem,
    );
    const intentKey = createHash("sha256")
      .update(JSON.stringify(intent), "utf8")
      .digest("hex");

    const existing = this.byIntentHash.get(intentKey);
    this.admitCallCount += 1;

    if (existing) {
      if (this.crashAfterAdmit) {
        throw new Error("simulated crash after portfolio admission (duplicate path)");
      }
      return {
        outcome: "DUPLICATE",
        portfolioId: existing,
        portfolioStatus: "ADMITTED",
      };
    }

    if (this.mode === "DUPLICATE") {
      this.byIntentHash.set(intentKey, portfolioId);
      if (this.crashAfterAdmit) {
        throw new Error("simulated crash after portfolio admission");
      }
      return {
        outcome: "DUPLICATE",
        portfolioId,
        portfolioStatus: "ADMITTED",
      };
    }

    this.byIntentHash.set(intentKey, portfolioId);
    if (this.crashAfterAdmit) {
      throw new Error("simulated crash after portfolio admission");
    }
    return {
      outcome: "ADMITTED",
      portfolioId,
      portfolioStatus: "ADMITTED",
    };
  }
}
