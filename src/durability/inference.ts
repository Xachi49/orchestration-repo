import type { InferenceDurabilityState } from "../domain/durability/index.js";

export interface InferenceDurabilityPort {
  markDispatched(callId: string): Promise<void>;
  getDurabilityState(callId: string): Promise<InferenceDurabilityState | null>;
  markAmbiguous(callId: string): Promise<void>;
}
