import { randomUUID } from "node:crypto";
import type {
  AdmissionIdentity,
  AdmissionIdentityGenerator,
} from "../../admission/identity.js";

export class UuidAdmissionIdentityGenerator
  implements AdmissionIdentityGenerator
{
  next(): AdmissionIdentity {
    return {
      runId: `run_${randomUUID()}`,
      eventId: `evt_${randomUUID()}`,
      correlationId: `corr_${randomUUID()}`,
      traceId: `trace_${randomUUID()}`,
    };
  }
}

export class SequenceAdmissionIdentityGenerator
  implements AdmissionIdentityGenerator
{
  private sequence = 0;

  next(): AdmissionIdentity {
    this.sequence += 1;
    const n = String(this.sequence);
    return {
      runId: `run_${n}`,
      eventId: `evt_${n}`,
      correlationId: `corr_${n}`,
      traceId: `trace_${n}`,
    };
  }
}
