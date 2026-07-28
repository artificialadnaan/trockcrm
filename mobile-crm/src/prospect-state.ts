import { hasActivityTarget } from "./api/endpoints/prospecting";
import type { ActivityTarget, FieldActivityType, PropertyMatch } from "./api/endpoints/prospecting";

/**
 * The prospecting capture, as a state machine rather than a pile of booleans.
 *
 * A rep logging a visit is standing outside in the sun with one hand free. The screen has to be
 * unambiguous about what it is waiting for, and every branch below is a different sentence it needs to
 * say. Kept out of the component so the transitions can be tested without rendering anything —
 * this suite is pure-logic by convention, and the rules here are the part worth pinning.
 */

/** What a rep is asked to do about the property, which is the only mandatory part of the capture. */
export type PropertyStep =
  /** Haven't asked for a fix yet. */
  | { kind: "start" }
  /** Waiting on GPS or on the match query. */
  | { kind: "locating" }
  /** We know where they are and what is nearby — they confirm one, or say none of these. */
  | { kind: "choose"; matches: PropertyMatch[]; address: CapturedAddress | null }
  /** Confirmed. The capture now has a target and can be submitted. */
  | { kind: "chosen"; property: PropertyMatch }
  /** Nothing matched (or they rejected the matches) — they are creating one. */
  | { kind: "creating"; address: CapturedAddress | null }
  /** No GPS. They can still type an address, or attach the log to a company/contact instead. */
  | { kind: "manual"; reason: string };

export type CapturedAddress = {
  address: string;
  city: string;
  state: string;
  zip: string;
  lat?: number;
  lng?: number;
};

/**
 * A capture is submittable when it has SOMEWHERE TO GO and SOMETHING TO SAY.
 *
 * The first half mirrors the server: `source_entity_type`/`source_entity_id` are NOT NULL and the route
 * answers 400 "Activity target is required". Checking it here is not duplicated validation — it is the
 * difference between a disabled button with a reason and a rep filling in a whole form outside, tapping
 * save, and getting a 400 they cannot act on.
 *
 * The second half is ours: an activity with a target and no content is a row that says a rep was
 * somewhere and nothing about why, which is worse than no row because it looks like data.
 */
export function canSubmit(input: {
  target: ActivityTarget;
  type: FieldActivityType | null;
  body: string;
  outcome: string;
}): boolean {
  if (!hasActivityTarget(input.target) || !input.type) return false;
  return input.body.trim().length > 0 || input.outcome.trim().length > 0;
}

/**
 * Why the save button is disabled, in the rep's words.
 *
 * A disabled control with no explanation is the same defect as a dead one: the rep cannot tell whether
 * they missed a field or the app is broken, and outside on a roof they will not go hunting.
 */
export function submitBlockedReason(input: {
  target: ActivityTarget;
  type: FieldActivityType | null;
  body: string;
  outcome: string;
}): string | null {
  if (canSubmit(input)) return null;
  if (!hasActivityTarget(input.target)) {
    return "Pick the property, company or contact this visit was about.";
  }
  if (!input.type) return "Choose what happened — a visit, a call, a meeting.";
  return "Add a note or an outcome so this log says something.";
}

/**
 * Should the screen warn that the position is too coarse to trust?
 *
 * A 300-metre fix covers a city block, and the matcher works at 200. Offering "the property you're at"
 * from that is a confident guess, and a confidently wrong property attaches the visit to the neighbour.
 */
export function isPositionTooCoarse(accuracyMeters: number | null, thresholdMeters: number): boolean {
  return accuracyMeters != null && accuracyMeters > thresholdMeters;
}

/**
 * How a match should describe itself.
 *
 * The reason travels from the server precisely so this is not a guess. "Same address" and "40 m away"
 * are different claims with different confidence, and a rep confirming a building deserves the one that
 * is actually being made — an unexplained suggestion is how the wrong property gets confirmed.
 */
export function describeMatch(match: PropertyMatch): string {
  const distance =
    match.distanceMeters != null
      ? match.distanceMeters < 1000
        // ROUNDED. distanceMeters is a number, not an integer — a server value of 40.7318 rendered
        // "40.7318 m away", which reads as false precision from a GPS fix accurate to tens of metres.
        ? `${Math.round(match.distanceMeters)} m away`
        : `${(match.distanceMeters / 1000).toFixed(1)} km away`
      : null;

  if (match.addressMatch === "exact") return distance ? `Same address · ${distance}` : "Same address";
  // "base" means the stored record names a suite and the geocode didn't (or the reverse) — a strong
  // hint, not a certainty, and saying so is what stops a rep confirming the wrong tenancy in a tower.
  if (match.addressMatch === "base") {
    // The suite caveat survives a distance reading. Coordinates prove the BUILDING, never the tenancy,
    // so "Same building · 12 m away" without it reads as certainty about the wrong thing — and
    // confirming the wrong suite attaches the visit to the neighbouring tenant.
    return distance ? `Same building · ${distance} — check the suite` : "Same building — check the suite";
  }
  return distance ?? "Nearby";
}
