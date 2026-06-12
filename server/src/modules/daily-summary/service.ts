import crypto from "crypto";
import { WON_DEAL_STAGE_SLUGS, reportableDealSqlPredicate } from "@trock-crm/shared/types";
import { BUSINESS_TIMEZONE } from "../../lib/period.js";
import type { QueryClient } from "../usage/raw-fetch.js";
import type { UsageBreakdown } from "../usage/types.js";
import { resolveReps, buildLiveDay } from "../usage/read-service.js";

// v1 scope: the daily summary covers office_dallas only (where the data lives). The table is keyed by
// (summary_date, office_code) so per-office summaries are a clean follow-up. Read the schema EXPLICITLY
// — never the connection's default search_path (the fan-out trap the rollup cron had).
export const DAILY_SUMMARY_OFFICE = "dallas";
export const DAILY_SUMMARY_SCHEMA = "office_dallas";
const SCHEMA_RE = /^office_[a-z0-9_]+$/;
const TOKEN_BYTES = 32;
const LEADERBOARD_LIMIT = 12;
export const AS_OF_LABEL = "as of 5:00 PM CT";

export interface BiggestMover {
  name: string;
  actions: number;
}
/** Per-rep action breakdown — the leaderboard's value is the named detail, not a bar length. */
export interface RepBreakdown {
  created: number;
  edits: number;
  stageMoves: number;
  uploads: number;
  emails: number;
  notes: number;
  reports: number;
}
export interface LeaderRow {
  rank: number;
  name: string;
  actions: number;
  // null -> render "—" (no browser session today). A rep WITH a session never shows 0m (floored to 1m),
  // so "0m" can never be misread as "idle". Reps who act via API/import (no heartbeats) -> null -> "—".
  activeMinutes: number | null;
  breakdown: RepBreakdown;
}
/** A deal Won today — canonical won_closed_date cohort + effective-won value, so it ties to Showcase/Region. */
export interface WonDeal {
  dealName: string;
  repName: string;
  value: number;
}
/** A non-terminal stage advance today (latest transition per deal). Excludes Won & Lost (both terminal). */
export interface AdvancedMove {
  dealName: string;
  repName: string;
  fromStage: string | null;
  toStage: string | null;
}
/** Browser-session reps active in a given CT hour — the page's one honest time visual. */
export interface HourCount {
  hour: number;
  reps: number;
}
export interface DailySummaryPayload {
  date: string; // YYYY-MM-DD (America/Chicago)
  office: string;
  asOfLabel: string; // "as of 5:00 PM CT"
  headline: {
    activeReps: number;
    totalReps: number;
    totalActions: number;
    totalActiveMinutes: number; // team time spent today (sum of per-rep minutes); 0 -> render "—"
    totalSessions: number; // team browser sessions today
    biggestMover: BiggestMover | null; // null -> render "—", never $NaN/undefined
  };
  wonToday: WonDeal[]; // the headline count AND total derive from THIS array — no count/items drift
  advancedToday: AdvancedMove[];
  leaderboard: LeaderRow[];
  hourly: HourCount[]; // page-only; empty on quiet days
  teamHealth: { active: number; quiet: number; quietNames: string[] };
}

const ZERO_REP_BREAKDOWN = (): RepBreakdown => ({
  created: 0, edits: 0, stageMoves: 0, uploads: 0, emails: 0, notes: 0, reports: 0,
});

/** Map the canonical usage breakdown JSONB into the leaderboard's named buckets. */
function toRepBreakdown(b: UsageBreakdown): RepBreakdown {
  return {
    created: b.creates,
    edits: b.edits,
    stageMoves: b.stage_moves,
    uploads: b.uploads,
    emails: b.activities.email ?? 0,
    notes: b.activities.note ?? 0,
    reports: b.report_views,
  };
}

const numberOr0 = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Mirrors public-photo-tokens: an unguessable raw token; only its SHA-256 hash is ever stored. */
export function generateRawSummaryToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}
export function hashSummaryToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * "Active" for the leadership summary = did at least one action today. Telemetry (heartbeat time) is
 * sparse, so an activeSeconds-only definition would report everyone quiet even when they worked — for
 * a "who moved the needle today" email, actions are the signal.
 */
const didWork = (actionCount: number) => actionCount > 0;

/** Deterministic order: actions desc, then name A→Z (stable tiebreak — no rank flicker run-to-run). */
function byActionsThenName(a: { name: string; actions: number }, b: { name: string; actions: number }) {
  if (b.actions !== a.actions) return b.actions - a.actions;
  return a.name.localeCompare(b.name);
}

/**
 * Pure rep-rollup: deterministic leaderboard + headline pieces from per-rep action counts. Biggest
 * mover is the top of the (actions desc, name asc) order — but null when nobody worked (zero-guard, so
 * the headline shows "—", never $NaN/undefined). Exported for unit testing (tiebreak / quiet day).
 */
export interface RepRollupInput {
  name: string;
  actions: number;
  activeMinutes?: number | null;
  breakdown?: RepBreakdown;
}
export function summarizeReps(perRep: RepRollupInput[]): {
  leaderboard: LeaderRow[];
  biggestMover: BiggestMover | null;
  totalActions: number;
  activeReps: number;
  quietNames: string[];
} {
  const sorted = [...perRep].sort(byActionsThenName);
  const totalActions = sorted.reduce((s, r) => s + r.actions, 0);
  const workers = sorted.filter((r) => didWork(r.actions));
  return {
    leaderboard: sorted.slice(0, LEADERBOARD_LIMIT).map((r, i) => ({
      rank: i + 1,
      name: r.name,
      actions: r.actions,
      activeMinutes: r.activeMinutes ?? null,
      breakdown: r.breakdown ?? ZERO_REP_BREAKDOWN(),
    })),
    biggestMover: workers.length > 0 ? { name: workers[0].name, actions: workers[0].actions } : null,
    totalActions,
    activeReps: workers.length,
    quietNames: sorted.filter((r) => !didWork(r.actions)).map((r) => r.name),
  };
}

/**
 * Compute the day's summary from the LIVE "today" path (buildLiveDay) for the given office schema.
 * Called at 5pm CT by the cron and snapshotted. Reads the schema EXPLICITLY (never the default).
 */
export async function computeDailySummary(client: QueryClient, schema: string, date: string): Promise<DailySummaryPayload> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const reps = await resolveReps(client, null);

  const perRep: RepRollupInput[] = [];
  let totalActiveMinutes = 0;
  let totalSessions = 0;
  for (const rep of reps) {
    const usage = await buildLiveDay(client, schema, rep.id, date);
    // "minutes where present, — where absent, never 0m": no browser session (firstActiveAt null) -> null.
    const activeMinutes = usage.firstActiveAt === null ? null : Math.max(1, Math.round(usage.activeSeconds / 60));
    totalActiveMinutes += activeMinutes ?? 0; // team time spent counts only reps with a real session
    totalSessions += usage.sessionCount;
    perRep.push({
      name: rep.displayName,
      actions: usage.actionCount,
      activeMinutes,
      breakdown: toRepBreakdown(usage.breakdown),
    });
  }
  const s = summarizeReps(perRep);
  // Sequential (single pg client serializes queries): won/advanced/hourly each read different tables.
  const wonToday = await readWonToday(client, schema, date);
  const advancedToday = await readAdvancedToday(client, schema, date);
  const hourly = await readHourly(client, schema, date);

  return {
    date,
    office: DAILY_SUMMARY_OFFICE,
    asOfLabel: AS_OF_LABEL,
    headline: {
      activeReps: s.activeReps,
      totalReps: reps.length,
      totalActions: s.totalActions,
      totalActiveMinutes,
      totalSessions,
      biggestMover: s.biggestMover,
    },
    wonToday,
    advancedToday,
    leaderboard: s.leaderboard,
    hourly,
    teamHealth: { active: s.activeReps, quiet: s.quietNames.length, quietNames: s.quietNames },
  };
}

// CANONICAL Won-today value — effective-won (on-hold -> 0, awarded-first fallback chain), mirroring
// aliasedEffectiveWonDealValueSql / region-report-service so the email's "$X won" ties to Showcase/Region.
const WON_VALUE_SQL = `CASE WHEN COALESCE(d.on_hold, false) THEN 0 ELSE COALESCE(
  CASE WHEN d.awarded_amount > 0 THEN d.awarded_amount END,
  CASE WHEN d.bid_board_total_sales > 0 THEN d.bid_board_total_sales END,
  CASE WHEN d.bid_estimate > 0 THEN d.bid_estimate END,
  CASE WHEN d.dd_estimate > 0 THEN d.dd_estimate END, 0) END`;

/**
 * Deals Won today, named — the CANONICAL won_closed_date cohort (won stage slug + usable won date +
 * won_closed_date = today), reportable + non-test, valued by the effective-won chain. The full set is
 * returned; the email derives BOTH its header count/total AND its listed rows from this one array, so the
 * "2 · $312K" header always reconciles to the named deals beneath it.
 */
export async function readWonToday(client: QueryClient, schema: string, date: string): Promise<WonDeal[]> {
  const { rows } = await client.query<{ deal_name: string | null; rep_name: string | null; value: string | number | null }>(
    `SELECT d.name AS deal_name, u.display_name AS rep_name, (${WON_VALUE_SQL})::numeric AS value
       FROM ${schema}.deals d
       JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
       LEFT JOIN public.users u ON u.id = d.assigned_rep_id
      WHERE psc.slug = ANY($2::text[])
        AND d.won_closed_date IS NOT NULL
        AND d.won_closed_date = $1::date
        AND ${reportableDealSqlPredicate("d")}
        AND COALESCE(d.is_test_data, false) = false
      ORDER BY value DESC NULLS LAST, d.name ASC`,
    [date, WON_DEAL_STAGE_SLUGS as unknown as string[]],
  );
  return rows.map((r) => ({
    dealName: r.deal_name ?? "(unnamed deal)",
    repName: r.rep_name ?? "Unassigned",
    value: numberOr0(r.value),
  }));
}

/**
 * Deals that ADVANCED today: stage transitions whose to-stage is non-terminal (so this excludes moves
 * into Won AND into Lost — both terminal). DISTINCT ON keeps only each deal's latest transition that day,
 * so a deal that moved twice is listed once. Resolved to from/to stage names via pipeline_stage_config.
 */
export async function readAdvancedToday(client: QueryClient, schema: string, date: string): Promise<AdvancedMove[]> {
  const { rows } = await client.query<{
    deal_name: string | null; rep_name: string | null; from_stage: string | null; to_stage: string | null; created_at: string;
  }>(
    `SELECT DISTINCT ON (sh.deal_id)
            d.name AS deal_name, u.display_name AS rep_name,
            fs.name AS from_stage, ts.name AS to_stage, sh.created_at
       FROM ${schema}.deal_stage_history sh
       LEFT JOIN ${schema}.deals d ON sh.deal_id = d.id
       LEFT JOIN public.users u ON u.id = d.assigned_rep_id
       LEFT JOIN public.pipeline_stage_config fs ON sh.from_stage_id = fs.id
       LEFT JOIN public.pipeline_stage_config ts ON sh.to_stage_id = ts.id
      WHERE sh.created_at >= ($1::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        AND sh.created_at < (($1::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        AND COALESCE(ts.is_terminal, false) = false
      ORDER BY sh.deal_id, sh.created_at DESC`,
    [date],
  );
  // DISTINCT ON forces deal_id ordering; present newest-move-first for the reader.
  return [...rows]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .map((r) => ({
      dealName: r.deal_name ?? "(unnamed deal)",
      repName: r.rep_name ?? "Unassigned",
      fromStage: r.from_stage,
      toStage: r.to_stage,
    }));
}

/** Distinct browser-session reps per CT hour today — the page's hourly curve (honest: browser reps only). */
export async function readHourly(client: QueryClient, schema: string, date: string): Promise<HourCount[]> {
  const { rows } = await client.query<{ hour: number | string; reps: number | string }>(
    `SELECT EXTRACT(HOUR FROM (h.at AT TIME ZONE '${BUSINESS_TIMEZONE}'))::int AS hour,
            COUNT(DISTINCT h.user_id)::int AS reps
       FROM ${schema}.usage_heartbeat h
      WHERE (h.at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date = $1::date
      GROUP BY hour
      ORDER BY hour`,
    [date],
  );
  return rows.map((r) => ({ hour: Number(r.hour), reps: Number(r.reps) }));
}

/**
 * Store the frozen snapshot + mint a public token. Idempotent: one row per (summary_date, office_code)
 * — if a snapshot already exists (the cron already sent today), returns { rawToken: null } so the
 * caller skips the send. `expiresAt` defaults to as_of + 30 days.
 */
export async function storeDailySummarySnapshot(
  client: QueryClient,
  input: { date: string; office: string; asOf: Date; payload: DailySummaryPayload; expiresAt: Date },
): Promise<{ rawToken: string | null }> {
  const rawToken = generateRawSummaryToken();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.daily_summary_snapshots (summary_date, office_code, as_of, payload, token, expires_at)
     VALUES ($1::date, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (summary_date, office_code) DO NOTHING
     RETURNING id`,
    [input.date, input.office, input.asOf, JSON.stringify(input.payload), hashSummaryToken(rawToken), input.expiresAt],
  );
  return { rawToken: rows.length > 0 ? rawToken : null };
}

/**
 * Validate a public token and return the frozen payload (NOT a recompute). 404-class semantics:
 * returns null for missing/malformed/expired/revoked tokens so the route answers 404. Bumps access_count.
 */
export async function readDailySummaryByToken(client: QueryClient, rawToken: string): Promise<DailySummaryPayload | null> {
  if (typeof rawToken !== "string" || rawToken.length === 0) return null;
  const { rows } = await client.query<{ payload: DailySummaryPayload }>(
    `UPDATE public.daily_summary_snapshots
        SET access_count = access_count + 1, last_accessed_at = now()
      WHERE token = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING payload`,
    [hashSummaryToken(rawToken)],
  );
  return rows[0]?.payload ?? null;
}
