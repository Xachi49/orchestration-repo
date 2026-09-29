import { describe, expect, it } from "vitest";
import { createMemoryRevenueRecoveryService } from "../api/revenue-recovery-factory.js";
import {
  demoLead,
  demoRecoveryConfig,
  RR_CUSTOMER,
  RR_LEAD_CREATED_AT,
  RR_MONDAY_IN_WINDOW,
  RR_PROJECT,
} from "../infrastructure/postgres/postgres.revenue-recovery.helpers.js";
import type { ContactPolicyResult } from "./contact-policy.js";
import type { Lead, LeadIngestInput } from "./lead.js";
import { mapRecoveryCaseToAdmissionRequest } from "./objective-mapping.js";
import type { RecoveryCase } from "./recovery-case.js";
import {
  parseRecoveryConfiguration,
  RECOVERY_CHANNELS,
  type RecoveryChannel,
  type RecoveryConfigurationInput,
} from "./recovery-config.js";

const CHANNEL_MENTIONS: Record<RecoveryChannel, RegExp> = {
  SMS: /\bSMS\b/i,
  EMAIL: /\bemail\b/i,
  CALL_TASK: /\bCALL_TASK\b|\bcall tasks?\b/i,
};

const CANONICAL_CRITERIA = [
  "Lead responds to recovery outreach",
  "Appointment booked",
  "Lead explicitly declines",
  "Contact policy exhausts allowed attempts",
];

function mentionedChannels(texts: readonly string[]): RecoveryChannel[] {
  return RECOVERY_CHANNELS.filter((channel) =>
    texts.some((text) => CHANNEL_MENTIONS[channel].test(text)),
  );
}

function assertNoExcludedChannel(
  constraints: readonly string[],
  permittedChannels: readonly RecoveryChannel[],
): void {
  const excluded = RECOVERY_CHANNELS.filter(
    (channel) => !permittedChannels.includes(channel),
  );
  for (const channel of excluded) {
    const offending = constraints.filter((text) =>
      CHANNEL_MENTIONS[channel].test(text),
    );
    expect(offending, `constraints mention excluded ${channel}`).toEqual([]);
  }
}

async function preparedObjective(
  configOverrides: Partial<RecoveryConfigurationInput>,
  leadOverrides: Partial<LeadIngestInput> = {},
) {
  const { service } = createMemoryRevenueRecoveryService({
    nowIso: () => RR_MONDAY_IN_WINDOW,
  });
  await service.putConfiguration(
    demoRecoveryConfig({
      timezone: "UTC",
      contactWindow: {
        startHourLocal: 9,
        endHourLocal: 17,
        daysOfWeek: [1, 2, 3, 4, 5],
      },
      cooldownMinutes: 0,
      maxSmsAttempts: 1,
      maxEmailAttempts: 1,
      ...configOverrides,
    }),
  );
  const { lead } = await service.ingestLead(
    demoLead({ createdAt: RR_LEAD_CREATED_AT, ...leadOverrides }),
  );
  const { recoveryCase } = await service.detectAndOpenRecoveryCase({
    leadId: lead.leadId,
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
  });
  if (!recoveryCase) {
    throw new Error("expected an open recovery case");
  }
  const prepared = await service.prepareRecoveryObjective({
    recoveryCaseId: recoveryCase.recoveryCaseId,
    requesterId: "requester_rr",
    requestedEnvironment: "production",
  });
  const permitted = prepared.planningContext[
    "permittedChannels"
  ] as RecoveryChannel[];
  return { ...prepared, permitted };
}

describe("mapRecoveryCaseToAdmissionRequest — channel-aware constraints", () => {
  it("EMAIL-only objective carries no SMS constraint", async () => {
    const { admissionRequest, permitted } = await preparedObjective({
      allowedChannels: ["EMAIL"],
    });
    expect(permitted).toEqual(["EMAIL"]);
    expect(admissionRequest.constraints).toContain("Allowed channels: EMAIL");
    expect(admissionRequest.constraints).toContain("Max email attempts: 1");
    expect(mentionedChannels(admissionRequest.constraints)).toEqual(["EMAIL"]);
    assertNoExcludedChannel(admissionRequest.constraints, permitted);
  });

  it("SMS-only objective carries no email constraint", async () => {
    const { admissionRequest, permitted } = await preparedObjective({
      allowedChannels: ["SMS"],
      maxSmsAttempts: 2,
    });
    expect(permitted).toEqual(["SMS"]);
    expect(admissionRequest.constraints).toContain("Allowed channels: SMS");
    expect(admissionRequest.constraints).toContain("Max SMS attempts: 2");
    expect(mentionedChannels(admissionRequest.constraints)).toEqual(["SMS"]);
    assertNoExcludedChannel(admissionRequest.constraints, permitted);
  });

  it("EMAIL + SMS objective carries exactly its allowed channel constraints", async () => {
    const { admissionRequest, permitted } = await preparedObjective({
      allowedChannels: ["SMS", "EMAIL"],
      maxSmsAttempts: 2,
      maxEmailAttempts: 1,
    });
    expect(permitted).toEqual(["SMS", "EMAIL"]);
    expect(admissionRequest.constraints).toContain("Allowed channels: SMS,EMAIL");
    expect(admissionRequest.constraints).toContain("Max SMS attempts: 2");
    expect(admissionRequest.constraints).toContain("Max email attempts: 1");
    expect(mentionedChannels(admissionRequest.constraints).sort()).toEqual([
      "EMAIL",
      "SMS",
    ]);
  });

  it("a configured channel the contact policy excludes is not an objective constraint", async () => {
    const { admissionRequest, permitted, contactPolicy } =
      await preparedObjective(
        { allowedChannels: ["SMS", "EMAIL"] },
        { consent: { smsOptIn: false, emailOptIn: true, callOptIn: true } },
      );
    expect(
      contactPolicy.channels.find((channel) => channel.channel === "SMS")
        ?.permitted,
    ).toBe(false);
    expect(permitted).toEqual(["EMAIL"]);
    expect(admissionRequest.constraints).toContain("Allowed channels: EMAIL");
    assertNoExcludedChannel(admissionRequest.constraints, permitted);
  });

  it("acceptance criteria stay canonical and channel-neutral", async () => {
    for (const allowedChannels of [
      ["EMAIL"],
      ["SMS"],
      ["SMS", "EMAIL"],
    ] as RecoveryChannel[][]) {
      const { admissionRequest } = await preparedObjective({ allowedChannels });
      expect(admissionRequest.acceptanceCriteria).toEqual(CANONICAL_CRITERIA);
      expect(mentionedChannels(admissionRequest.acceptanceCriteria)).toEqual(
        [],
      );
    }
  });

  it("invariant: constraints never mention a channel excluded from permittedChannels", () => {
    const config = parseRecoveryConfiguration({
      ...demoRecoveryConfig({ maxSmsAttempts: 3, maxEmailAttempts: 2 }),
      configId: "rcfg_invariant",
      configVersion: 1,
      configFingerprint: "fp_invariant",
      createdAt: RR_MONDAY_IN_WINDOW,
    });
    const recoveryCase = {
      recoveryCaseId: "rc_invariant",
      projectId: RR_PROJECT,
    } as RecoveryCase;
    const subsets: RecoveryChannel[][] = [[]];
    for (const channel of RECOVERY_CHANNELS) {
      for (const subset of [...subsets]) {
        subsets.push([...subset, channel]);
      }
    }
    for (const permitted of subsets) {
      const contactPolicy: ContactPolicyResult = {
        eligible: permitted.length > 0,
        channels: RECOVERY_CHANNELS.map((channel) => ({
          channel,
          permitted: permitted.includes(channel),
          reasonCodes: permitted.includes(channel)
            ? ["ELIGIBLE"]
            : ["CONSENT_MISSING"],
        })),
        reasonCodes: permitted.length > 0 ? ["ELIGIBLE"] : ["CONSENT_MISSING"],
        evaluatedAt: RR_MONDAY_IN_WINDOW,
      };
      const request = mapRecoveryCaseToAdmissionRequest({
        recoveryCase,
        lead: {} as Lead,
        config,
        contactPolicy,
        requesterId: "requester_rr",
        requestedEnvironment: "production",
        submittedAt: RR_MONDAY_IN_WINDOW,
      });
      assertNoExcludedChannel(request.constraints, permitted);
      expect(request.acceptanceCriteria).toEqual(CANONICAL_CRITERIA);
    }
  });
});
