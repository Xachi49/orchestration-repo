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

/** Test/helper clock whose instant can be advanced for expiry scenarios. */
export class MutableClock implements ClockPort {
  constructor(private iso: string) {}

  nowIso(): string {
    return this.iso;
  }

  set(iso: string): void {
    this.iso = iso;
  }

  advanceMs(ms: number): void {
    this.iso = new Date(Date.parse(this.iso) + ms).toISOString();
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
