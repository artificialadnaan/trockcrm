// The ONE decision function for the Monday-showcase Service / Other selection (`?routes`).
//
// WHY THIS LIVES IN shared/ RATHER THAN BESIDE EITHER CONSUMER
//
// Three separate places parse this param: the report endpoint, the evidence endpoint, and the page. The
// first two were made to share a reader after they disagreed about whether an empty value meant "absent";
// the page was left out, and disagreed again — `URLSearchParams.get()` returns only the FIRST value, so a
// repeated `?routes=service&routes=other` read as a valid Service-only selection on the client while the
// server rejected the same URL as ambiguous. A filtered-looking link would then show a slice the server
// would refuse to produce.
//
// Two parsers of one param is the shape that produced both bugs, so the vocabulary AND the verdict now
// live here and every consumer maps a shared result to its own surface. Adding a caller cannot
// re-introduce the disagreement: there is nothing left to re-implement.

/** The two buckets. "service" is deals.workflow_route = 'service'; "other" is everything else — a
 *  null/absent route is NOT service, so it lands in "other" (matching the deals dashboard's At Risk split). */
export const SHOWCASE_ROUTE_BUCKETS = ["service", "other"] as const;
export type ShowcaseRouteBucket = (typeof SHOWCASE_ROUTE_BUCKETS)[number];

/** The literal encoding "no bucket selected" — distinct from an ABSENT param, which means both. */
export const SHOWCASE_ROUTES_NONE = "none";

/**
 * The verdict on a raw `?routes`. Each consumer maps this to its own surface: the server turns `empty`
 * and `invalid` into 400s and `absent` into "no narrowing"; the page turns them into its
 * "select at least one" and "that link isn't valid" panels. What must NEVER differ between them is which
 * bucket of this union a given URL falls into — hence one function.
 */
export type ShowcaseRouteParse =
  /** The param is not present at all -> both buckets -> no narrowing, today's numbers. */
  | { kind: "absent" }
  /** One or both buckets, in canonical order. Always non-empty. */
  | { kind: "selection"; buckets: ShowcaseRouteBucket[] }
  /** Explicitly neither (the `none` sentinel). There is no honest report for this. */
  | { kind: "empty"; raw: string }
  /** Unusable. `reason` is safe to surface; `raw` is the offending value, for the message. */
  | { kind: "invalid"; reason: string; raw: string };

/**
 * Parse the raw `?routes` values — ALWAYS the full list of occurrences, never a pre-collapsed single
 * value. Taking a list is the point: a caller holding only the first occurrence has already discarded the
 * evidence that the param was repeated, and repetition is ambiguous, not a value to guess at.
 *
 *   []                      -> absent (both buckets)
 *   ["service"]             -> that bucket
 *   ["service,other"]       -> both, explicitly (order and whitespace normalized)
 *   ["none"]                -> empty selection
 *   ["service", "other"]    -> INVALID: repeated param, which occurrence wins is a guess
 *   ["", "  "]              -> INVALID: present but selects nothing (NOT the same as absent)
 *   ["banana"] / ["normal"] -> INVALID: unknown bucket ('normal' is the raw column value, not a bucket)
 *   ["service,service"]     -> INVALID: duplicate
 */
export function parseShowcaseRouteValues(values: readonly string[]): ShowcaseRouteParse {
  if (values.length === 0) return { kind: "absent" };
  if (values.length > 1) {
    return {
      kind: "invalid",
      reason: "routes must be given once, as a comma-separated list",
      raw: values.join("&routes="),
    };
  }

  const raw = values[0];
  if (raw.trim() === SHOWCASE_ROUTES_NONE) return { kind: "empty", raw };

  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  // Present but selecting nothing ("", "   ", ","). Deliberately NOT folded into `absent`: answering it
  // with the unfiltered report is the silent full-result fallback this contract forbids.
  if (parts.length === 0) {
    return {
      kind: "invalid",
      reason: `routes must select at least one of: ${SHOWCASE_ROUTE_BUCKETS.join(", ")}`,
      raw,
    };
  }

  const seen = new Set<string>();
  for (const part of parts) {
    if (!(SHOWCASE_ROUTE_BUCKETS as readonly string[]).includes(part)) {
      return {
        kind: "invalid",
        reason: `routes must be a comma-separated list of: ${SHOWCASE_ROUTE_BUCKETS.join(", ")}`,
        raw,
      };
    }
    if (seen.has(part)) {
      return { kind: "invalid", reason: `routes contains a duplicate bucket: ${part}`, raw };
    }
    seen.add(part);
  }

  // Canonical order, so the both-buckets short-circuit downstream is order-independent
  // ("other,service" must be exactly as inert as "service,other").
  return { kind: "selection", buckets: SHOWCASE_ROUTE_BUCKETS.filter((b) => seen.has(b)) };
}

/**
 * Normalize an arbitrary query value (Express `req.query.routes`, which is `string | string[] | undefined`
 * or an object for `?routes[a]=b`) into the list `parseShowcaseRouteValues` expects. A non-string present
 * value yields a single unusable entry so it is REJECTED rather than read as absent.
 */
export function showcaseRouteValuesFromQuery(value: unknown): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : String(v)));
  if (typeof value === "string") return [value];
  return [String(value)];
}
