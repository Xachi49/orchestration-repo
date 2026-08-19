import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DurabilityError } from "../../durability/errors.js";
import type { DeliverySecretProtector } from "../../authorization/delivery-secret-store.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export function loadDeliverySecretKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const encoded = env["APPROVAL_DELIVERY_SECRET_KEY"];
  if (!encoded || encoded.trim().length === 0) {
    throw new DurabilityError(
      "DATABASE_UNAVAILABLE",
      "APPROVAL_DELIVERY_SECRET_KEY is required for postgres approval delivery",
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new DurabilityError(
      "DATABASE_UNAVAILABLE",
      "APPROVAL_DELIVERY_SECRET_KEY must decode to 32 bytes (base64)",
    );
  }
  return key;
}

export class Aes256GcmDeliverySecretProtector implements DeliverySecretProtector {
  constructor(private readonly key: Buffer) {}

  encrypt(plaintext: string): {
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
  } {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return { ciphertext, iv, tag };
  }

  decrypt(input: {
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
  }): string {
    const decipher = createDecipheriv(ALGORITHM, this.key, input.iv);
    decipher.setAuthTag(input.tag);
    return Buffer.concat([
      decipher.update(input.ciphertext),
      decipher.final(),
    ]).toString("utf8");
  }
}
