import { DurabilityError } from "../../durability/errors.js";

export function hydrateRecord<T>(
  parse: (input: unknown) => T,
  payload: unknown,
  context: string,
): T {
  try {
    return parse(payload);
  } catch (error) {
    throw new DurabilityError(
      "PERSISTED_RECORD_INVALID",
      `Persisted record is invalid: ${context}`,
      {
        context,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}
