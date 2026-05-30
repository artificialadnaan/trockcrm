import { LOST_STAGE_SLUGS, WON_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";

/**
 * Pure helpers for the unified global search (PR5). Kept separate from the DB-executing
 * orchestrator (service.ts) so the status / cap / ordering logic is unit-testable without a
 * live database -- the per-office query execution is exercised end-to-end in CI / live verify.
 *
 * READ-ONLY display markers: deriveDealStatus only LABELS a deal's existing lifecycle for a
 * search badge. It never reads/writes won_closed_date, never calls getWonCloseSummary, and
 * never touches a reporting aggregate -- the Won basis (191 / $9,778,045.90) is unaffected.
 */

export type DealLifecycle = "active" | "on_hold" | "won" | "lost";

/**
 * Label a deal's lifecycle from its denormalized stage slug + on-hold flag, so terminal
 * (won/lost) deals can be shown FINDABLE but MARKED rather than hidden by an is_active filter.
 */
export function deriveDealStatus(
  stageSlug: string | null | undefined,
  onHold: boolean | null | undefined
): DealLifecycle {
  const slug = (stageSlug ?? "").trim();
  if (slug && (WON_STAGE_SLUGS as readonly string[]).includes(slug)) return "won";
  if (slug && (LOST_STAGE_SLUGS as readonly string[]).includes(slug)) return "lost";
  if (onHold) return "on_hold";
  return "active";
}

/**
 * Director anti-crowd-out: how many rows to take PER OFFICE before merging, so a large office
 * cannot starve a small one. ceil(limit / nOffices) with a floor of 5; single office (or fewer)
 * just uses the full per-entity limit.
 */
export function capPerOffice(perEntityLimit: number, officeCount: number): number {
  if (officeCount <= 1) return perEntityLimit;
  return Math.max(5, Math.ceil(perEntityLimit / officeCount));
}

// Active results first, then on-hold, then terminal (won/lost) -- so closed records are
// findable but never mixed in as if they were live.
const STATUS_TIER: Record<DealLifecycle, number> = { active: 0, on_hold: 1, won: 2, lost: 2 };

/**
 * Lightweight match-quality score for ordering hits: exact (3) > prefix (2) > substring (1) >
 * matched only via a related/EXISTS field like company or owner (0). Pure, so ordering is
 * testable without a database; the SQL only has to FIND the rows.
 */
export function scoreMatch(query: string, ...candidates: Array<string | null | undefined>): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  let best = 0;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = candidate.toLowerCase();
    if (value === q) return 3;
    if (value.startsWith(q)) best = Math.max(best, 2);
    else if (value.includes(q)) best = Math.max(best, 1);
  }
  return best;
}

export interface RankableHit {
  rank: number;
  status?: DealLifecycle | null;
}

/** Sort comparator: status tier asc (active first), then rank desc. Stable for equal keys. */
export function compareHits(a: RankableHit, b: RankableHit): number {
  const tierA = a.status ? STATUS_TIER[a.status] : 0;
  const tierB = b.status ? STATUS_TIER[b.status] : 0;
  if (tierA !== tierB) return tierA - tierB;
  return b.rank - a.rank;
}

/**
 * Merge per-office hits, re-rank globally (active-first then rank), and truncate to the
 * per-entity limit. Returns both the visible page and the pre-truncation total so the UI can
 * show "N results / See all".
 */
export function mergeAndLimit<T extends RankableHit>(
  hits: T[],
  perEntityLimit: number
): { hits: T[]; total: number; truncated: boolean } {
  const total = hits.length;
  const sorted = [...hits].sort(compareHits).slice(0, perEntityLimit);
  return { hits: sorted, total, truncated: total > perEntityLimit };
}
