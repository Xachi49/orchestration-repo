let sequence = 0;

export class SequenceObservabilityIdentityGenerator {
  next(prefix: string): string {
    sequence += 1;
    return `${prefix}-${sequence}`;
  }
}
