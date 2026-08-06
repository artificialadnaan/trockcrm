// The Monday-showcase page-local Service / Other filter, encoded in the URL so it survives a variant
// switch and travels in a shared link. This module owns the CLIENT side of the ?routes= codec -- the page
// reads a parsed selection and never touches the raw string.
//
// It does NOT decide what a link means. That verdict comes from parseShowcaseRouteValues in shared/, the
// same function both server endpoints consult, because this page is a THIRD parser of one param and the
// first two already disagreed twice. The most recent disagreement was here: URLSearchParams.get() returns
// only the FIRST occurrence, so ?routes=service&routes=other read as a valid Service-only selection on the
// page while the server rejected the same URL as ambiguous. This module now maps a shared verdict onto the
// page's three states instead of re-deriving one.
//
// THE CONTRACT
//   ?routes absent          -> BOTH buckets. The default, and byte-identical to the pre-filter report:
//                              every existing bookmark keeps today's numbers.
//   ?routes=service         -> Service only
//   ?routes=other           -> Other only
//   ?routes=service,other   -> both, explicitly (same payload as absent; the server's both-buckets
//                              short-circuit emits no predicate either way)
//   ?routes=none            -> NEITHER. A real, representable state -- the user deselected both chips.
//                              It is NOT "everything": the page renders a "select at least one" panel and
//                              never fetches, because zeros presented as measurements is the failure mode
//                              this whole filter is built to avoid.
//   ?routes twice           -> INVALID. Which occurrence wins is a guess, and a guess here shows a slice
//                              the server would refuse to produce.
//   anything else           -> INVALID. Surfaced as an error panel. The page does NOT fall back to
//                              "both", because that would silently show the unfiltered report while the
//                              URL claims a filter -- a viewer would read office numbers as a slice.

import {
  SHOWCASE_ROUTES_NONE,
  parseShowcaseRouteValues,
} from "@trock-crm/shared/types";
import { ROUTE_BUCKETS, type RouteBucket } from "./types";

export const ROUTES_PARAM = "routes";
/** The literal that encodes "no bucket selected" (distinct from an absent param, which means BOTH). */
export const ROUTES_NONE = SHOWCASE_ROUTES_NONE;

export type RouteSelection =
  /** One or both buckets. `buckets` is always non-empty and in canonical order. */
  | { kind: "selection"; buckets: RouteBucket[] }
  /** Both chips off. Renders the explicit empty state -- never zeros, never a fetch. */
  | { kind: "empty" }
  /** Unparseable ?routes value. Renders an error naming the bad value -- never a silent full result. */
  | { kind: "invalid"; raw: string };

/** The default when ?routes is absent: everything, exactly as the report behaved before this filter. */
export const DEFAULT_ROUTE_SELECTION: RouteSelection = { kind: "selection", buckets: [...ROUTE_BUCKETS] };

/**
 * Parse ALL occurrences of ?routes (i.e. searchParams.getAll, never .get) into the page's selection state.
 *
 * Taking the full list is the whole point: .get() collapses a repeated param to its first value, which
 * silently turns an ambiguous URL into a confident-looking slice -- and a slice the server would reject.
 * The shared parser sees the repetition and calls it invalid; this function just maps that verdict onto
 * the three states the page can render.
 */
export function parseRouteSelection(values: readonly string[]): RouteSelection {
  const parsed = parseShowcaseRouteValues(values);
  switch (parsed.kind) {
    case "absent":
      return DEFAULT_ROUTE_SELECTION;
    case "selection":
      // The shared bucket union and the client's RouteBucket are the same two literals (client `types.ts`
      // mirrors the shared vocabulary), so this is a naming bridge, not a widening.
      return { kind: "selection", buckets: parsed.buckets as RouteBucket[] };
    case "empty":
      return { kind: "empty" };
    case "invalid":
      return { kind: "invalid", raw: parsed.raw };
  }
}

/**
 * The ?routes value for a selection, or `null` when the param should be REMOVED. Both-buckets serializes
 * to null so the default state leaves a clean URL (and a copied link behaves like a pre-filter one).
 */
export function serializeRouteSelection(selection: RouteSelection): string | null {
  if (selection.kind === "empty") return ROUTES_NONE;
  if (selection.kind === "invalid") return selection.raw;
  if (selection.buckets.length === ROUTE_BUCKETS.length) return null;
  return selection.buckets.join(",");
}

/**
 * Toggle one chip. Turning the last chip off yields the EMPTY selection rather than snapping back to
 * "both" -- the user asked for neither, and the page owes them that state honestly, not a silent reset to
 * a full report. Toggling a chip on from `empty`/`invalid` starts a fresh single-bucket selection.
 */
export function toggleRouteBucket(selection: RouteSelection, bucket: RouteBucket): RouteSelection {
  const current = selection.kind === "selection" ? selection.buckets : [];
  const next = current.includes(bucket) ? current.filter((b) => b !== bucket) : [...current, bucket];
  if (next.length === 0) return { kind: "empty" };
  return { kind: "selection", buckets: ROUTE_BUCKETS.filter((b) => next.includes(b)) };
}

export function isBucketSelected(selection: RouteSelection, bucket: RouteBucket): boolean {
  return selection.kind === "selection" && selection.buckets.includes(bucket);
}

/**
 * Does a payload's own routeFilter.selected describe the selection currently in the chips?
 *
 * Used to gate the server-sourced caveat ("Showing Service only. Not filtered: ..."). During a refetch the
 * PREVIOUS payload is still in hand, so a caveat rendered straight off it can contradict the chips beside
 * it — "All departments" and "Showing Service only" at the same time. That caveat is the only disclosure
 * the unfilterable figures (Active leads) have, so it must never describe a payload that is no longer on
 * screen. Compared as SETS: the payload's order is canonical, but this must not depend on that.
 */
export function payloadDescribesSelection(
  payloadSelected: readonly RouteBucket[],
  selection: RouteSelection
): boolean {
  if (selection.kind !== "selection") return false;
  return (
    payloadSelected.length === selection.buckets.length &&
    selection.buckets.every((b) => payloadSelected.includes(b))
  );
}

/**
 * The buckets to send to the server, or `undefined` for "send no ?routes at all". Both-buckets returns
 * undefined so the default page load issues the EXACT request it issued before this filter existed.
 * `empty`/`invalid` return undefined too -- but those states never reach a fetch (the page short-circuits
 * to its own panel), so this is a type-level convenience, not a fallback to unfiltered data.
 */
export function routesForRequest(selection: RouteSelection): RouteBucket[] | undefined {
  if (selection.kind !== "selection") return undefined;
  if (selection.buckets.length === ROUTE_BUCKETS.length) return undefined;
  return selection.buckets;
}

/** True when the page may fetch. `empty` and `invalid` must render a panel instead of any numbers. */
export function isFetchableSelection(selection: RouteSelection): boolean {
  return selection.kind === "selection";
}
