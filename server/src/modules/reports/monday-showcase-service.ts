// Reports Part 2 -- the Monday-showcase SOURCE OF TRUTH. Many presentations (8 variants: 3 Report A +
// 4 Report B + the split-out exec hero tile) render slices of the SINGLE payload this service builds, so
// no two variants can disagree on a number. Every canonical figure is computed ONCE here and every
// variant-facing field references that one value -- cross-variant reconciliation then holds by
// construction (and is locked by monday-showcase-reconciliation.test.ts).
//
// Discipline (composes the F1-F5 foundations, never re-derives):
//   WON       -> getWonCloseSummary / getCanonicalRepWonSummary (won_closed_date; ties to 191/$9.78M)
//   SENT/EST  -> deal_stage_history stage-entry cohorts on created_at, F5 COUNT(DISTINCT deal)
//   PROJECTED -> expected_close_date ALONE (F2) + the mandatory N/M coverage caption
//   value $   -> F3 basis discipline (Won = awarded-first; open = best-estimate), never summed
//   weeks     -> F1 getWtdPeriod / sundayWeekBucketSql; F4 excludes the 2026-05-17 backfill spike

import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import {
  getWonCloseSummary,
  getCanonicalRepWonSummary,
} from "../dashboard/service.js";
import {
  aliasedReportableDealFilterSql,
  aliasedEffectiveWonDealValueSql,
  aliasedActiveDealCountFilterSql,
  aliasedWonHsClosedWonDateSql,
} from "../shared/deal-value-sql.js";
import { aliasedHasUsableWonDateSql } from "../deals/service.js";
import { WON_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";
import {
  getWtdPeriod,
  sundayWeekBucketSql,
  BUSINESS_TIMEZONE,
  type WeekMode,
} from "../../lib/period.js";
import {
  projectionBandSql,
  futureDatedCloseDatePredicateSql,
  formatProjectionCoverageCaption,
  dealValueSqlForBasis,
  BACKFILL_SPIKE_WEEK_START,
  SENT_STAGE_SLUGS,
  ESTIMATED_STAGE_SLUGS,
  DEAL_VALUE_BASIS_LABEL,
  type ProjectionBand,
  type ProjectionCoverage,
} from "./foundations.js";

// Open (Sent/Estimated/Projected) $ -- the F3 best-estimate basis, on-hold-zeroed via the foundation.
const openValueSql = (alias: string) => dealValueSqlForBasis(alias, "open_best_estimate");

const { deals, pipelineStageConfig, dealStageHistory, leads, users } = schema;

type TenantDb = NodePgDatabase<typeof schema>;

// tenantDb.execute() returns a driver QueryResult ({ rows }) in prod and a bare array in some test
// doubles -- accept either (matches the rowsFromExecute<any>(...) idiom in the other tier services).
function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

// ===================== payload types (the contract the 8 variants render) =====================

export type DepartmentKey = "estimating" | "sent" | "won" | "collected";

/** A $ amount ALWAYS carries its F3 basis label so a variant can never render a bare, mislabeled $. */
export interface ValueWithBasis {
  amount: number;
  basisLabel: string;
}

export interface DepartmentMetric {
  key: DepartmentKey;
  label: string;
  /** null = deferred department (Collected) -- a placeholder, never a zero-filled real number. */
  count: number | null;
  value: ValueWithBasis | null;
  /** this-week minus last-completed-week count; null when not applicable (deferred). */
  deltaCountWoW: number | null;
  /** 8 Sunday-anchored weekly counts (F4 spike week shown but flagged via weeklyTrend.spikeExcluded). */
  sparkline: number[];
  deferred: boolean;
}

export interface ProjectionBandCell {
  band: ProjectionBand;
  count: number;
  value: number;
}

export interface ProjectionLadder {
  bands: ProjectionBandCell[];
  coverage: ProjectionCoverage;
  coverageCaption: string;
}

export interface LeadStatusCell {
  stageLabel: string;
  count: number;
}

export interface RepShowcaseRow {
  repId: string | null;
  repName: string;
  closed: { count: number; value: ValueWithBasis };
  projection: ProjectionLadder;
  sentThisWeek: { count: number; value: ValueWithBasis };
  leadStatus: LeadStatusCell[];
}

export interface ExecHeroMetric {
  count: number;
  value: ValueWithBasis;
}

export interface ExecHero {
  won: ExecHeroMetric;
  sent: ExecHeroMetric;
  estimated: ExecHeroMetric;
}

export interface ShowcaseWeek {
  weekStart: string;
  estimating: number;
  sent: number;
  won: number;
  spikeExcluded: boolean;
}

export interface ShowcasePeriod {
  from: string;
  to: string;
  mode: WeekMode;
  label: string;
}

export interface MondayShowcaseData {
  period: ShowcasePeriod;
  departments: DepartmentMetric[];
  execHero: ExecHero;
  reps: RepShowcaseRow[];
  officeProjection: ProjectionLadder;
  weeklyTrend: ShowcaseWeek[];
  valueBases: Record<"won_awarded_first" | "open_best_estimate", string>;
  notes: string[];
}

// ===================== assembly inputs (raw, query-produced) =====================

export interface CohortTotals {
  count: number;
  value: number;
  byRep: Map<string | null, { count: number; value: number }>;
}

export interface RepProjection {
  bands: ProjectionBandCell[];
  coverage: ProjectionCoverage;
}

export interface AssembleInput {
  period: ShowcasePeriod;
  /** office Won for the period -- getWonCloseSummary (the protected aggregate). */
  won: { count: number; value: number };
  /** per-rep Won -- getCanonicalRepWonSummary; sums to `won` BY CONSTRUCTION. */
  repWon: { repId: string | null; count: number; value: number }[];
  sent: CohortTotals;
  estimated: CohortTotals;
  /** office-wide projection (bands + N/M). per-rep coverage MUST sum to this. */
  officeProjection: RepProjection;
  repProjection: Map<string | null, RepProjection>;
  leadStatus: Map<string | null, LeadStatusCell[]>;
  weeklyTrend: ShowcaseWeek[];
  /** 8-week sparkline counts per department key (estimating/sent/won). */
  sparklines: Record<"estimating" | "sent" | "won", number[]>;
  /** last-completed-week counts per department, for the WoW delta chip. */
  lastWeek: Record<"estimating" | "sent" | "won", number>;
  repNames: Map<string | null, string>;
}

const WON_BASIS_LABEL = DEAL_VALUE_BASIS_LABEL.won_awarded_first;
const OPEN_BASIS_LABEL = DEAL_VALUE_BASIS_LABEL.open_best_estimate;

const DEPARTMENT_NOTES = [
  "Estimated/Sent are stage-entry cohorts on deal_stage_history (a proxy; Estimated is weak -- no dedicated event date).",
  "Won is a close-date cohort (won_closed_date), a DIFFERENT cohort from the stage-entry ones -- the funnel chevrons are same-week throughput, not one deal-set flowing.",
  "Collected is deferred (no finance source yet) -- shown as a placeholder, never zero-filled.",
  "Won $ uses the awarded-first basis; open (Sent/Estimated/Projected) $ uses best-estimate -- different bases, never summed.",
];

function emptyLadder(): ProjectionLadder {
  const bands = projectionBandKeys().map((band) => ({ band, count: 0, value: 0 }));
  return { bands, coverage: { n: 0, m: 0 }, coverageCaption: formatProjectionCoverageCaption({ n: 0, m: 0 }) };
}

export function projectionBandKeys(): ProjectionBand[] {
  return ["0_30", "31_60", "61_90", "beyond_90"];
}

function ladderFrom(projection: RepProjection): ProjectionLadder {
  return {
    bands: projection.bands,
    coverage: projection.coverage,
    coverageCaption: formatProjectionCoverageCaption(projection.coverage),
  };
}

/**
 * Pure assembly: fold the raw canonical figures into the single payload every variant renders. Each
 * number is referenced from ONE source here (Won from `won`, per-rep Won from `repWon`, etc.), so the
 * exec hero, the department scoreboard, the funnel and the per-rep rows can never disagree.
 */
export function assembleMondayShowcase(input: AssembleInput): MondayShowcaseData {
  const wonValue: ValueWithBasis = { amount: input.won.value, basisLabel: WON_BASIS_LABEL };
  const sentValue: ValueWithBasis = { amount: input.sent.value, basisLabel: OPEN_BASIS_LABEL };
  const estimatedValue: ValueWithBasis = { amount: input.estimated.value, basisLabel: OPEN_BASIS_LABEL };

  const departments: DepartmentMetric[] = [
    {
      key: "estimating",
      label: "Estimating",
      count: input.estimated.count,
      value: estimatedValue,
      deltaCountWoW: input.estimated.count - input.lastWeek.estimating,
      sparkline: input.sparklines.estimating,
      deferred: false,
    },
    {
      key: "sent",
      label: "Sent",
      count: input.sent.count,
      value: sentValue,
      deltaCountWoW: input.sent.count - input.lastWeek.sent,
      sparkline: input.sparklines.sent,
      deferred: false,
    },
    {
      key: "won",
      label: "Won",
      count: input.won.count,
      value: wonValue,
      deltaCountWoW: input.won.count - input.lastWeek.won,
      sparkline: input.sparklines.won,
      deferred: false,
    },
    {
      key: "collected",
      label: "Collected",
      count: null,
      value: null,
      deltaCountWoW: null,
      sparkline: [],
      deferred: true,
    },
  ];

  const execHero: ExecHero = {
    won: { count: input.won.count, value: wonValue },
    sent: { count: input.sent.count, value: sentValue },
    estimated: { count: input.estimated.count, value: estimatedValue },
  };

  // Seed the rep rows from the UNION of all per-rep activity (won ∪ sent ∪ projection ∪ lead-status) --
  // NOT just wins -- so an active rep with zero wins this period still appears in B1/B3/B4 and B2's
  // totals (sent / projected / active leads) reconcile to the office totals. Closed defaults to 0.
  const repWonById = new Map(input.repWon.map((rw) => [rw.repId, rw]));
  const activeRepIds = new Set<string | null>([
    ...input.repWon.map((rw) => rw.repId),
    ...input.sent.byRep.keys(),
    ...input.repProjection.keys(),
    ...input.leadStatus.keys(),
  ]);
  const reps: RepShowcaseRow[] = [...activeRepIds]
    .map((repId): RepShowcaseRow => {
      const rw = repWonById.get(repId);
      const repProj = input.repProjection.get(repId);
      const repSent = input.sent.byRep.get(repId) ?? { count: 0, value: 0 };
      return {
        repId,
        repName: input.repNames.get(repId) ?? (repId ? "Unknown rep" : "Unassigned"),
        closed: { count: rw?.count ?? 0, value: { amount: rw?.value ?? 0, basisLabel: WON_BASIS_LABEL } },
        projection: repProj ? ladderFrom(repProj) : emptyLadder(),
        sentThisWeek: { count: repSent.count, value: { amount: repSent.value, basisLabel: OPEN_BASIS_LABEL } },
        leadStatus: input.leadStatus.get(repId) ?? [],
      };
    })
    .sort((a, b) => b.closed.value.amount - a.closed.value.amount);

  return {
    period: input.period,
    departments,
    execHero,
    reps,
    officeProjection: ladderFrom(input.officeProjection),
    weeklyTrend: input.weeklyTrend,
    valueBases: { won_awarded_first: WON_BASIS_LABEL, open_best_estimate: OPEN_BASIS_LABEL },
    notes: DEPARTMENT_NOTES,
  };
}

// ===================== SQL builders (compose F1-F5; SQL-shape tested, no DB) =====================

function slugInList(slugs: readonly string[]): SQL {
  return sql.join(slugs.map((s) => sql`${s}`), sql`, `);
}

/** CT-anchored created_at-in-[from,to] predicate for a deal_stage_history alias (F1 business tz). */
function ctDateInWindowSql(tsExpr: string, from: string, to: string): SQL {
  return sql.raw(
    `((${tsExpr}) AT TIME ZONE '${BUSINESS_TIMEZONE}')::date >= '${from}'::date AND ` +
      `((${tsExpr}) AT TIME ZONE '${BUSINESS_TIMEZONE}')::date <= '${to}'::date`
  );
}

/**
 * Stage-entry cohort (Sent / Estimated this week), per rep. F5: counts DISTINCT deals (the inner
 * DISTINCT collapses a deal that re-entered the stage in the window). $ uses the F3 open best-estimate
 * basis over those distinct deals.
 */
export function buildStageEntryCohortSql(slugs: readonly string[], from: string, to: string): SQL {
  return sql`
    SELECT d.assigned_rep_id AS rep_id,
           COUNT(*)::int AS cnt,
           COALESCE(SUM(${openValueSql("d")}), 0)::numeric AS val
    FROM ${deals} d
    JOIN (
      SELECT DISTINCT dsh.deal_id
      FROM ${dealStageHistory} dsh
      JOIN ${pipelineStageConfig} psc ON psc.id = dsh.to_stage_id
      WHERE psc.slug IN (${slugInList(slugs)})
        AND ${ctDateInWindowSql("dsh.created_at", from, to)}
    ) entered ON entered.deal_id = d.id
    WHERE COALESCE(d.is_test_data, false) = false
      AND ${aliasedReportableDealFilterSql("d")}
    GROUP BY d.assigned_rep_id
  `;
}

/** Per-rep projection bands (F2): open, future-dated deals bucketed 30/60/90, best-estimate $. */
export function buildProjectionBandsSql(): SQL {
  return sql`
    SELECT d.assigned_rep_id AS rep_id,
           ${projectionBandSql("d.expected_close_date")} AS band,
           COUNT(*)::int AS cnt,
           COALESCE(SUM(${openValueSql("d")}), 0)::numeric AS val
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    WHERE COALESCE(d.is_test_data, false) = false
      AND ${aliasedReportableDealFilterSql("d")}
      AND d.is_active = true
      AND psc.is_terminal = false
      AND ${futureDatedCloseDatePredicateSql("d.expected_close_date")}
    GROUP BY d.assigned_rep_id, ${projectionBandSql("d.expected_close_date")}
  `;
}

/** Per-rep N/M coverage (F2): N = future-dated open deals, M = ALL open deals (incl. NULL-dated). */
export function buildProjectionCoverageSql(): SQL {
  return sql`
    SELECT d.assigned_rep_id AS rep_id,
           COUNT(*) FILTER (WHERE ${futureDatedCloseDatePredicateSql("d.expected_close_date")})::int AS n,
           COUNT(*)::int AS m
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    WHERE COALESCE(d.is_test_data, false) = false
      AND ${aliasedReportableDealFilterSql("d")}
      AND d.is_active = true
      AND psc.is_terminal = false
    GROUP BY d.assigned_rep_id
  `;
}

/**
 * Active (open) leads grouped by lead stage, per rep -- current-state, no date bucket. Mirrors the
 * canonical active-lead query's scope (is_active, open, lead workflow family, non-terminal) and excludes
 * test data, so the Report B badges count the SAME leads as the rest of the reporting surfaces.
 */
export function buildLeadStatusSql(): SQL {
  return sql`
    SELECT l.assigned_rep_id AS rep_id, psc.name AS stage_label, COUNT(*)::int AS cnt
    FROM ${leads} l
    JOIN ${pipelineStageConfig} psc ON psc.id = l.stage_id
    WHERE l.is_active = true
      AND l.status = 'open'
      AND COALESCE(l.is_test_data, false) = false
      AND psc.workflow_family = 'lead'
      AND psc.is_terminal = false
    GROUP BY l.assigned_rep_id, psc.name
  `;
}

/** 8-week Sunday-anchored trend of Est/Sent stage entries (F1 bucket; F5 distinct deal). */
export function buildWeeklyCohortTrendSql(fromWeekStart: string, toDate: string): SQL {
  const weekStart = sundayWeekBucketSql("dsh.created_at");
  return sql`
    SELECT ${weekStart} AS week_start,
           COUNT(DISTINCT dsh.deal_id) FILTER (WHERE psc.slug IN (${slugInList(ESTIMATED_STAGE_SLUGS)}))::int AS estimating,
           COUNT(DISTINCT dsh.deal_id) FILTER (WHERE psc.slug IN (${slugInList(SENT_STAGE_SLUGS)}))::int AS sent
    FROM ${dealStageHistory} dsh
    JOIN ${pipelineStageConfig} psc ON psc.id = dsh.to_stage_id
    JOIN ${deals} d ON d.id = dsh.deal_id
    WHERE COALESCE(d.is_test_data, false) = false
      AND ${aliasedReportableDealFilterSql("d")}
      AND ${ctDateInWindowSql("dsh.created_at", fromWeekStart, toDate)}
    GROUP BY ${weekStart}
    ORDER BY ${weekStart}
  `;
}

// ===================== orchestrator =====================

export interface MondayShowcaseOptions {
  mode?: WeekMode;
  now?: Date;
}

function shiftIsoDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The 8 Sunday week-start dates ending at (and including) `sundayFrom` -- i.e. [from-49d .. from-7d,
 * from]. Used to zero-fill the trend so weeklyTrend always has exactly 8 buckets with the current week
 * last, even when a quiet week produced no stage-history rows.
 */
export function eightWeekStartsEndingAt(sundayFrom: string): string[] {
  return Array.from({ length: 8 }, (_, i) => shiftIsoDays(sundayFrom, -7 * (7 - i)));
}

function emptyRepProjection(): RepProjection {
  return { bands: projectionBandKeys().map((band) => ({ band, count: 0, value: 0 })), coverage: { n: 0, m: 0 } };
}

/**
 * Build the full Monday-showcase payload for the office. Computes each canonical figure ONCE (Won via
 * the protected aggregate, Sent/Estimated via stage-entry cohorts, Projection via F2) and hands them to
 * assembleMondayShowcase, so every variant reconciles by construction.
 */
export async function getMondayShowcaseData(
  tenantDb: TenantDb,
  options: MondayShowcaseOptions = {}
): Promise<MondayShowcaseData> {
  const mode: WeekMode = options.mode ?? "to_date";
  const now = options.now ?? new Date();
  const { from, to } = getWtdPeriod(mode, now);
  const period: ShowcasePeriod = { from, to, mode, label: `${from} → ${to}` };

  // last completed week (for the WoW delta chip)
  const lastWeekFrom = shiftIsoDays(from, -7);
  const lastWeekTo = shiftIsoDays(from, -1);
  // 8-week trend window: 7 prior weeks + the current one
  const trendFrom = shiftIsoDays(from, -7 * 7);

  const [wonSummary, repWonRows, lastWonSummary, sentRows, estimatedRows, lastSentRows, lastEstRows, projBandRows, projCovRows, leadRows, trendRows, repNameRows] =
    await Promise.all([
      getWonCloseSummary(tenantDb, { from, to }),
      getCanonicalRepWonSummary(tenantDb, { from, to }),
      getWonCloseSummary(tenantDb, { from: lastWeekFrom, to: lastWeekTo }),
      tenantDb.execute(buildStageEntryCohortSql(SENT_STAGE_SLUGS, from, to)),
      tenantDb.execute(buildStageEntryCohortSql(ESTIMATED_STAGE_SLUGS, from, to)),
      tenantDb.execute(buildStageEntryCohortSql(SENT_STAGE_SLUGS, lastWeekFrom, lastWeekTo)),
      tenantDb.execute(buildStageEntryCohortSql(ESTIMATED_STAGE_SLUGS, lastWeekFrom, lastWeekTo)),
      tenantDb.execute(buildProjectionBandsSql()),
      tenantDb.execute(buildProjectionCoverageSql()),
      tenantDb.execute(buildLeadStatusSql()),
      tenantDb.execute(buildWeeklyCohortTrendSql(trendFrom, to)),
      tenantDb.execute(
        sql`SELECT ${users.id} AS id, ${users.displayName} AS name FROM ${users}`
      ),
    ]);
  const won = { count: wonSummary.count, value: wonSummary.totalValue };

  const repNames = new Map<string | null, string>(
    rowsFromExecute<{ id: string; name: string }>(repNameRows).map((r) => [r.id, r.name])
  );

  const toCohort = (rows: unknown): CohortTotals => {
    const byRep = new Map<string | null, { count: number; value: number }>();
    let count = 0;
    let value = 0;
    for (const r of rowsFromExecute<{ rep_id: string | null; cnt: unknown; val: unknown }>(rows)) {
      const c = num(r.cnt);
      const v = num(r.val);
      byRep.set(r.rep_id, { count: c, value: v });
      count += c;
      value += v;
    }
    return { count, value, byRep };
  };

  const sent = toCohort(sentRows);
  const estimated = toCohort(estimatedRows);
  const lastSent = toCohort(lastSentRows);
  const lastEst = toCohort(lastEstRows);

  // Projection: fold band + coverage rows into per-rep ladders; office = SUM of per-rep (so office N/M
  // and bands equal the rep splits by construction).
  const repProjection = new Map<string | null, RepProjection>();
  const ensureRep = (repId: string | null): RepProjection => {
    let p = repProjection.get(repId);
    if (!p) {
      p = emptyRepProjection();
      repProjection.set(repId, p);
    }
    return p;
  };
  for (const r of rowsFromExecute<{ rep_id: string | null; band: ProjectionBand | null; cnt: unknown; val: unknown }>(projBandRows)) {
    if (!r.band) continue;
    const cell = ensureRep(r.rep_id).bands.find((b) => b.band === r.band);
    if (cell) {
      cell.count += num(r.cnt);
      cell.value += num(r.val);
    }
  }
  for (const r of rowsFromExecute<{ rep_id: string | null; n: unknown; m: unknown }>(projCovRows)) {
    ensureRep(r.rep_id).coverage = { n: num(r.n), m: num(r.m) };
  }
  const officeProjection: RepProjection = emptyRepProjection();
  for (const p of repProjection.values()) {
    officeProjection.coverage.n += p.coverage.n;
    officeProjection.coverage.m += p.coverage.m;
    for (const cell of p.bands) {
      const officeCell = officeProjection.bands.find((b) => b.band === cell.band)!;
      officeCell.count += cell.count;
      officeCell.value += cell.value;
    }
  }

  const leadStatus = new Map<string | null, LeadStatusCell[]>();
  for (const r of rowsFromExecute<{ rep_id: string | null; stage_label: string; cnt: unknown }>(leadRows)) {
    const list = leadStatus.get(r.rep_id) ?? [];
    list.push({ stageLabel: r.stage_label, count: num(r.cnt) });
    leadStatus.set(r.rep_id, list);
  }

  // 8-week trend. Generate EVERY Sunday-Saturday week in the window (zero-filled) so weeklyTrend always
  // has exactly 8 buckets ending at the current week -- a quiet week must read as 0, not be omitted (else
  // the "current week" bar would point at the last non-empty week). F4: the 2026-05-17 backfill spike
  // week is flagged-but-shown so downstream averages exclude it.
  const trendByWeek = new Map<string, { estimating: number; sent: number }>();
  for (const r of rowsFromExecute<{ week_start: string; estimating: unknown; sent: unknown }>(trendRows)) {
    trendByWeek.set(String(r.week_start).slice(0, 10), { estimating: num(r.estimating), sent: num(r.sent) });
  }
  // 8 Sunday week-starts ending at `from` (this period's Sunday): [from-49 .. from-7, from].
  const weekStarts = eightWeekStartsEndingAt(from);
  const weeklyTrend: ShowcaseWeek[] = [];
  for (const weekStart of weekStarts) {
    const cohort = trendByWeek.get(weekStart) ?? { estimating: 0, sent: 0 };
    // Cap the week's Won bucket at the period's `to` so the CURRENT (in-progress) week's Won bar uses the
    // exact same {from, to} as the exec-hero/department Won -- otherwise a Won deal later in this Sun-Sat
    // week would show in the A3 "this week" bar but not the headline, breaking reconciliation. (Past
    // weeks: weekEnd <= to, so unchanged.)
    const weekEnd = shiftIsoDays(weekStart, 6);
    const cappedEnd = weekEnd < to ? weekEnd : to;
    const wonWeek = await getWonCloseSummary(tenantDb, { from: weekStart, to: cappedEnd });
    weeklyTrend.push({
      weekStart,
      estimating: cohort.estimating,
      sent: cohort.sent,
      won: wonWeek.count,
      spikeExcluded: weekStart === BACKFILL_SPIKE_WEEK_START,
    });
  }
  const sparklines = {
    estimating: weeklyTrend.map((w) => w.estimating),
    sent: weeklyTrend.map((w) => w.sent),
    won: weeklyTrend.map((w) => w.won),
  };

  return assembleMondayShowcase({
    period,
    won,
    repWon: repWonRows.map((r) => ({ repId: r.repId, count: r.winsCount, value: r.closedValue })),
    sent,
    estimated,
    officeProjection,
    repProjection,
    leadStatus,
    weeklyTrend,
    sparklines,
    lastWeek: { estimating: lastEst.count, sent: lastSent.count, won: lastWonSummary.count },
    repNames,
  });
}

// ===================== DRILL-TO-EVIDENCE (Reports Part 3) =====================
// Every showcase NUMBER is clickable -> the supporting deal/lead RECORDS. The records behind a number
// must be EXACTLY the set that number aggregates, so the evidence reconciles to the claim. Each builder
// below is a row-select over the SAME canonical cohort predicate as its aggregate (Won close-date cohort,
// Sent/Estimated stage-entry cohort, Projection bands, active leads) and returns, PER ROW, the same value
// the aggregate summed (same F3 basis SQL) -- so SUM(rows.value) === the number and COUNT(rows) === the
// count, by construction. Locked by monday-showcase-evidence-sql.test.ts (predicate identity) and
// monday-showcase-evidence-reconciliation.runtime.test.ts (real-SQL: evidence === aggregate).

export type EvidenceMetric = "won" | "sent" | "estimated" | "projection" | "leads";

/** A single supporting record (a deal, or a lead for the `leads` metric). */
export interface EvidenceRecord {
  id: string;
  /** deal number (null for leads). */
  dealNumber: string | null;
  name: string;
  repId: string | null;
  repName: string;
  /** the record's current pipeline/lead stage. */
  stageLabel: string;
  /** this record's contribution to the number, in the metric's F3 basis (null for leads -- no $). */
  value: number | null;
  /** the canonical date this record sits on for THIS metric's cohort (close date / entry date / etc). */
  cohortDate: string | null;
}

export interface EvidenceTotal {
  count: number;
  /** null for leads (no value basis). Equals the showcase number this evidence backs. */
  value: number | null;
  basisLabel: string | null;
}

export type EvidenceScope =
  | { kind: "office" }
  | { kind: "rep"; repId: string | null; repName: string };

export interface MondayShowcaseEvidence {
  metric: EvidenceMetric;
  metricLabel: string;
  /** what date axis the records are shown on (honest, per-metric -- never a bare list). */
  dateAxisLabel: string;
  period: ShowcasePeriod;
  scope: EvidenceScope;
  band: ProjectionBand | null;
  leadStage: string | null;
  total: EvidenceTotal;
  records: EvidenceRecord[];
}

/**
 * Optional per-rep narrowing for an evidence query. `undefined` = office-wide (no rep predicate, so it
 * reconciles to the office number); `null` = the Unassigned bucket (IS NULL); a string = that rep's UUID.
 * Mirrors how the per-rep aggregates are a GROUP BY slice of the office aggregate.
 */
function repScopeSql(alias: string, repId?: string | null): SQL {
  if (repId === undefined) return sql``;
  if (repId === null) return sql` AND ${sql.raw(alias)}.assigned_rep_id IS NULL`;
  return sql` AND ${sql.raw(alias)}.assigned_rep_id = ${repId}::uuid`;
}

/** Shared deal-row projection for evidence: same columns the FilterBar list shows, plus the cohort $/date. */
function dealEvidenceSelectSql(valueSql: SQL, cohortDateExpr: string): SQL {
  return sql`
    d.id AS id,
    d.deal_number AS deal_number,
    d.name AS name,
    d.assigned_rep_id AS rep_id,
    COALESCE(u.display_name, '') AS rep_name,
    COALESCE(psc.name, '') AS stage_label,
    COALESCE(${valueSql}, 0)::numeric AS value,
    (${sql.raw(cohortDateExpr)})::date AS cohort_date
  `;
}

/**
 * Won evidence: the deal rows behind the Won count/$ -- byte-identical predicate to getWonCloseSummary
 * (close-date cohort on won_closed_date, Won stages, usable-won-date guard, reportable + test filters)
 * and the SAME awarded-first $ basis, so COUNT(rows) === Won count and SUM(value) === Won $.
 */
export function buildWonEvidenceSql(from: string, to: string, repId?: string | null): SQL {
  return sql`
    SELECT ${dealEvidenceSelectSql(aliasedEffectiveWonDealValueSql("d"), "d.won_closed_date")}
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    LEFT JOIN ${users} u ON u.id = d.assigned_rep_id
    WHERE COALESCE(d.is_test_data, false) = false
      AND ${aliasedActiveDealCountFilterSql("d")}
      AND psc.slug IN (${slugInList(WON_STAGE_SLUGS)})
      AND ${aliasedHasUsableWonDateSql("d")}
      AND ${aliasedWonHsClosedWonDateSql("d")} >= ${from}::date
      AND ${aliasedWonHsClosedWonDateSql("d")} <= ${to}::date${repScopeSql("d", repId)}
    ORDER BY value DESC, d.name
  `;
}

/**
 * Sent/Estimated evidence: the DISTINCT deals that entered a sent/estimating stage in the CT window --
 * same stage-entry cohort and same open best-estimate $ as buildStageEntryCohortSql. The inner GROUP BY
 * deal_id yields exactly one row per distinct deal (the same set the aggregate's inner DISTINCT counts),
 * and carries the earliest entry date in-window as the cohort date.
 */
export function buildStageEntryEvidenceSql(
  slugs: readonly string[],
  from: string,
  to: string,
  repId?: string | null
): SQL {
  return sql`
    SELECT ${dealEvidenceSelectSql(openValueSql("d"), "entered.entered_at")}
    FROM ${deals} d
    JOIN (
      SELECT dsh.deal_id, MIN(dsh.created_at) AS entered_at
      FROM ${dealStageHistory} dsh
      JOIN ${pipelineStageConfig} psc2 ON psc2.id = dsh.to_stage_id
      WHERE psc2.slug IN (${slugInList(slugs)})
        AND ${ctDateInWindowSql("dsh.created_at", from, to)}
      GROUP BY dsh.deal_id
    ) entered ON entered.deal_id = d.id
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    LEFT JOIN ${users} u ON u.id = d.assigned_rep_id
    WHERE COALESCE(d.is_test_data, false) = false
      AND ${aliasedReportableDealFilterSql("d")}${repScopeSql("d", repId)}
    ORDER BY value DESC, d.name
  `;
}

/**
 * Projection evidence: open, future-dated, non-terminal, active deals -- same predicate as
 * buildProjectionBandsSql -- optionally narrowed to one 30/60/90 rung via the SAME band CASE, so the
 * per-band rows reconcile to that rung's count/$.
 */
export function buildProjectionEvidenceSql(repId?: string | null, band?: ProjectionBand): SQL {
  const bandFilter = band
    ? sql` AND ${projectionBandSql("d.expected_close_date")} = ${band}`
    : sql``;
  return sql`
    SELECT ${dealEvidenceSelectSql(openValueSql("d"), "d.expected_close_date")}
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    LEFT JOIN ${users} u ON u.id = d.assigned_rep_id
    WHERE COALESCE(d.is_test_data, false) = false
      AND ${aliasedReportableDealFilterSql("d")}
      AND d.is_active = true
      AND psc.is_terminal = false
      AND ${futureDatedCloseDatePredicateSql("d.expected_close_date")}${repScopeSql("d", repId)}${bandFilter}
    ORDER BY d.expected_close_date, value DESC
  `;
}

/**
 * Lead evidence: active (open) lead rows -- same scope as buildLeadStatusSql -- optionally narrowed to one
 * lead stage. Leads carry no deal value (value column is NULL); the cohort date is the lead's created_at.
 */
export function buildLeadEvidenceSql(repId?: string | null, leadStage?: string): SQL {
  const stageFilter = leadStage ? sql` AND psc.name = ${leadStage}` : sql``;
  return sql`
    SELECT l.id AS id,
           NULL AS deal_number,
           l.name AS name,
           l.assigned_rep_id AS rep_id,
           COALESCE(u.display_name, '') AS rep_name,
           COALESCE(psc.name, '') AS stage_label,
           NULL::numeric AS value,
           l.created_at::date AS cohort_date
    FROM ${leads} l
    JOIN ${pipelineStageConfig} psc ON psc.id = l.stage_id
    LEFT JOIN ${users} u ON u.id = l.assigned_rep_id
    WHERE l.is_active = true
      AND l.status = 'open'
      AND COALESCE(l.is_test_data, false) = false
      AND psc.workflow_family = 'lead'
      AND psc.is_terminal = false${repScopeSql("l", repId)}${stageFilter}
    ORDER BY l.created_at DESC
  `;
}

const EVIDENCE_METRIC_LABEL: Record<EvidenceMetric, string> = {
  won: "Won",
  sent: "Sent",
  estimated: "Estimating",
  projection: "Projected (open)",
  leads: "Active leads",
};

const EVIDENCE_DATE_AXIS_LABEL: Record<EvidenceMetric, string> = {
  won: "Won close date",
  sent: "Entered the sent stage",
  estimated: "Entered the estimating stage",
  projection: "Expected close date",
  leads: "Lead created",
};

export interface MondayShowcaseEvidenceOptions {
  metric: EvidenceMetric;
  mode?: WeekMode;
  now?: Date;
  /** undefined = office-wide; null = Unassigned bucket; string = a rep UUID. */
  repId?: string | null;
  /** projection only -- one 30/60/90 rung. */
  band?: ProjectionBand;
  /** leads only -- one lead stage label. */
  leadStage?: string;
}

interface EvidenceRow {
  id: string;
  deal_number: string | null;
  name: string;
  rep_id: string | null;
  rep_name: string;
  stage_label: string;
  value: unknown;
  cohort_date: unknown;
}

/**
 * Build the evidence for one showcase number: the supporting records + a total that EQUALS the number.
 * Computes each canonical figure the same way the showcase service does (same predicate, same $ basis),
 * so the drawer's total reconciles to the clicked figure by construction.
 */
export async function getMondayShowcaseEvidence(
  tenantDb: TenantDb,
  options: MondayShowcaseEvidenceOptions
): Promise<MondayShowcaseEvidence> {
  const mode: WeekMode = options.mode ?? "to_date";
  const now = options.now ?? new Date();
  const { from, to } = getWtdPeriod(mode, now);
  const period: ShowcasePeriod = { from, to, mode, label: `${from} → ${to}` };
  const { metric, repId, band, leadStage } = options;

  let query: SQL;
  switch (metric) {
    case "won":
      query = buildWonEvidenceSql(from, to, repId);
      break;
    case "sent":
      query = buildStageEntryEvidenceSql(SENT_STAGE_SLUGS, from, to, repId);
      break;
    case "estimated":
      query = buildStageEntryEvidenceSql(ESTIMATED_STAGE_SLUGS, from, to, repId);
      break;
    case "projection":
      query = buildProjectionEvidenceSql(repId, band);
      break;
    case "leads":
      query = buildLeadEvidenceSql(repId, leadStage);
      break;
    default: {
      const exhaustive: never = metric;
      throw new Error(`unknown evidence metric: ${String(exhaustive)}`);
    }
  }

  const rows = rowsFromExecute<EvidenceRow>(await tenantDb.execute(query));
  const hasValue = metric !== "leads";
  const records: EvidenceRecord[] = rows.map((r) => ({
    id: String(r.id),
    dealNumber: r.deal_number == null ? null : String(r.deal_number),
    name: r.name,
    repId: r.rep_id == null ? null : String(r.rep_id),
    repName: r.rep_name || (r.rep_id ? "Unknown rep" : "Unassigned"),
    stageLabel: r.stage_label,
    value: hasValue ? num(r.value) : null,
    cohortDate: r.cohort_date == null ? null : String(r.cohort_date).slice(0, 10),
  }));

  const total: EvidenceTotal = {
    count: records.length,
    value: hasValue ? records.reduce((s, rec) => s + (rec.value ?? 0), 0) : null,
    basisLabel: metric === "won" ? WON_BASIS_LABEL : hasValue ? OPEN_BASIS_LABEL : null,
  };

  let scope: EvidenceScope;
  if (repId === undefined) {
    scope = { kind: "office" };
  } else {
    const repName =
      records.find((rec) => rec.repId === (repId ?? null))?.repName ??
      (await resolveRepName(tenantDb, repId));
    scope = { kind: "rep", repId: repId ?? null, repName };
  }

  return {
    metric,
    metricLabel: EVIDENCE_METRIC_LABEL[metric],
    dateAxisLabel: EVIDENCE_DATE_AXIS_LABEL[metric],
    period,
    scope,
    band: band ?? null,
    leadStage: leadStage ?? null,
    total,
    records,
  };
}

/** Resolve a rep's display name for the scope header when the drill returned no rows. */
async function resolveRepName(tenantDb: TenantDb, repId: string | null): Promise<string> {
  if (repId == null) return "Unassigned";
  const rows = rowsFromExecute<{ name: string }>(
    await tenantDb.execute(sql`SELECT ${users.displayName} AS name FROM ${users} WHERE ${users.id} = ${repId}::uuid`)
  );
  return rows[0]?.name ?? "Unknown rep";
}
