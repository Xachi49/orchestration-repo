import { describe, expect, it } from "vitest";
import { ViolationFingerprintService } from "./fingerprint.js";
import { ValidationFindingFactory } from "./finding-factory.js";

const fingerprints = new ViolationFingerprintService();

describe("ViolationFingerprintService", () => {
  it("is deterministic for identical violations", () => {
    const input = {
      validatorType: "POLICY" as const,
      ruleId: "POLICY_DENY",
      category: "policy",
      affectedStepIds: ["step_patch"],
    };
    expect(fingerprints.fingerprint(input)).toBe(
      fingerprints.fingerprint(input),
    );
  });

  it("ignores step ordering and duplicates", () => {
    const left = fingerprints.fingerprint({
      validatorType: "DEPENDENCY",
      ruleId: "DEPENDENCY_CYCLE",
      category: "dependency",
      affectedStepIds: ["step_b", "step_a", "step_a"],
    });
    const right = fingerprints.fingerprint({
      validatorType: "DEPENDENCY",
      ruleId: "DEPENDENCY_CYCLE",
      category: "dependency",
      affectedStepIds: ["step_a", "step_b"],
    });
    expect(left).toBe(right);
  });

  it("separates different rules and different steps", () => {
    const base = {
      validatorType: "SECURITY" as const,
      category: "security",
      affectedStepIds: ["step_patch"],
    };
    expect(
      fingerprints.fingerprint({ ...base, ruleId: "SECURITY_A" }),
    ).not.toBe(fingerprints.fingerprint({ ...base, ruleId: "SECURITY_B" }));
    expect(
      fingerprints.fingerprint({
        ...base,
        ruleId: "SECURITY_A",
        affectedStepIds: ["step_test"],
      }),
    ).not.toBe(fingerprints.fingerprint({ ...base, ruleId: "SECURITY_A" }));
  });

  it("normalizes volatile tokens out of free text", () => {
    expect(
      fingerprints.normalizeText(
        "Step 12 failed at 2026-08-14T10:00:00.000Z (run 3f2b8c1d9e4a5b6c)",
      ),
    ).toBe("step <n> failed at <timestamp> run <hash>");
    expect(
      fingerprints.normalizeText(
        "plan f47ac10b-58cc-4372-a567-0e02b2c3d479 rejected",
      ),
    ).toBe("plan <uuid> rejected");
  });

  it("uses no embeddings or similarity: reworded text with same subject collides only via subject", () => {
    const left = fingerprints.fingerprint({
      validatorType: "CAPABILITY",
      ruleId: "CAPABILITY_UNKNOWN_ACTION",
      category: "capability",
      affectedStepIds: ["step_x"],
      subject: { actionType: "DEPLOY_SERVICE" },
    });
    const right = fingerprints.fingerprint({
      validatorType: "CAPABILITY",
      ruleId: "CAPABILITY_UNKNOWN_ACTION",
      category: "capability",
      affectedStepIds: ["step_x"],
      subject: { actionType: "DELETE_BRANCH" },
    });
    expect(left).not.toBe(right);
  });

  it("detects repeats across attempts", () => {
    const first = fingerprints.fingerprint({
      validatorType: "POLICY",
      ruleId: "POLICY_DENY",
      category: "policy",
      affectedStepIds: ["step_patch"],
    });
    const other = fingerprints.fingerprint({
      validatorType: "POLICY",
      ruleId: "POLICY_NO_MATCHING_RULE",
      category: "policy",
      affectedStepIds: ["step_patch"],
    });
    expect(fingerprints.hasRepeat([first], [other])).toBe(false);
    expect(fingerprints.hasRepeat([first], [other, first])).toBe(true);
    expect(fingerprints.repeated([first, other], [first])).toEqual([first]);
  });
});

describe("ValidationFindingFactory", () => {
  const factory = new ValidationFindingFactory(fingerprints);

  const draft = {
    validatorType: "SECURITY" as const,
    ruleId: "SECURITY_MISSING_ROLLBACK",
    category: "security",
    severity: "ERROR" as const,
    message: "Critical step step_patch has no rollback strategy",
    affectedStepIds: ["step_patch"],
    blocking: true,
    repairable: true,
    approvalEligible: false,
  };

  it("produces stable ids and fingerprints for identical drafts", () => {
    const left = factory.create(draft);
    const right = factory.create(draft);
    expect(left.findingId).toBe(right.findingId);
    expect(left.semanticFingerprint).toBe(right.semanticFingerprint);
    expect(left.findingId.startsWith("vf_")).toBe(true);
  });

  it("keeps the fingerprint stable when only the message wording changes", () => {
    const reworded = factory.create({
      ...draft,
      message: "Step step_patch is critical yet declares rollback NONE",
    });
    expect(reworded.semanticFingerprint).toBe(
      factory.create(draft).semanticFingerprint,
    );
    expect(reworded.findingId).not.toBe(factory.create(draft).findingId);
  });

  it("classifies blocking and repairable findings", () => {
    const repairable = factory.create(draft);
    const hard = factory.create({
      ...draft,
      ruleId: "SECURITY_FORBIDDEN_ACTION",
      severity: "CRITICAL",
      repairable: false,
    });
    expect(repairable.blocking).toBe(true);
    expect(hard.repairable).toBe(false);
  });
});
