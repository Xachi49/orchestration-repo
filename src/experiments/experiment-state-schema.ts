import { z } from "zod";
import {
  EXPERIMENT_STATES,
  type ExperimentState,
} from "./experiment-state.js";

export const ExperimentStateSchema = z.enum(EXPERIMENT_STATES);

export {
  EXPERIMENT_STATES,
  TERMINAL_EXPERIMENT_STATES,
  DISCOVERABLE_EXPERIMENT_STATES,
  EXPERIMENT_TRANSITIONS,
  canTransitionExperiment,
  isTerminalExperimentState,
  type ExperimentState,
  type TerminalExperimentState,
} from "./experiment-state.js";
