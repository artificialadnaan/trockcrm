import crypto from "crypto";
import { BUSINESS_TIMEZONE } from "../../lib/period.js";
import type { QueryClient } from "../usage/raw-fetch.js";
import { resolveReps, buildLiveDay, composeStageLabel } from "../usage/read-service.js";

// v1 scope: the daily summary covers office_dallas only (where the data lives). The table is keyed by
// (summary_date, office_code) so per-office summaries are a clean follow-up. Read the schema EXPLICITLY
// — never the connection's default search_path (the fan-out trap the rollup cron had).
export const DAILY_SUMMARY_OFFICE = "dallas";
export const DAILY_SUMMARY_SCHEMA = "office_dallas";
const SCHEMA_RE = /^office_[a-z0-9_]+$/;
const TOKEN_BYTES = 32;
const LEADERBOARD_LIMIT = 12;
const MAJOR_MOVES_LIMIT = 8;
export const AS_OF_LABEL = "as of 5:00 PM CT";

export interface BiggestMover {
  name: string;
  actions: number;
}
export interface LeaderRow {
  rank: number;
  name: string;
  actions: number;
}
export interface MajorMove {
  kind: "won" | "advanced";
  label: string; // composeStageLabel: "Deal: From → To"
}
export interface DailySummaryPayload {
  date: string; // YYYY-MM-DD (America/Chicago)
  office: string;
  asOfLabel: string; // "as of 5:00 PM CT"
  headline: {
    activeReps: number;
    totalReps: number;
    totalActions: number;
    biggestMover: BiggestMover | null; // null -> render "—", never $NaN/undefined
  };
  leaderboard: LeaderRow[];
  majorMoves: MajorMove[]; // empty -> "Quiet day — no major moves"
  teamHealth: { active: number; quiet: number; quietNames: string[] };
}

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
export function summarizeReps(perRep: { name: string; actions: number }[]): {
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
    leaderboard: sorted.slice(0, LEADERBOARD_LIMIT).map((r, i) => ({ rank: i + 1, name: r.name, actions: r.actions })),
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

  const perRep: { name: string; actions: number }[] = [];
  for (const rep of reps) {
    const usage = await buildLiveDay(client, schema, rep.id, date);
    perRep.push({ name: rep.displayName, actions: usage.actionCount });
  }
  const s = summarizeReps(perRep);
  const majorMoves = await readMajorMoves(client, schema, date);

  return {
    date,
    office: DAILY_SUMMARY_OFFICE,
    asOfLabel: AS_OF_LABEL,
    headline: { activeReps: s.activeReps, totalReps: reps.length, totalActions: s.totalActions, biggestMover: s.biggestMover },
    leaderboard: s.leaderboard,
    majorMoves,
    teamHealth: { active: s.activeReps, quiet: s.quietNames.length, quietNames: s.quietNames },
  };
}

/** Today's notable stage transitions (Won first), resolved to "Deal: From → To" via pipeline_stage_config. */
async function readMajorMoves(client: QueryClient, schema: string, date: string): Promise<MajorMove[]> {
  const { rows } = await client.query<{ deal_name: string | null; from_stage: string | null; to_stage: string | null }>(
    `SELECT d.name AS deal_name, fs.name AS from_stage, ts.name AS to_stage
       FROM ${schema}.deal_stage_history sh
       LEFT JOIN ${schema}.deals d ON sh.deal_id = d.id
       LEFT JOIN public.pipeline_stage_config fs ON sh.from_stage_id = fs.id
       LEFT JOIN public.pipeline_stage_config ts ON sh.to_stage_id = ts.id
      WHERE sh.created_at >= ($1::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        AND sh.created_at < (($1::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
      ORDER BY (ts.name = 'Won') DESC, sh.created_at DESC
      LIMIT ${MAJOR_MOVES_LIMIT}`,
    [date],
  );
  return rows.map((r) => ({
    kind: r.to_stage === "Won" ? "won" : "advanced",
    label: composeStageLabel(r.deal_name, r.from_stage, r.to_stage),
  }));
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
