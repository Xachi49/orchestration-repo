export interface AdmissionIdentity {
  runId: string;
  eventId: string;
  correlationId: string;
  traceId: string;
}

export interface AdmissionIdentityGenerator {
  next(): AdmissionIdentity;
}
