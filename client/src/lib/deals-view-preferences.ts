// Per-user persistence for the /deals dashboard's STANDING header filters, so a selection survives navigating
// into a deal and back (via a nav link, which lands on a bare /deals with no query). Mirrors the localStorage
// pattern of scope-preferences.ts (Mine/All), extended to the header Rep + timeframe.
//
// Scope (Mine/All) is intentionally NOT handled here — it already persists via scope-preferences.ts, and the
// read path there (resolvePreferredScope) owns it.
//
// The base-list FilterBar (`dl_*`) dimensions are also NOT persisted here: those params are dropped from the
// URL whenever a KPI drill-down is opened, so persisting them correctly needs dedicated round-trip handling
// (a saved base-list filter must not be wiped just by viewing a drill-down). Tracked as a follow-up.
//
// Transient DRILL-DOWN state is likewise excluded (a drill-down is contextual, not a standing preference):
// the outcome selector `filter`, the drill-down FilterBar `fb_*`, and the KPI date windows
// (`terminal`/`estimate`/`won_*`/`lost_*`).

const STORAGE_PREFIX = "deals-view-preference";

// Keyed by user AND active office: a saved Rep (assignedRepId) is office-specific — restoring an office-A
// rep on an office-B dashboard would filter the board by a user who isn't in office B (empty/misleading).
// The timeframe is office-agnostic but is stored per-office too for simplicity (a multi-office user just
// re-picks it after switching offices; single-office users — the majority — are unaffected).
function storageKey(userId: string, officeId: string | null | undefined) {
  return `${STORAGE_PREFIX}:${userId}:${officeId ?? "default"}`;
}

/** Allowlist (not denylist) of the query params that represent a STANDING /deals header preference. */
export function isPersistableDealViewParam(key: string): boolean {
  return key === "period" || key === "assignedRepId";
}

/**
 * A "bare" /deals view carries no query state beyond `scope` (which persists on its own). Only a bare view
 * is safe to hydrate saved preferences into — any other param (a `?filter=` drill-down, a `dl_*` base-list
 * link, an explicit period/rep) makes the URL authoritative, so a shared/bookmarked link keeps its intended
 * result set instead of being narrowed by the recipient's stored rep/timeframe.
 */
export function isBareDealsView(search: string): boolean {
  for (const key of new URLSearchParams(search).keys()) {
    if (key !== "scope") return false;
  }
  return true;
}

/** The persistable subset of a URL query string, as a plain record (empty values dropped). */
export function collectPersistableDealViewParams(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (value && isPersistableDealViewParam(key)) out[key] = value;
  }
  return out;
}

export function readStoredDealView(
  userId: string | null | undefined,
  officeId: string | null | undefined,
): Record<string, string> {
  if (!userId || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey(userId, officeId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Re-filter on read so a persistence-set change (or hand-edited storage) can never resurrect a param
      // that is no longer a standing preference.
      if (typeof value === "string" && value && isPersistableDealViewParam(key)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeStoredDealView(
  userId: string | null | undefined,
  officeId: string | null | undefined,
  params: Record<string, string>,
): void {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(userId, officeId), JSON.stringify(params));
  } catch {
    // Ignore quota / disabled-storage errors — persistence is a convenience, never load-bearing.
  }
}

/**
 * Fill stored standing filters into `search` for any persistable key the URL does NOT already specify, and
 * return the new query string — or `null` when nothing changed, so the caller can skip a no-op navigation.
 * Params already present in the URL win (a shared/bookmarked link is authoritative), and non-persistable
 * params are left untouched.
 */
export function applyStoredDealView(search: string, stored: Record<string, string>): string | null {
  const params = new URLSearchParams(search);
  let changed = false;
  for (const [key, value] of Object.entries(stored)) {
    if (!value || !isPersistableDealViewParam(key)) continue;
    if (!params.has(key)) {
      params.set(key, value);
      changed = true;
    }
  }
  return changed ? params.toString() : null;
}
