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

/** Resolve a Bid Board estimator name to a CRM user id, or null if unmapped/blank/unset. */
export function resolveEstimatorUserId(estimatorName: unknown): string | null {
  const key = normalizeEstimatorKey(estimatorName);
  if (!key) return null;
  return currentMap().get(key) ?? null;
}

/**
 * Resolve an estimator name to a user id ONLY if it is an existing (active) user. A
 * misconfigured map id (valid UUID shape but no such user) would otherwise FK-violate the
 * deals.estimator_user_id foreign key; this degrades it to null instead. Pass the set of
 * valid user ids (e.g. SELECT id FROM public.users WHERE is_active).
 */
export function existingEstimatorUserId(
  estimatorName: unknown,
  validUserIds: ReadonlySet<string>
): string | null {
  const id = resolveEstimatorUserId(estimatorName);
  return id && validUserIds.has(id) ? id : null;
}

/**
 * True when BID_BOARD_ESTIMATOR_USER_MAP is configured with at least one valid entry.
 * When it is NOT configured (unset / empty / malformed), ingest must PRESERVE the existing
 * estimator_user_id rather than overwrite it with null — otherwise a deploy gap would wipe
 * previously-backfilled ids.
 */
export function isEstimatorMapConfigured(): boolean {
  return currentMap().size > 0;
}
