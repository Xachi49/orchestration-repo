import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ScenarioOrchestrationService } from "../scenarios/service.js";
import type {
  DecisionProblemRepository,
  DecisionPackageRepository,
  ScenarioCalibrationRepository,
} from "../scenarios/repositories.js";
import { isScenarioError } from "../scenarios/errors.js";
import { DecisionCriterionSchema } from "../scenarios/decision-problem.js";
import { STRATEGY_SELECTION_DECISIONS } from "../scenarios/selection.js";

const DecisionParams = z.object({ id: z.string().min(1) }).strict();

const AdmitBody = z
  .object({
    decisionProblemId: z.string().min(1).optional(),
    decisionProblemVersion: z.number().int().positive().optional(),
    primaryProjectId: z.string().min(1),
    question: z.string().min(1).max(4000),
    strategicObjective: z.string().min(1).max(4000),
    decisionCriteria: z.array(DecisionCriterionSchema).min(1),
    timeHorizon: z.string().min(1).max(200),
    constraints: z.array(z.string()).optional(),
    nonGoals: z.array(z.string()).optional(),
    allowedProjectIds: z.array(z.string().min(1)).min(1),
    allowedEnvironments: z.array(z.string().min(1)).min(1),
    allowedRepositoryIdentities: z.array(z.string()).optional(),
    riskTolerance: z.enum(["LOW", "MEDIUM", "HIGH"]),
    decisionDeadline: z.string().datetime().optional(),
    createdBy: z.string().min(1).optional(),
    requestedEnvironment: z.string().min(1),
    submittedAt: z.string().datetime().optional(),
    maximumScenarioCount: z.number().int().positive().max(50).optional(),
    maximumSimulationRuns: z.number().int().positive().max(200).optional(),
    maximumModelCalls: z.number().int().nonnegative().optional(),
    maximumSensitivityEvaluations: z.number().int().nonnegative().optional(),
  })
  .strict();

const SelectionDecideBody = z
  .object({
    selectionId: z.string().min(1),
    selectorId: z.string().min(1).optional(),
    decision: z.enum(STRATEGY_SELECTION_DECISIONS),
    selectedScenarioId: z.string().min(1).optional(),
    decisionNonce: z.string().min(1),
    submittedAt: z.string().datetime().optional(),
  })
  .strict();

function principalId(request: FastifyRequest): string {
  return (
    (request as { orchestratorPrincipalId?: string }).orchestratorPrincipalId ??
    "anonymous"
  );
}

function httpStatusForScenario(code: string): number {
  switch (code) {
    case "DECISION_PROBLEM_NOT_FOUND":
      return 404;
    case "DECISION_PROBLEM_VERSION_CONFLICT":
    case "DECISION_PROBLEM_STATE_CONFLICT":
    case "DECISION_PROBLEM_CAS_CONFLICT":
    case "SIMULATION_IDENTITY_CONFLICT":
      return 409;
    case "STRATEGY_SELECTION_REQUIRED":
    case "STRATEGY_SELECTION_INVALID":
    case "STRATEGY_SELECTION_EXPIRED":
    case "STRATEGY_SELECTOR_SCOPE_INSUFFICIENT":
      return 403;
    case "PORTFOLIO_ADMISSION_UNAVAILABLE":
      return 503;
    default:
      return 400;
  }
}

export function registerDecisionRoutes(
  app: FastifyInstance,
  deps: {
    scenarioService: ScenarioOrchestrationService;
    decisionProblems: DecisionProblemRepository;
    decisionPackages: DecisionPackageRepository;
    calibrationRecords: ScenarioCalibrationRepository;
  },
): void {
  app.post("/v1/decisions", async (request, reply) => {
    try {
      const body = AdmitBody.parse(request.body);
      const result = await deps.scenarioService.admit({
        primaryProjectId: body.primaryProjectId,
        question: body.question,
        strategicObjective: body.strategicObjective,
        decisionCriteria: body.decisionCriteria,
        timeHorizon: body.timeHorizon,
        allowedProjectIds: body.allowedProjectIds,
        allowedEnvironments: body.allowedEnvironments,
        riskTolerance: body.riskTolerance,
        createdBy: body.createdBy ?? principalId(request),
        requestedEnvironment: body.requestedEnvironment,
        submittedAt: body.submittedAt ?? new Date().toISOString(),
        ...(body.decisionProblemId ? { decisionProblemId: body.decisionProblemId } : {}),
        ...(body.decisionProblemVersion !== undefined
          ? { decisionProblemVersion: body.decisionProblemVersion }
          : {}),
        ...(body.constraints !== undefined ? { constraints: body.constraints } : {}),
        ...(body.nonGoals !== undefined ? { nonGoals: body.nonGoals } : {}),
        ...(body.allowedRepositoryIdentities !== undefined
          ? { allowedRepositoryIdentities: body.allowedRepositoryIdentities }
          : {}),
        ...(body.decisionDeadline !== undefined
          ? { decisionDeadline: body.decisionDeadline }
          : {}),
        ...(body.maximumScenarioCount !== undefined
          ? { maximumScenarioCount: body.maximumScenarioCount }
          : {}),
        ...(body.maximumSimulationRuns !== undefined
          ? { maximumSimulationRuns: body.maximumSimulationRuns }
          : {}),
        ...(body.maximumModelCalls !== undefined
          ? { maximumModelCalls: body.maximumModelCalls }
          : {}),
        ...(body.maximumSensitivityEvaluations !== undefined
          ? {
              maximumSensitivityEvaluations: body.maximumSensitivityEvaluations,
            }
          : {}),
      });
      return reply.code(result.outcome === "ADMITTED" ? 201 : 200).send(result);
    } catch (error) {
      if (isScenarioError(error)) {
        return reply
          .code(httpStatusForScenario(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/decisions/:id", async (request, reply) => {
    const { id } = DecisionParams.parse(request.params);
    const problem = await deps.decisionProblems.getById(id);
    if (!problem) {
      return reply
        .code(404)
        .send({ error: "DECISION_PROBLEM_NOT_FOUND", message: "Not found" });
    }
    return problem;
  });

  app.post("/v1/decisions/:id/scenarios", async (request, reply) => {
    try {
      const { id } = DecisionParams.parse(request.params);
      await deps.scenarioService.ground(id);
      const result = await deps.scenarioService.generateScenarios(id);
      return result;
    } catch (error) {
      if (isScenarioError(error)) {
        return reply
          .code(httpStatusForScenario(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/decisions/:id/simulate", async (request, reply) => {
    try {
      const { id } = DecisionParams.parse(request.params);
      return await deps.scenarioService.simulateAll(id);
    } catch (error) {
      if (isScenarioError(error)) {
        return reply
          .code(httpStatusForScenario(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/decisions/:id/analyze", async (request, reply) => {
    try {
      const { id } = DecisionParams.parse(request.params);
      await deps.scenarioService.simulateAll(id);
      const analyzed = await deps.scenarioService.analyze(id);
      await deps.scenarioService.validatePackage(id);
      return analyzed;
    } catch (error) {
      if (isScenarioError(error)) {
        return reply
          .code(httpStatusForScenario(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/decisions/:id/package", async (request, reply) => {
    const { id } = DecisionParams.parse(request.params);
    const pkg = await deps.decisionPackages.getLatest(id);
    if (!pkg) {
      return reply
        .code(404)
        .send({ error: "DECISION_PACKAGE_INVALID", message: "No package" });
    }
    return pkg;
  });

  app.post("/v1/decisions/:id/selection", async (request, reply) => {
    try {
      const { id } = DecisionParams.parse(request.params);
      const body = request.body;
      if (
        body &&
        typeof body === "object" &&
        "decision" in body &&
        "selectionId" in body &&
        "decisionNonce" in body
      ) {
        const parsed = SelectionDecideBody.parse(body);
        return await deps.scenarioService.decideSelection({
          selectionId: parsed.selectionId,
          selectorId: parsed.selectorId ?? principalId(request),
          decision: parsed.decision,
          decisionNonce: parsed.decisionNonce,
          submittedAt: parsed.submittedAt ?? new Date().toISOString(),
          ...(parsed.selectedScenarioId !== undefined
            ? { selectedScenarioId: parsed.selectedScenarioId }
            : {}),
        });
      }
      const routed = await deps.scenarioService.routeSelection(id);
      return {
        selectionId: routed.request.selectionId,
        status: routed.request.status,
        expiresAt: routed.request.expiresAt,
        decisionNonce: routed.decisionNonce,
      };
    } catch (error) {
      if (isScenarioError(error)) {
        return reply
          .code(httpStatusForScenario(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/decisions/:id/calibration", async (request, reply) => {
    const { id } = DecisionParams.parse(request.params);
    const records = await deps.calibrationRecords.listByDecisionProblem(id);
    return { decisionProblemId: id, records };
  });
}
