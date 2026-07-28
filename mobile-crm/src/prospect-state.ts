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
/**
 * Is there any SECOND signal agreeing this is the right building?
 *
 * One rule, one place. It decides two things that must never disagree: what the row is LABELLED, and
 * whether it may veto creating a new building. Spelled out at both sites — as it briefly was — a change
 * to one silently contradicts the other, producing a row labelled "no city on file" that still blocks
 * Add, or a "Same address" that does not.
 *
 * A distance reading is corroboration on its own; so is any locality field, because
 * `localityContradicts` has already ruled out a disagreeing one.
 */
export function isCorroborated(match: PropertyMatch): boolean {
  if (match.distanceMeters != null) return true;
  // ZIP alone discriminates; so does a city WITH its state. A state on its own does not — "TX" against
  // a Dallas query agrees with every "100 Main St" in Texas, and since this verdict can VETO creating a
  // building, one such row would block the rep from adding the real one however often they rejected it.
  if (match.zip) return true;
  return Boolean(match.city && match.state);
}

export function describeMatch(match: PropertyMatch): string {
  const distance =
    match.distanceMeters != null
      ? match.distanceMeters < 1000
        // ROUNDED. distanceMeters is a number, not an integer — a server value of 40.7318 rendered
        // "40.7318 m away", which reads as false precision from a GPS fix accurate to tens of metres.
        ? `${Math.round(match.distanceMeters)} m away`
        : `${(match.distanceMeters / 1000).toFixed(1)} km away`
      : null;

  /**
   * UNCORROBORATED means say so, rather than claiming certainty.
   *
   * An uncoordinated legacy row with no city/state/zip cannot be checked against the query's locality —
   * `localityContradicts` has "cannot disprove" semantics, so it passes. That is right for MATCHING:
   * those rows are exactly what address matching exists to recover. It is wrong for the LABEL. "100
   * Main St" exists in every city, and calling one "Same address" with nothing corroborating it is the
   * kind of confident wrong answer a rep in a hurry confirms — filing the visit against a building in
   * another town.
   */
  if (match.addressMatch === "exact") {
    if (!isCorroborated(match)) {
      return "Same street line — no city on file, check this is the right one";
    }
    return distance ? `Same address · ${distance}` : "Same address";
  }
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

/**
 * What to do about the PERSON before the visit is written.
 *
 * This lived inline in the save mutation, where three separate defects hid in it: a retained id keyed
 * on nothing reused the previous person after a rename; a dedup reply logged the visit against nobody
 * while the screen said "Logged"; and an edited phone number was silently discarded because the retry
 * treated the committed contact as unchanged. All three are decisions, not effects — so they belong
 * here, where a test can hold them still.
 */
export type ContactPlan =
  | { action: "reuse"; contactId: string }
  | { action: "create" }
  | { action: "skip" };

export function planContact(input: {
  first: string;
  last: string;
  /** Every editable person field, joined. A subset silently reuses a stale contact. */
  key: string;
  /** A duplicate the rep picked from the prompt. */
  resolvedContactId: string | null;
  /** The rep said none of the suggestions is the person. */
  waived: boolean;
  /** Committed by an attempt whose activity write then failed. */
  retained?: { id: string; key: string };
}): { plan: ContactPlan; dropRetained: boolean } {
  // A stale retention is dropped BEFORE anything else looks at it — the whole point is that it must
  // never be reachable once the draft describes a different person, or the same person differently.
  const dropRetained = Boolean(input.retained && input.retained.key !== input.key);
  const retained = dropRetained ? undefined : input.retained;

  if (input.resolvedContactId) {
    return { plan: { action: "reuse", contactId: input.resolvedContactId }, dropRetained };
  }
  if (retained) return { plan: { action: "reuse", contactId: retained.id }, dropRetained };
  if (input.waived) return { plan: { action: "skip" }, dropRetained };
  if (input.first && input.last) return { plan: { action: "create" }, dropRetained };
  return { plan: { action: "skip" }, dropRetained };
}

/**
 * A dedup reply must STOP the save.
 *
 * `POST /contacts` answers 200 with no id and the ids of the people it matched. Writing the activity
 * anyway attaches it to nobody — permanently, since this app cannot edit an activity — while reporting
 * success. The rep has to answer first.
 */
export function haltsForDuplicates(input: {
  createdId?: string;
  duplicates?: { id: string }[] | null;
}): boolean {
  return !input.createdId && Boolean(input.duplicates?.length);
}

/**
 * Person details the save will throw away, because a contact is only created with BOTH names.
 *
 * Keyed on the names alone this missed a rep who typed only a phone number or a title: no warning, and
 * "Logged" over details that were never sent anywhere.
 */
export function personDetailsWillBeDiscarded(input: {
  first: string;
  last: string;
  phone: string;
  title: string;
}): boolean {
  const any = Boolean(
    input.first.trim() || input.last.trim() || input.phone.trim() || input.title.trim(),
  );
  return any && !(input.first.trim() && input.last.trim());
}

/** The canonical marker the office's queue matches on. Two spellings would mean two queues. */
export const LEAD_FLAG = "Create lead";

/**
 * What goes in the activity's `nextStep` when a rep marks a prospect worth a lead.
 *
 * The flag and the rep's own next step share ONE column, so the flag wins and carries their text with
 * it. Sending only the marker would discard what they typed; sending only their text would lose the
 * flag the office reads. Creating the lead on the phone is not an option — `POST /leads` demands a bid
 * due date, a build year and a unit count, none of which are knowable at a door, so a form here would
 * be a form for inventing them.
 */
export function leadFlagNextStep(input: { flagged: boolean; nextStep: string }): string | undefined {
  const typed = input.nextStep.trim();
  if (!input.flagged) return typed || undefined;
  return typed ? `${LEAD_FLAG} — ${typed}` : LEAD_FLAG;
}
