import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  CLOSE_TARGET_HOLD_HORIZON_DAYS,
  GENUINE_ESTIMATING_DEAL_STAGE_SLUGS,
  closeTargetFarOutSqlPredicate,
  holdHorizonDateSql,
} from "@trock-crm/shared/types";
import {
  aliasedDealBestEstimateSqlText,
  aliasedDealEstimatingValueSqlText,
} from "../server/src/modules/shared/deal-value-sql.js";
import { TERMINAL_STAGE_SLUGS } from "../server/src/modules/shared/pipeline-terminal-stages.js";
import {
  dateOnlyToUtcMidnightIso,
  resolveDealBidDueDate,
} from "../server/src/modules/deals/bid-due-date.js";
import { canonicalProjectNumberSql } from "../server/src/modules/bid-board-sync/project-number.js";
import { resolveScriptDatabaseUrl } from "./lib/resolve-database-url.js";

/**
 * READ-ONLY census for the Bid Board due-date read-back (BID_BOARD_DUE_DATE_READBACK).
 *
 * Run this BEFORE flipping the flag. The flag turns on an ingest write-through that copies the Bid Board
 * export's Due Date onto `deals.bid_due_date` — and since 2026-07-27 that column is the auto-park HORIZON
 * for genuine estimating-stage deals ([[deal-hold-risk]] resolveHoldHorizonDay and its SQL twin
 * holdHorizonDateSql). A horizon more than CLOSE_TARGET_HOLD_HORIZON_DAYS (90) CT-days out makes a deal
 * effectively on hold, which ZEROES its value on cards, dashboards, at-risk counts and the worker rollups;
 * a nearer horizon UN-parks a deal a far-out close target had parked. So the first enabled sync moves
 * reported pipeline dollars in BOTH directions, on a schedule, with no human in between. This script is
 * how that number stops being a surprise.
 *
 * It answers, per office:
 *   (a) how many deals would receive a bid_due_date write at all, split null->date vs date->different-date
 *   (b) how many of those are in a GENUINE estimating stage (the only ones whose hold verdict can change)
 *   (c) would_park / would_unpark counts
 *   (d) the NET effective-value dollar delta those transitions imply
 *   (e) how many DEAL PAGES will show a different Bid Due Date (and how many of those because the read
 *       override starts firing over a masking lead value) — the "is this three deals or three hundred?"
 *       question the dollar figure cannot answer
 *   (f) the largest movers, with deal number, stage and old/new horizon date
 *
 * FIDELITY: the park/un-park verdicts are computed with the app's OWN shared SQL builders —
 * `closeTargetFarOutSqlPredicate` and `holdHorizonDateSql` from [[deal-reporting]] — and the value with
 * the same STAGE-AWARE chain the deals board and list use (aliasedStageAwareEffectiveDealValueSql): the
 * estimating chain, in which DD outranks bid, for a genuine estimating deal, and the default awarded-first
 * chain everywhere else. That distinction is not academic here — every mover this census reports is BY
 * DEFINITION a genuine estimating deal (only that stage reads the bid due date as its horizon), so the
 * default chain alone would quote a bid-first number for the entire population being approved. A
 * hand-rolled copy of any of these is how a census ends up disagreeing with what the app then does.
 *
 * READ-ONLY, enforced twice: the session runs inside `BEGIN; SET TRANSACTION READ ONLY;` (Postgres itself
 * rejects any write) and the run ends in ROLLBACK, and the arg parser REFUSES any write-shaped flag rather
 * than ignoring it — a `--commit` typed out of muscle memory from the backfill scripts must stop the run,
 * not run a census that quietly looks like it applied something.
 *
 * Usage — run from the repo root (build shared first: `npm run build --workspace=shared`):
 *   railway run --service=Postgres npx tsx scripts/census-bid-board-due-date-readback.ts
 *   railway run --service=Postgres npx tsx scripts/census-bid-board-due-date-readback.ts --office=dallas
 *   railway run --service=Postgres npx tsx scripts/census-bid-board-due-date-readback.ts --all --limit=25
 *   … --json     # machine-readable, for pasting into the PR / runbook
 */

const OFFICE_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Flags that would imply a write. Present so a mistyped backfill habit ABORTS instead of being ignored. */
const FORBIDDEN_WRITE_FLAGS = ["--commit", "--apply", "--write", "--execute", "--force"];

export interface CensusArgs {
  offices: string[] | "all";
  limit: number;
  json: boolean;
}

export function parseCensusArgs(argv = process.argv): CensusArgs {
  const args = argv.slice(2);

  const forbidden = args.find((arg) => FORBIDDEN_WRITE_FLAGS.includes(arg.split("=")[0]));
  if (forbidden) {
    throw new Error(
      `${forbidden} is not supported: this script is READ-ONLY (it runs in a READ ONLY transaction and rolls back). Adnaan runs every prod write by hand.`
    );
  }

  // Every argument must be CONSUMED by a known flag. A typo (`--offce=atlanta`) that is silently ignored
  // makes the script fall back to the default office and then report a confident number for the WRONG one
  // — the same failure class as the incomplete-run contract: this artifact gates a production write, so it
  // must never look authoritative when it isn't.
  const KNOWN_VALUE_FLAGS = ["office", "limit"] as const;
  const KNOWN_BOOLEAN_FLAGS = ["--all", "--json"] as const;
  const unrecognized = args.filter(
    (arg) =>
      !KNOWN_BOOLEAN_FLAGS.includes(arg as (typeof KNOWN_BOOLEAN_FLAGS)[number]) &&
      !KNOWN_VALUE_FLAGS.some((key) => arg.startsWith(`--${key}=`))
  );
  if (unrecognized.length > 0) {
    throw new Error(
      `Unrecognized argument(s): ${unrecognized.join(", ")}. ` +
        `Supported: --office=<slug[,slug]> | --all | --limit=<n> | --json. ` +
        `(Refusing to run rather than silently censusing the default office.)`
    );
  }

  const value = (key: string): string | null => {
    const match = args.find((arg) => arg.startsWith(`--${key}=`));
    return match ? match.slice(key.length + 3) : null;
  };

  const all = args.includes("--all");
  const officeArg = value("office");
  if (all && officeArg) {
    throw new Error("Choose either --all or --office=<slug>, not both");
  }

  const offices: string[] | "all" = all
    ? "all"
    : (officeArg ?? "dallas")
        .split(",")
        .map((slug) => slug.trim().toLowerCase())
        .filter(Boolean);

  if (offices !== "all") {
    if (offices.length === 0) throw new Error("--office needs at least one slug");
    for (const slug of offices) {
      if (!OFFICE_SLUG_PATTERN.test(slug)) throw new Error(`Invalid office slug: ${slug}`);
    }
  }

  const rawLimit = value("limit");
  const limit = rawLimit == null ? 15 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 0 || limit > 500) {
    throw new Error("--limit must be an integer between 0 and 500");
  }

  return { offices, limit, json: args.includes("--json") };
}

/** `office_<slug>`, validated — the only place a slug reaches a raw SQL identifier. */
export function officeSchemaName(slug: string): string {
  if (!OFFICE_SLUG_PATTERN.test(slug)) throw new Error(`Invalid office slug: ${slug}`);
  return `office_${slug}`;
}

function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

/**
 * The census query for one tenant schema. One statement, so every number below comes from ONE snapshot.
 *
 * `cur` and `nxt` are deliberately narrow projections carrying exactly the columns
 * `closeTargetFarOutSqlPredicate` / `holdHorizonDateSql` require at an alias (`stage_id`, `bid_due_date`,
 * `expected_close_date`) — `nxt` differing from `cur` ONLY in `bid_due_date`. That is what lets the SAME
 * shared builder answer "is it parked today?" and "would it be parked after the write?" without either
 * question being re-implemented.
 */
export function buildCensusSql(schemaName: string): string {
  if (!/^office_[a-z][a-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Invalid schema name: ${schemaName}`);
  }
  // Stage-aware, mirroring aliasedStageAwareEffectiveDealValueSql's estimating branch. Not zeroed for
  // hold: the whole point is the value that MOVES when the hold verdict flips, and a hold-zeroed
  // expression would report $0 for exactly the deals that are about to be parked or un-parked.
  const value =
    `CASE WHEN psc.slug IN (${sqlStringList(GENUINE_ESTIMATING_DEAL_STAGE_SLUGS)}) ` +
    `THEN ${aliasedDealEstimatingValueSqlText("d")} ELSE ${aliasedDealBestEstimateSqlText("d")} END`;
  return `
    WITH cand AS (
      SELECT d.id,
             d.deal_number,
             d.project_number,
             d.name,
             d.stage_id,
             d.expected_close_date,
             d.bid_due_date AS current_bid_due_date,
             -- EXACTLY the instant the write-through stores: date -> naive midnight -> interpreted as UTC.
             -- bid_due_date is a timestamptz pinned to UTC midnight and holdHorizonDateSql reads it back
             -- with AT TIME ZONE 'UTC', so anything that resolves in the SESSION timezone here would shift
             -- the calendar day by one and flip a verdict — and therefore a dollar figure.
             (d.bid_board_due_date::timestamp AT TIME ZONE 'UTC') AS next_bid_due_date,
             -- The prospective value as a DATE too, for the change test below. Kept separate from the
             -- timestamptz above, which the horizon CTEs need in the column's own type.
             d.bid_board_due_date AS next_bid_due_day,
             d.bid_board_last_updated_at,
             -- The remaining resolver inputs. The visible-change count below does NOT re-implement the
             -- precedence in SQL — it runs the REAL resolver over these columns, twice (before/after), so
             -- the census cannot disagree with the deal page about which source wins.
             --
             -- The JOINED lead's id, not d.source_lead_id: the resolver keys on whether the lead ROW exists, so a
             -- dangling source_lead_id falls back to the deal column exactly as it does at every read site.
             (l.id IS NOT NULL) AS has_source_lead,
             l.bid_due_date AS lead_bid_due_date,
             d.bid_due_date_from_bid_board_at,
             d.bid_due_date_bid_board_project_number,
             d.bid_board_project_number,
             COALESCE(d.is_test_data, false) AS is_test_data,
             COALESCE(d.bid_board_stage_slug, '') AS bid_board_stage_slug,
             psc.slug AS stage_slug,
             COALESCE(psc.is_terminal, false) AS stage_is_terminal,
             COALESCE(d.on_hold, false) AS stored_on_hold,
             -- See the is_test_data predicate below: TR-DEMO-* rows bypass the flag, so they are FLAGGED
             -- rather than silently trusted or silently dropped.
             (COALESCE(d.deal_number, '') LIKE 'TR-DEMO-%' OR COALESCE(d.project_number, '') LIKE 'TR-DEMO-%') AS demo_shaped,
             -- AMBIGUITY. resolveDealMatches returns EVERY claimant at a tier — attached and detached
             -- together — and the ingest refuses the row as a multi-match rather than writing an ambiguous
             -- one. Such a row is never written, so counting it would overstate the blast radius.
             --
             -- Both identity tiers are modelled, and reported separately: when this number is ever
             -- surprising, knowing WHICH identity collided is what makes it diagnosable.
             --
             -- Both run over the matcher's own base population (active, non-change-order), with detached
             -- deals deliberately INCLUDED — they count toward ambiguity there too, and a detached deal
             -- retaining its identity is the commonest real collision.
             --
             -- TIER 1 — the Bid Board's own key. When the export's Procore Bid ID is shared by this
             -- candidate and another deal, the matcher returns both AT TIER 1 and stops; the row is
             -- refused. This case is EXACT: tier 1 runs first, so an ambiguity there is always fatal.
             EXISTS (
               SELECT 1
                 FROM ${schemaName}.deals o
                WHERE o.id <> d.id
                  AND o.is_active = true
                  AND COALESCE(o.is_change_order, false) = false
                  AND d.procore_bid_id IS NOT NULL
                  AND o.procore_bid_id = d.procore_bid_id
             ) AS is_ambiguous_procore_bid_id,
             -- TIER 2 — project_number / deal_number / bid_board_project_number, using the matcher's OWN
             -- canonicalizer rather than a lookalike.
             --
             -- STRUCTURALLY APPROXIMATE, unlike tier 1, and this is the residue no amount of shared SQL
             -- removes: the TIER CASCADE is control flow, not a predicate. "Tier 1 wins, then tier 2, then
             -- tier 3" cannot be written as a WHERE clause, so a row that collides at tier 2 but resolves
             -- UNIQUELY at tier 1 is excluded here even though the ingest would write it. That direction
             -- understates rather than overstates the flip's effect, which is why the count is surfaced
             -- (ambiguousByProjectNumber) instead of folded away. Tier 3 (name + created-at, reachable
             -- only when bid_board_project_number IS NULL) is not modelled at all: this cohort requires a
             -- mirrored due date, which those rows do not have.
             EXISTS (
               SELECT 1
                 FROM ${schemaName}.deals o
                WHERE o.id <> d.id
                  AND o.is_active = true
                  AND COALESCE(o.is_change_order, false) = false
                  AND ${canonicalProjectNumberSql("d.bid_board_project_number")} IS NOT NULL
                  AND (
                       ${canonicalProjectNumberSql("o.project_number")} = ${canonicalProjectNumberSql("d.bid_board_project_number")}
                    OR ${canonicalProjectNumberSql("o.deal_number")} = ${canonicalProjectNumberSql("d.bid_board_project_number")}
                    OR ${canonicalProjectNumberSql("o.bid_board_project_number")} = ${canonicalProjectNumberSql("d.bid_board_project_number")}
                  )
             ) AS is_ambiguous_project_number,
             COALESCE(${value}, 0) AS deal_value
        FROM ${schemaName}.deals d
        LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
        LEFT JOIN ${schemaName}.leads l ON l.id = d.source_lead_id
        -- The population the ingest's row loop can actually reach: active, not a change-order child, not
        -- detached from Bid Board sync (migration 0200), and carrying a mirrored Due Date to write.
       WHERE d.is_active = true
         AND COALESCE(d.is_change_order, false) = false
         AND d.bid_board_detached_at IS NULL
         AND d.bid_board_due_date IS NOT NULL
         -- ingestBidBoardRows exits at its TEMPLATE guard before matching or writing anything, so a
         -- Templates-status project can never receive a write and must not be counted as one. Matched on
         -- the deal's mirrored status, which is the last status the sync saw. Case/whitespace-folded to
         -- agree with isSkippedBidBoardStatus (its skip set is the single word "templates", which carries
         -- no separators for that normalizer to rewrite).
         AND LOWER(BTRIM(COALESCE(d.bid_board_status, ''))) <> 'templates'
         -- NOTE what is deliberately NOT filtered here: is_test_data. The matcher and
         -- writeBidDueDateIfNeeded have no such predicate, so the ingest WILL write those rows and count
         -- them in bid_board_sync_runs.bid_due_date_updated_count. Excluding them from the cohort would
         -- make the census understate the very counter the operator compares it against. They are dropped
         -- from the FINANCIAL totals instead (see summarizeCensus), because production value queries do
         -- exclude them — the right answer differs per number depending on what that number is for.
    ), touched AS (
      -- EVERY row writeBidDueDateIfNeeded will UPDATE — which since the value/provenance guard split is
      -- strictly more than "rows whose date changes".
      --
      -- value_changes reproduces the write-through's VALUE guard exactly: it compares CALENDAR DAYS
      -- ((bid_due_date AT TIME ZONE 'UTC')::date IS DISTINCT FROM $3::date), not instants. Comparing
      -- instants here would count a legacy row stored at a non-midnight time on the SAME UTC day as the
      -- mirror — a row the real write-through skips — and the census must not overstate the blast radius
      -- of the thing it exists to size.
      --
      -- provenance_stale reproduces its PROVENANCE guard, and carrying it here is not bookkeeping: a
      -- lead-backed deal that already holds the right day but has no valid stamp gets a STAMP-ONLY update,
      -- after which the resolver flips its page from the lead's date to the deal column's. Its date never
      -- moves and no dollar figure changes, so the old cohort dropped it entirely — and the census stayed
      -- silent about a deal page that visibly changes. The two guards are separate in the ingest, so they
      -- have to be separate here too.
      SELECT cand.*,
             ((current_bid_due_date AT TIME ZONE 'UTC')::date IS DISTINCT FROM next_bid_due_day)
               AS value_changes
        FROM cand
       WHERE (current_bid_due_date AT TIME ZONE 'UTC')::date IS DISTINCT FROM next_bid_due_day
          OR bid_due_date_from_bid_board_at IS NULL
          OR bid_due_date_bid_board_project_number IS DISTINCT FROM bid_board_project_number
    ), cur AS (
      SELECT id, stage_id, expected_close_date, current_bid_due_date AS bid_due_date FROM touched
    ), nxt AS (
      -- A stamp-only row's column is NOT rewritten, so its prospective horizon is its CURRENT value. Using
      -- the board date unconditionally would still land on the same calendar day (that is why it is
      -- stamp-only), but modelling the write precisely keeps this honest if the guards ever diverge.
      SELECT id,
             stage_id,
             expected_close_date,
             CASE WHEN value_changes THEN next_bid_due_date ELSE current_bid_due_date END AS bid_due_date
        FROM touched
    )
    SELECT w.id,
           w.deal_number,
           w.project_number,
           w.name,
           w.stage_slug,
           w.deal_value::numeric AS deal_value,
           w.current_bid_due_date,
           w.next_bid_due_date,
           w.stored_on_hold,
           w.bid_board_last_updated_at,
           w.demo_shaped,
           w.is_ambiguous_procore_bid_id,
           w.is_ambiguous_project_number,
           w.next_bid_due_day,
           w.is_test_data,
           w.bid_due_date_bid_board_project_number,
           w.bid_board_project_number,
           w.has_source_lead,
           w.lead_bid_due_date,
           w.bid_due_date_from_bid_board_at,
           w.value_changes,
           (w.current_bid_due_date IS NULL) AS from_null,
           (w.stage_slug IN (${sqlStringList(GENUINE_ESTIMATING_DEAL_STAGE_SLUGS)})) AS is_genuine_estimating,
           -- Terminal EITHER by the CRM stage or by the Bid Board mirror, matching
           -- aliasedEffectiveOnHoldConditionSql: a realized deal is exempt from the far-out auto-park leg,
           -- so its value cannot move no matter what this write does to its bid date.
           (w.stage_is_terminal OR w.bid_board_stage_slug IN (${sqlStringList(TERMINAL_STAGE_SLUGS)})) AS is_terminal,
           (${holdHorizonDateSql("cur")}) AS current_horizon,
           (${holdHorizonDateSql("nxt")}) AS next_horizon,
           (${closeTargetFarOutSqlPredicate("cur")}) AS currently_far_out,
           (${closeTargetFarOutSqlPredicate("nxt")}) AS next_far_out
      FROM touched w
      JOIN cur ON cur.id = w.id
      JOIN nxt ON nxt.id = w.id
  `;
}

export interface CensusRow {
  id: string;
  deal_number: string | null;
  project_number: string | null;
  name: string | null;
  stage_slug: string | null;
  deal_value: string | number | null;
  current_bid_due_date: Date | string | null;
  next_bid_due_date: Date | string | null;
  stored_on_hold: boolean;
  bid_board_last_updated_at: Date | string | null;
  demo_shaped: boolean;
  /** `deals.bid_board_due_date` verbatim — the resolver's SIGNAL input, not a value it ever returns. */
  next_bid_due_day: Date | string | null;
  is_test_data: boolean;
  bid_due_date_bid_board_project_number: string | null;
  bid_board_project_number: string | null;
  has_source_lead: boolean;
  lead_bid_due_date: Date | string | null;
  bid_due_date_from_bid_board_at: Date | string | null;
  /** True when the ingest will rewrite the DATE; false for a stamp-only (provenance) update. */
  value_changes: boolean;
  from_null: boolean;
  is_genuine_estimating: boolean;
  is_terminal: boolean;
  current_horizon: Date | string | null;
  next_horizon: Date | string | null;
  currently_far_out: boolean;
  next_far_out: boolean;
}

export interface CensusMover {
  dealNumber: string | null;
  projectNumber: string | null;
  name: string | null;
  stageSlug: string | null;
  transition: "park" | "unpark";
  value: number;
  currentHorizon: string | null;
  nextHorizon: string | null;
}

export interface CensusSummary {
  schemaName: string;
  wouldWrite: number;
  /**
   * Every row the ingest will UPDATE: value writes PLUS stamp-only provenance passes. Always >=
   * `wouldWrite`; the difference is deals the Board confirms without correcting.
   */
  touchedRows: number;
  /**
   * Rows the matcher's ambiguity guard will refuse (another active deal — commonly a DETACHED one that
   * kept its identity — claims the same one). EXCLUDED from every other number here, because the ingest
   * never writes them; reported so the exclusion is visible rather than silent.
   */
  ambiguousRowsExcluded: number;
  /** Of those, collisions on procore_bid_id (matcher tier 1). Exact: tier 1 runs first, so it is fatal. */
  ambiguousByProcoreBidId: number;
  /**
   * Of those, collisions on the canonical project/deal number (matcher tier 2). May overlap with the tier-1
   * count, so the two do not necessarily sum to `ambiguousRowsExcluded` — which counts distinct ROWS.
   */
  ambiguousByProjectNumber: number;
  /** Rows that look like demo seed data (TR-DEMO-*) but carry no is_test_data flag — counted, NOT excluded. */
  demoShapedRows: number;
  /**
   * How many of `wouldWrite` are flagged test deals. INCLUDED in the write counts, because the ingest has
   * no is_test_data predicate and will write and count them; EXCLUDED from every financial total, because
   * production value queries drop them. Reported so the two sets of numbers are never confused.
   */
  testDataRows: number;
  /**
   * Deals whose deal page will SHOW a different Bid Due Date once the write lands. Computed by running the
   * real resolver before and after, so it answers "how many pages change", not "how many dollars move".
   */
  pagesChanged: number;
  /**
   * The subset of `pagesChanged` that changes because the READ OVERRIDE starts firing — lead-backed deals
   * whose lead value has been masking the board's date. The remainder change simply because the column
   * they already displayed was rewritten.
   */
  leadMaskedReveals: number;
  fromNull: number;
  fromDifferentDate: number;
  genuineEstimating: number;
  wouldPark: number;
  wouldUnpark: number;
  parkedValue: number;
  unparkedValue: number;
  netValueDelta: number;
  movers: CensusMover[];
}

function dayString(value: Date | string | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function numeric(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * PURE summarizer over the census rows, so the counting rules are unit-testable without a database.
 *
 * A stored-on-hold deal is excluded from both transitions: its value is already zero via the always-applies
 * `on_hold` leg, so the horizon flipping changes nothing about what it reports. A terminal deal is excluded
 * for the same reason in reverse — the far-out leg never applies to it, so its realized value is untouched.
 */
export function summarizeCensus(schemaName: string, rows: CensusRow[], limit: number): CensusSummary {
  const summary: CensusSummary = {
    schemaName,
    // Rows the ingest will UPDATE at all (value writes + stamp-only provenance passes).
    touchedRows: 0,
    ambiguousRowsExcluded: 0,
    ambiguousByProcoreBidId: 0,
    ambiguousByProjectNumber: 0,
    // Rows whose DATE actually changes. Deliberately NOT rows.length: `bid_due_date_updated_count` on the
    // run row counts only these, and the operator compares the two directly.
    wouldWrite: 0,
    demoShapedRows: 0,
    testDataRows: 0,
    pagesChanged: 0,
    leadMaskedReveals: 0,
    fromNull: 0,
    fromDifferentDate: 0,
    genuineEstimating: 0,
    wouldPark: 0,
    wouldUnpark: 0,
    parkedValue: 0,
    unparkedValue: 0,
    netValueDelta: 0,
    movers: [],
  };

  const movers: CensusMover[] = [];
  for (const row of rows) {
    // Refused by the matcher before anything is written — counted, then excluded from everything else.
    // Split by which identity collided, because a surprising total is only diagnosable if you know that.
    //
    // Tier 1 is EXACT (it runs first, so a collision there always refuses the row). Tier 2 is
    // structurally approximate — see the SQL comment: the tier CASCADE is control flow, not a predicate,
    // so a row colliding at tier 2 but resolving uniquely at tier 1 is excluded here although the ingest
    // would write it. Conservative, and surfaced rather than folded away silently.
    if (row.is_ambiguous_procore_bid_id || row.is_ambiguous_project_number) {
      summary.ambiguousRowsExcluded += 1;
      if (row.is_ambiguous_procore_bid_id) summary.ambiguousByProcoreBidId += 1;
      if (row.is_ambiguous_project_number) summary.ambiguousByProjectNumber += 1;
      continue;
    }
    summary.touchedRows += 1;
    // WRITE-LINE numbers describe the rows whose DATE moves, because that is exactly what the run row's
    // bid_due_date_updated_count records. A stamp-only pass is an UPDATE but not a change, so it is
    // counted in touchedRows and nowhere else on this line.
    if (row.value_changes) {
      summary.wouldWrite += 1;
      if (row.demo_shaped) summary.demoShapedRows += 1;
      if (row.is_test_data) summary.testDataRows += 1;
      if (row.from_null) summary.fromNull += 1;
      else summary.fromDifferentDate += 1;
      if (row.is_genuine_estimating) summary.genuineEstimating += 1;
    }

    // WILL A REP SEE A DIFFERENT DATE? Answered by running the ACTUAL resolver twice rather than
    // re-implementing its precedence in SQL — same reason the hold verdicts reuse the app's own builders.
    // Every subtlety comes along for free: a cleared lead value still winning, a dangling source_lead_id
    // falling back to the deal column, and the provenance/day-match signal deciding whether the override
    // fires at all.
    //
    // BEFORE is the state right after the flag is flipped and before the sync writes — which, because no
    // deal carries a provenance stamp yet, is also exactly what the page shows today. The stamp is read
    // from the row rather than assumed null, so a census re-run mid-rollout stays accurate.
    const displayedBefore = resolveDealBidDueDate({
      bidBoardDueDate: row.next_bid_due_day,
      bidDueDateFromBidBoardAt: row.bid_due_date_from_bid_board_at,
      // The identity half of the provenance signal — a stamp earned on a RETIRED project must not count.
      bidDueDateBidBoardProjectNumber: row.bid_due_date_bid_board_project_number,
      bidBoardProjectNumber: row.bid_board_project_number,
      bidBoardDetachedAt: null, // the candidate set is already `bid_board_detached_at IS NULL`
      hasSourceLead: row.has_source_lead,
      leadBidDueDate: row.lead_bid_due_date,
      dealBidDueDate: row.current_bid_due_date,
    });
    // AFTER: the write-through has stamped provenance — which is what makes the deal eligible for the
    // override — and, ONLY when the day differs, stored the board's day at UTC midnight. A stamp-only row
    // keeps its existing column value, so modelling it as rewritten would be describing a write that does
    // not happen.
    const nextDay = dayString(row.next_bid_due_date);
    const displayedAfter = resolveDealBidDueDate({
      bidBoardDueDate: row.next_bid_due_day,
      bidDueDateFromBidBoardAt: new Date(),
      // The write stamps the project it wrote FOR, copied from the live column.
      bidDueDateBidBoardProjectNumber: row.bid_board_project_number,
      bidBoardProjectNumber: row.bid_board_project_number,
      bidBoardDetachedAt: null,
      hasSourceLead: row.has_source_lead,
      leadBidDueDate: row.lead_bid_due_date,
      dealBidDueDate: row.value_changes
        ? nextDay == null
          ? null
          : new Date(dateOnlyToUtcMidnightIso(nextDay))
        : row.current_bid_due_date,
    });
    // Calendar days, consistent with the write guard and the write-set comparison — `.day` is already
    // normalized, so a timestamptz/date-only shape difference can never masquerade as a visible change.
    if (displayedBefore.day !== displayedAfter.day) {
      summary.pagesChanged += 1;
      // Attribute the cause: the override firing (the lead was masking the board's date) versus the
      // column the page already displayed simply being rewritten.
      if (displayedAfter.source === "bid_board" && displayedBefore.source === "lead") {
        summary.leadMaskedReveals += 1;
      }
    }

    // FINANCIAL totals from here down.
    //
    // A stamp-only row is excluded because its bid_due_date never moves, and every reported-pipeline
    // surface (holdHorizonDateSql and its ~50 SQL consumers) reads that column — so no dashboard, board or
    // rollup can shift. Its deal PAGE can, which is what pagesChanged above counts.
    //
    // Test deals are excluded because every production value query excludes them, so a parked or
    // un-parked fixture moves no reported dollars — while the write counts above deliberately keep them,
    // because the ingest will still write those rows.
    if (!row.value_changes) continue;
    if (row.is_test_data) continue;
    if (row.stored_on_hold || row.is_terminal) continue;
    const value = numeric(row.deal_value);

    if (!row.currently_far_out && row.next_far_out) {
      summary.wouldPark += 1;
      summary.parkedValue += value;
      movers.push({
        dealNumber: row.deal_number,
        projectNumber: row.project_number,
        name: row.name,
        stageSlug: row.stage_slug,
        transition: "park",
        value,
        currentHorizon: dayString(row.current_horizon),
        nextHorizon: dayString(row.next_horizon),
      });
      continue;
    }

    if (row.currently_far_out && !row.next_far_out) {
      summary.wouldUnpark += 1;
      summary.unparkedValue += value;
      movers.push({
        dealNumber: row.deal_number,
        projectNumber: row.project_number,
        name: row.name,
        stageSlug: row.stage_slug,
        transition: "unpark",
        value,
        currentHorizon: dayString(row.current_horizon),
        nextHorizon: dayString(row.next_horizon),
      });
    }
  }

  // A park REMOVES the deal's value from reported pipeline; an un-park ADDS it back.
  summary.netValueDelta = summary.unparkedValue - summary.parkedValue;
  summary.movers = movers.sort((a, b) => b.value - a.value).slice(0, limit);
  return summary;
}

interface QueryClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

export async function discoverOfficeSchemas(client: QueryClient): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\\_%' ESCAPE '\\' ORDER BY nspname`
  );
  return rows.map((row: { nspname: string }) => row.nspname);
}

function money(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function printSummary(summary: CensusSummary): void {
  console.log(`\n=== ${summary.schemaName} ===`);
  console.log(
    `  (a) would write bid_due_date: ${summary.wouldWrite}` +
      `  (null->date: ${summary.fromNull}, date->different-date: ${summary.fromDifferentDate})` +
      `  — compare against bid_board_sync_runs.bid_due_date_updated_count`
  );
  const stampOnly = summary.touchedRows - summary.wouldWrite;
  if (summary.ambiguousRowsExcluded > 0) {
    console.log(
      `      (${summary.ambiguousRowsExcluded} row(s) excluded: another active deal claims the same ` +
        `matcher identity, so the ingest refuses them as a multi-match and writes nothing —` +
        ` procore_bid_id: ${summary.ambiguousByProcoreBidId}, project/deal number: ${summary.ambiguousByProjectNumber}.)`
    );
  }
  if (stampOnly > 0) {
    // Not a discrepancy: the ingest UPDATEs these rows to record that the Board confirms a date that was
    // already correct. They move no dollars and are deliberately absent from the counter above — but they
    // DO make the deal eligible for the read override, so they can still change a page (section e).
    console.log(
      `      + ${stampOnly} more will get a provenance-only update (the Board confirms a date already ` +
        `correct). Not in the counter above; still counted in (e).`
    );
  }
  if (summary.testDataRows > 0) {
    console.log(
      `      ${summary.testDataRows} of them are is_test_data deals: the ingest writes and counts them, so` +
        ` they are IN the number above, and OUT of every dollar figure below.`
    );
  }
  console.log(`  (b) of the date changes, in a genuine estimating stage: ${summary.genuineEstimating}`);
  if (summary.demoShapedRows > 0) {
    console.log(
      `      ⚠️  ${summary.demoShapedRows} of them look like TR-DEMO-* seed data with no is_test_data flag — ` +
        `counted above, because excluding them would make this disagree with the app. Review before flipping.`
    );
  }
  console.log(
    `  (c) would_park: ${summary.wouldPark} (${money(summary.parkedValue)} removed)` +
      `  |  would_unpark: ${summary.wouldUnpark} (${money(summary.unparkedValue)} restored)`
  );
  console.log(`  (d) NET reported-pipeline delta: ${money(summary.netValueDelta)}`);
  // The second question the flip decision needs, and one the dollar figure cannot answer: is that delta
  // three deals or three hundred, and will reps notice anything on the pages they open every day?
  console.log(
    `  (e) deal pages that will SHOW a different Bid Due Date: ${summary.pagesChanged}` +
      `  (of which ${summary.leadMaskedReveals} because the read override starts firing over a masking` +
      ` lead value; the rest because the column they already displayed was rewritten)`
  );
  if (summary.movers.length === 0) {
    console.log("  (f) largest movers: none");
    return;
  }
  console.log(`  (f) largest movers (top ${summary.movers.length}, horizon = the ${CLOSE_TARGET_HOLD_HORIZON_DAYS}-day auto-park date):`);
  for (const mover of summary.movers) {
    console.log(
      `      ${mover.transition.toUpperCase().padEnd(6)} ${money(mover.value).padStart(12)}  ` +
        `${(mover.projectNumber ?? mover.dealNumber ?? "—").padEnd(20)} ` +
        `[${mover.stageSlug ?? "—"}] ${mover.currentHorizon ?? "—"} -> ${mover.nextHorizon ?? "—"}  ${mover.name ?? ""}`
    );
  }
}

/**
 * The reporting core, over an already-open client. Split out of `main` so the completeness contract below
 * — a failing office must never read as an all-clear — is testable without a database.
 *
 * THROWS on an incomplete run (any office failed, or no office was examined at all) AFTER printing what it
 * did manage to gather, so the operator sees both the partial numbers and an unmissable warning that they
 * are partial, and any wrapper sees a non-zero exit.
 */
export async function runCensus(args: CensusArgs, client: QueryClient): Promise<void> {
  const schemas =
    args.offices === "all" ? await discoverOfficeSchemas(client) : args.offices.map(officeSchemaName);

  const summaries: CensusSummary[] = [];
  const failures: Array<{ schemaName: string; error: string }> = [];
  for (const schemaName of schemas) {
    // Each office runs inside its own SAVEPOINT. Without one, a single failing office (a schema missing a
    // column, a half-provisioned tenant) aborts the shared read-only transaction and EVERY subsequent
    // office then fails too with "current transaction is aborted" — turning one broken office into a
    // whole-run outage and reporting nothing measurable at all. Rolling back to the savepoint returns the
    // transaction to a usable state, so `--all` reports the offices it CAN measure and names the ones it
    // could not. (Requires the caller's BEGIN — `main` owns it.)
    await client.query(`SAVEPOINT census_office`);
    try {
      const { rows } = await client.query(buildCensusSql(schemaName));
      summaries.push(summarizeCensus(schemaName, rows as CensusRow[], args.limit));
      await client.query(`RELEASE SAVEPOINT census_office`);
    } catch (schemaError) {
      console.error(`\n=== ${schemaName} === FAILED:`, schemaError);
      failures.push({
        schemaName,
        error: schemaError instanceof Error ? schemaError.message : String(schemaError),
      });
      await client.query(`ROLLBACK TO SAVEPOINT census_office`).catch(() => {});
      await client.query(`RELEASE SAVEPOINT census_office`).catch(() => {});
    }
  }

  // A per-schema failure must never read as "no impact". This artifact is the gate on a prod flag flip that
  // moves reported dollars, and the shape this replaced printed "Across 0 office(s): net delta $0" — a
  // clean-looking all-clear — when every office had errored, with `--json` emitting an empty array.
  const complete = failures.length === 0 && schemas.length > 0;

  if (args.json) {
    console.log(
      JSON.stringify({ generatedAt: new Date().toISOString(), complete, summaries, failures }, null, 2)
    );
  } else {
    for (const summary of summaries) printSummary(summary);
    const net = summaries.reduce((total, summary) => total + summary.netValueDelta, 0);
    console.log(
      `\n[bid-due-date-census] READ-ONLY. Across ${summaries.length} office(s): net reported-pipeline delta ${money(net)} ` +
        `if BID_BOARD_DUE_DATE_READBACK is enabled and the next export matches today's mirror.`
    );
    if (!complete) {
      console.error(
        `[bid-due-date-census] ⚠️  INCOMPLETE — this is NOT an all-clear. ` +
          (schemas.length === 0
            ? "No office schema was examined at all."
            : `${failures.length} of ${schemas.length} office(s) failed and are NOT counted above: ${failures
                .map((f) => f.schemaName)
                .join(", ")}.`) +
          " Do NOT flip BID_BOARD_DUE_DATE_READBACK on these numbers."
      );
    }
  }

  if (!complete) {
    throw new Error(
      schemas.length === 0
        ? "Census examined no office schemas — the run is incomplete, do not act on the result."
        : `Census incomplete: ${failures.length} of ${schemas.length} office(s) failed (${failures
            .map((f) => f.schemaName)
            .join(", ")}).`
    );
  }
}

export async function main(argv = process.argv): Promise<void> {
  const args = parseCensusArgs(argv);
  const { url, ssl } = resolveScriptDatabaseUrl();
  const client = new pg.Client({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : undefined });
  await client.connect();

  try {
    // Belt AND braces with the arg parser above: Postgres itself refuses any write in this transaction, so
    // even a future edit that added an UPDATE would fail loudly instead of silently touching prod.
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    try {
      await runCensus(args, client);
    } finally {
      // Rolled back on the incomplete path too — the transaction is closed cleanly whatever happened.
      await client.query("ROLLBACK").catch(() => {});
    }
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error("[bid-due-date-census] failed:", error);
    process.exit(1);
  });
}
