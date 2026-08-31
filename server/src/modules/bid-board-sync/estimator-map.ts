/**
 * Estimator-name -> CRM user-id resolution for the Bid Board ingest.
 *
 * The Bid Board export carries the estimator as a free-text NAME (deals.bid_board_estimator);
 * the rep/owner filter matches a user UUID. We resolve the name to a user id ONCE at ingest
 * via an explicit, curated config map (NOT fuzzy name matching — see PR #618: free-text
 * matching silently breaks on case/whitespace/spelling). The resolved id is stored on
 * deals.estimator_user_id so the filter is a clean id-OR-id match.
 *
 * Config source: env var BID_BOARD_ESTIMATOR_USER_MAP, a JSON object of
 * { "<estimator name>": "<user uuid>" }. The feature is inert (resolves null) until the env
 * var is set on the CRM server. Lookup keys are normalized (NFC, collapse whitespace, trim,
 * lowercase) so "Alex Koch" / "alex  koch" / "ALEX KOCH" all match the same entry.
 *
 * SECOND SOURCE — the `estimates_jobs` roster (see buildEstimatorDirectory below).
 *
 * The env map alone means every new estimator needs a config edit on two Railway services plus a
 * backfill run before a single one of their deals stops reading "Missing estimator". Admin → Users
 * already carries a per-person "Estimates jobs" flag (migration 0222), and until now nothing in
 * resolution consulted it: ticking the box added someone to the dashboard's Estimator FILTER and
 * changed nothing about whether their name resolved. Two systems describing the same fact, only one
 * of them wired.
 *
 * So the directory is consulted as a FALLBACK, and the curated map still wins. That order is the
 * whole design:
 *   - the map exists for ALIASES — the Bid Board's spelling that will never equal a display name
 *     ("Tim Mitchell" for CRM's "Timothy Mitchell"). A flag can't express that, so the map has to win
 *     or curated corrections would be silently overridden by a coincidental name match.
 *   - the directory covers the ordinary case, where the Bid Board spells the name the way the CRM
 *     does, and the only missing thing was somebody editing an env var.
 *
 * This is NOT the fuzzy matching PR #618 rejected. Both sources compare fully-normalized strings for
 * EQUALITY; the directory just sources one side from `users.display_name` instead of a JSON key.
 * Nothing here does edit distance, prefixes, or first-name matching — and a display name shared by
 * two flagged users resolves to NOTHING rather than picking one.
 */

export const BID_BOARD_ESTIMATOR_USER_MAP_ENV = "BID_BOARD_ESTIMATOR_USER_MAP";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalize an estimator name into a stable lookup key. */
export function normalizeEstimatorKey(value: unknown): string | null {
  if (value == null) return null;
  const key = String(value)
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return key.length > 0 ? key : null;
}

function parseMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw?.trim()) return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map; // malformed JSON -> inert, never throws into ingest
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;
  for (const [name, id] of Object.entries(parsed as Record<string, unknown>)) {
    const key = normalizeEstimatorKey(name);
    if (key && typeof id === "string" && UUID_RE.test(id.trim())) {
      // Lowercase to match Postgres' uuid rendering (public.users.id is lowercase), so an
      // uppercase-but-valid UUID in the env map still validates against the active-user set.
      map.set(key, id.trim().toLowerCase());
    }
  }
  return map;
}

// Cache keyed on the raw env string so a config change (incl. in tests) re-parses.
let cachedRaw: string | undefined;
let cachedMap: Map<string, string> = new Map();

function currentMap(): Map<string, string> {
  const raw = process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV];
  if (raw !== cachedRaw) {
    cachedMap = parseMap(raw);
    cachedRaw = raw;
  }
  return cachedMap;
}

/** Distinct CRM user ids in BID_BOARD_ESTIMATOR_USER_MAP — the estimator roster. Empty until the env is
 *  configured. Multiple name aliases collapse to one id. */
export function estimatorRosterUserIds(): string[] {
  return [...new Set(currentMap().values())];
}

/**
 * The estimator roster as {userId, name} pairs — each distinct roster user id paired with the best display
 * name the map carries for it (the longest alias, most likely the full name; the name is the normalized,
 * lowercased map key). Lets the estimator report show a human-readable name for a roster id that has NO
 * matching CRM user (a misconfigured map entry) instead of a raw UUID. Empty until the env is configured.
 */
export function estimatorRosterEntries(): Array<{ userId: string; name: string }> {
  const bestNameById = new Map<string, string>();
  for (const [name, userId] of currentMap().entries()) {
    const existing = bestNameById.get(userId);
    if (!existing || name.length > existing.length) bestNameById.set(userId, name);
  }
  return [...bestNameById.entries()].map(([userId, name]) => ({ userId, name }));
}

/**
 * ACTIVE users flagged `estimates_jobs`, indexed by their normalized display name.
 *
 * Built by the caller because this module must not own a database handle — the ingest, the two
 * backfills and the tests all reach resolution by different routes, and a query hidden in here would
 * make the pure functions above untestable without one.
 */
export interface EstimatorDirectory {
  /** normalized display name -> user id. Ambiguous names are ABSENT, never arbitrarily resolved. */
  readonly byName: ReadonlyMap<string, string>;
  /** Normalized names carried by more than one flagged user. Reported so a caller can warn. */
  readonly ambiguous: ReadonlySet<string>;
}

export const EMPTY_ESTIMATOR_DIRECTORY: EstimatorDirectory = {
  byName: new Map(),
  ambiguous: new Set(),
};

/**
 * Index flagged users by normalized display name.
 *
 * A name held by two flagged users is dropped from `byName` rather than resolved to whichever row the
 * database returned first. Picking one would attribute a deal — and, once it is signed, an additive
 * estimator commission — to a coin flip that changes with the query plan. "Missing estimator" is a
 * visible, fixable state; the wrong estimator silently paid is not. The collision is surfaced in
 * `ambiguous` so it can be reported instead of just vanishing.
 *
 * Note both users are removed, including the first: a later duplicate must not leave the earlier one
 * resolvable, or resolution would depend on row order after all.
 */
export function buildEstimatorDirectory(
  users: ReadonlyArray<{ id: string; displayName: string | null }>
): EstimatorDirectory {
  const byName = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const user of users) {
    const key = normalizeEstimatorKey(user.displayName);
    if (!key || typeof user.id !== "string" || !UUID_RE.test(user.id)) continue;
    const id = user.id.toLowerCase();
    const seen = byName.get(key);
    if (seen && seen !== id) {
      byName.delete(key);
      ambiguous.add(key);
      continue;
    }
    if (!ambiguous.has(key)) byName.set(key, id);
  }
  return { byName, ambiguous };
}

/**
 * Resolve a Bid Board estimator name to a CRM user id, or null if unresolvable/blank/unset.
 *
 * The curated env map is checked FIRST and wins outright — see the alias reasoning in the module
 * header. `directory` is optional so every existing caller keeps its behaviour unchanged until it
 * opts in by passing one.
 */
export function resolveEstimatorUserId(
  estimatorName: unknown,
  directory?: EstimatorDirectory | null
): string | null {
  const key = normalizeEstimatorKey(estimatorName);
  if (!key) return null;
  return currentMap().get(key) ?? directory?.byName.get(key) ?? null;
}

/**
 * Resolve an estimator name to a user id ONLY if it is an existing (active) user. A
 * misconfigured map id (valid UUID shape but no such user) would otherwise FK-violate the
 * deals.estimator_user_id foreign key; this degrades it to null instead. Pass the set of
 * valid user ids (e.g. SELECT id FROM public.users WHERE is_active).
 */
export function existingEstimatorUserId(
  estimatorName: unknown,
  validUserIds: ReadonlySet<string>,
  directory?: EstimatorDirectory | null
): string | null {
  const id = resolveEstimatorUserId(estimatorName, directory);
  return id && validUserIds.has(id) ? id : null;
}

/**
 * Whether resolution can produce anything at all, from EITHER source.
 *
 * When neither can, ingest must PRESERVE the existing estimator_user_id rather than overwrite it with
 * null — otherwise a deploy gap, or a config that has not landed yet, would wipe previously-backfilled
 * ids. That behaviour is unchanged; only what counts as "configured" is wider.
 *
 * This REPLACES the former env-only `isEstimatorMapConfigured()`. Asking only about the env var was
 * correct while the env var was the only source; now, on a server whose roster lives entirely in the
 * `estimates_jobs` flags, it would report false and skip resolution altogether — leaving exactly the
 * "Missing estimator" rows this exists to prevent. A directory of nothing but AMBIGUOUS names resolves
 * nothing and so does not open the gate either.
 */
export function isEstimatorResolutionConfigured(directory?: EstimatorDirectory | null): boolean {
  return currentMap().size > 0 || (directory?.byName.size ?? 0) > 0;
}
