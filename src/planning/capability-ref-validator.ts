import type { CapabilityRegistry } from "../control-plane/capabilities/registry.js";
import { PlanningError } from "./errors.js";

/**
 * Verifies proposed action types against known available capability vocabulary.
 * Not Phase 5 policy adjudication.
 */
export class CapabilityReferenceValidator {
  constructor(private readonly capabilities: CapabilityRegistry) {}

  async validate(input: {
    actionTypes: readonly string[];
    environment: string;
  }): Promise<void> {
    const all = await this.capabilities.list();
    for (const action of input.actionTypes) {
      const candidates = all.filter((cap) =>
        cap.allowedActions.includes(action),
      );
      if (candidates.length === 0) {
        const forbiddenHit = all.find((cap) =>
          cap.forbiddenActions.includes(action),
        );
        if (forbiddenHit) {
          throw new PlanningError(
            "INVALID_CAPABILITY_REFERENCE",
            `Action ${action} is explicitly forbidden`,
            { action, capabilityId: forbiddenHit.capabilityId },
          );
        }
        throw new PlanningError(
          "INVALID_CAPABILITY_REFERENCE",
          `Unknown action type: ${action}`,
          { action },
        );
      }

      let allowed = false;
      let lastReason = "ACTION_NOT_PERMITTED";
      for (const cap of candidates) {
        const decision = await this.capabilities.isActionAllowed(
          cap.capabilityId,
          action,
          input.environment,
        );
        if (decision.allowed) {
          allowed = true;
          break;
        }
        lastReason = decision.reason;
        if (
          decision.reason === "CAPABILITY_DISABLED" ||
          decision.reason === "ENVIRONMENT_NOT_ALLOWED" ||
          decision.reason === "ACTION_FORBIDDEN"
        ) {
          // keep checking other candidates
        }
      }
      if (!allowed) {
        throw new PlanningError(
          "INVALID_CAPABILITY_REFERENCE",
          `Action ${action} is not permitted (${lastReason})`,
          { action, reason: lastReason },
        );
      }
    }
  }
}
