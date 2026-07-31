/**
 * The walk lifecycle, as a pure reducer.
 *
 * Native owns the AVFoundation and DAT sessions; this owns what happened and what was captured.
 * Keeping it pure means the rules that actually matter — a still cannot be recorded after the
 * walk ended, a failure never discards captured evidence — are unit-testable without a device.
 */

export type WalkState =
  | "idle"
  | "starting"
  | "recording"
  | "finalizing"
  | "complete"
  | "failed";

/** Where a still came from. Glasses stills are 1.56 MP; phone stills are far sharper. */
export type StillSource = "glasses" | "phone";

export type WalkStill = {
  uri: string;
  at: number;
  source: StillSource;
};

export type Walk = {
  state: WalkState;
  /** A walk always belongs to a deal. The project is optional — not every deal has one yet. */
  dealId: string;
  projectId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  videoUri: string | null;
  audioUri: string | null;
  stills: WalkStill[];
  error: string | null;
};

export type WalkEvent =
  | { type: "starting" }
  | { type: "started"; at: number; videoUri: string | null }
  | { type: "still"; uri: string; at: number; source: StillSource }
  | { type: "ended"; at: number }
  | { type: "finalized"; audioUri: string | null }
  | { type: "failed"; reason: string };

export function initialWalk(dealId: string, projectId: string | null): Walk {
  return {
    state: "idle",
    dealId,
    projectId,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    videoUri: null,
    audioUri: null,
    stills: [],
    error: null,
  };
}

/** Stills are only meaningful while the walk is actually running. */
export function canCapture(walk: Walk): boolean {
  return walk.state === "recording";
}

export function artifactCount(walk: Walk): number {
  return walk.stills.length;
}

/** Terminal states absorb every further event, so a late native callback cannot revive a walk. */
const TERMINAL: ReadonlySet<WalkState> = new Set<WalkState>(["complete", "failed"]);

export function reduceWalk(walk: Walk, event: WalkEvent): Walk {
  if (TERMINAL.has(walk.state)) return walk;

  switch (event.type) {
    case "starting":
      return walk.state === "idle" ? { ...walk, state: "starting" } : walk;

    case "started":
      // Only accepted from "starting": a "started" that arrives without the app having
      // initiated one is a spurious or duplicated native event. Accepting it would put an
      // untouched walk into "recording" with no directory, no recorder, and no audio route.
      return walk.state === "starting"
        ? { ...walk, state: "recording", startedAt: event.at, videoUri: event.videoUri }
        : walk;

    case "still":
      // Guarded rather than trusted: the native photo publisher is asynchronous, so a still
      // requested just before "end walk" can land after it. Attaching it to a walk already
      // handed to the uploader would be evidence in a place nothing will look.
      return canCapture(walk)
        ? {
            ...walk,
            stills: [...walk.stills, { uri: event.uri, at: event.at, source: event.source }],
          }
        : walk;

    case "ended":
      return walk.state === "recording"
        ? { ...walk, state: "finalizing", endedAt: event.at }
        : walk;

    case "finalized":
      return walk.state === "finalizing"
        ? {
            ...walk,
            state: "complete",
            audioUri: event.audioUri,
            durationMs:
              walk.startedAt !== null && walk.endedAt !== null
                ? walk.endedAt - walk.startedAt
                : null,
          }
        : walk;

    case "failed":
      // Everything captured so far is kept. A walk is a site visit that physically happened;
      // its stills cannot be re-taken from a desk, so a failure must never be a delete.
      return { ...walk, state: "failed", error: event.reason };
  }
}
