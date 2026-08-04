// The Monday-showcase page-local Service / Other filter, encoded in the URL so it survives a variant
// switch and travels in a shared link. This module owns the ?routes= codec ALONE -- the page reads a
// parsed selection and never touches the raw string, so there is exactly one place that decides what a
// link means.
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
//   anything else           -> INVALID. Surfaced as an error panel. The page does NOT fall back to
//                              "both", because that would silently show the unfiltered report while the
//                              URL claims a filter -- a viewer would read office numbers as a slice.

import { ROUTE_BUCKETS, type RouteBucket } from "./types";

export const ROUTES_PARAM = "routes";
/** The literal that encodes "no bucket selected" (distinct from an absent param, which means BOTH). */
export const ROUTES_NONE = "none";

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
 * Parse the raw ?routes value. `null`/absent -> the default (both). Order and whitespace are tolerated;
 * duplicates and unknown buckets are not (a typo must not silently degrade to a valid-looking subset).
 */
export function parseRouteSelection(raw: string | null): RouteSelection {
  if (raw === null) return DEFAULT_ROUTE_SELECTION;
  const trimmed = raw.trim();
  if (trimmed === ROUTES_NONE) return { kind: "empty" };
  const parts = trimmed.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  // An empty/whitespace ?routes= is ambiguous between "none" and a truncated link, so it is invalid rather
  // than quietly becoming either. `none` is the ONE spelling of the empty selection.
  if (parts.length === 0) return { kind: "invalid", raw };
  const seen = new Set<string>();
  for (const part of parts) {
    if (!(ROUTE_BUCKETS as readonly string[]).includes(part)) return { kind: "invalid", raw };
    if (seen.has(part)) return { kind: "invalid", raw };
    seen.add(part);
  }
  return { kind: "selection", buckets: ROUTE_BUCKETS.filter((b) => seen.has(b)) };
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
