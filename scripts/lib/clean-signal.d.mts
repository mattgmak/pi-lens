// Type declarations for clean-signal.mjs (untyped .mjs imported from .ts tests).

export interface CleanSignalObservations {
  dirtyPublishes?: number;
  dirtyVersioned?: number;
  cleanTransitionPublishes?: number;
  cleanTransitionVersioned?: number;
}

export function classifyCleanBehavior(obs: CleanSignalObservations): {
  behavior:
    | "publishes-versioned"
    | "publishes-unversioned"
    | "silent"
    | "unknown";
  tier: 2 | 3 | 0;
  tierLabel: "2" | "2*" | "3" | "";
  reason: string;
};
