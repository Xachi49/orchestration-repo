export interface ClockPort {
  nowIso(): string;
}

export class SystemClock implements ClockPort {
  nowIso(): string {
    return new Date().toISOString();
  }
}

export class FixedClock implements ClockPort {
  constructor(private readonly iso: string) {}

  nowIso(): string {
    return this.iso;
  }
}

export interface IdGeneratorPort {
  generate(prefix: string): string;
}

export class CryptoIdGenerator implements IdGeneratorPort {
  generate(prefix: string): string {
    return `${prefix}_${crypto.randomUUID()}`;
  }
}
