import { sql } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "@trock-crm/shared/schema";
import type { McpAuthContext } from "../auth/contract.js";
import { withOfficeSchema, type TenantDb } from "../data/withOfficeSchema.js";
import { applyBaseDealFilters, wonStageSlugFilterSql } from "../data/applyBaseDealFilters.js";
import { WON_WINDOW_PRESETS, wonWindowStartSql, type WonWindowPreset } from "../data/wonWindow.js";

const { deals, pipelineStageConfig, users } = schema;

const LOW_SAMPLE_THRESHOLD = 5;

/** Flat, chartable per-rep variance row. */
export interface BidAwardVarianceRow {
  rep: string;
  n: number;
  avgVariancePct: number;
  medianVariancePct: number;
  /** Sample std-dev of the per-deal variance % — null when n < 2 (not computable). */
  variancePctStdDev: number | null;
  /** Total awarded dollars across the rep's qualifying won deals. */
  dollarMagnitude: number;
  /** n < 5: too few deals for the variance to be reliable. */
  lowSample: boolean;
}

export interface BidAwardVarianceResult {
  preset: WonWindowPreset;
  coverage: {
    wonInWindow: number;
    withVarianceBasis: number;
    caption: string;
  };
  rows: BidAwardVarianceRow[];
}

const num = (v: unknown): number => Number(v ?? 0);
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

/**
 * Per-rep variance between a deal's original bid_estimate and its final awarded_amount, over Won
 * deals in the chosen won_closed_date window. Variance % per deal = (awarded - bid) / bid * 100.
 *
 * Basis: Won (canonical 6-slug) + applyBaseDealFilters + BOTH bid_estimate > 0 AND awarded_amount > 0
 * (a deal with no bid or no award cannot have a variance and is excluded — change-order children,
 * which carry no original bid, naturally fall out here). dd_estimate is NOT used (only ~4% populated).
 *
 * SQL computes n, avg & median variance % (PERCENTILE_CONT), variability (sample std-dev), and the
 * dollar magnitude (total awarded). Reps with n < 5 are flagged lowSample. The coverage caption
 * states how many Won-in-window deals actually had both a bid and an award.
 *
 * NOTE: this figure has no inventory reconciliation anchor — manually spot-check 2-3 named reps'
 * bid-vs-award against their actual deals at the post-deploy live check before the demo.
 */
export async function computeBidAwardVariance(
  db: TenantDb,
  preset: WonWindowPreset
): Promise<BidAwardVarianceResult> {
  const start = wonWindowStartSql(preset);
  const wonWindow = start ? sql` AND d.won_closed_date >= ${sql.raw(start)}` : sql``;

  const perRep = rowsOf<{
    rep_name: string;
    rep_id: string | null;
    n: unknown;
    avg_variance_pct: unknown;
    median_variance_pct: unknown;
    variance_pct_stddev: unknown;
    dollar_magnitude: unknown;
  }>(
    await db.execute(sql`
      WITH qualifying AS (
        SELECT d.assigned_rep_id AS rep_id,
               COALESCE(u.display_name, '') AS rep_name,
               d.awarded_amount AS award,
               ((d.awarded_amount - d.bid_estimate) / NULLIF(d.bid_estimate, 0) * 100.0) AS variance_pct
        FROM ${deals} d
        JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
        LEFT JOIN ${users} u ON u.id = d.assigned_rep_id
        WHERE ${applyBaseDealFilters("d")}
          AND ${wonStageSlugFilterSql("psc.slug")}
          AND d.won_closed_date IS NOT NULL${wonWindow}
          AND d.bid_estimate IS NOT NULL AND d.bid_estimate > 0
          AND d.awarded_amount IS NOT NULL AND d.awarded_amount > 0
      )
      SELECT rep_id,
             rep_name,
             COUNT(*)::int AS n,
             ROUND(AVG(variance_pct)::numeric, 2) AS avg_variance_pct,
             ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY variance_pct))::numeric, 2) AS median_variance_pct,
             ROUND(STDDEV_SAMP(variance_pct)::numeric, 2) AS variance_pct_stddev,
             SUM(award)::numeric AS dollar_magnitude
      FROM qualifying
      GROUP BY rep_id, rep_name
      ORDER BY n DESC, dollar_magnitude DESC
    `)
  );

  const coverage = rowsOf<{ won_in_window: unknown; with_basis: unknown }>(
    await db.execute(sql`
      SELECT COUNT(*)::int AS won_in_window,
             COUNT(*) FILTER (
               WHERE d.bid_estimate IS NOT NULL AND d.bid_estimate > 0
                 AND d.awarded_amount IS NOT NULL AND d.awarded_amount > 0
             )::int AS with_basis
      FROM ${deals} d
      JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
      WHERE ${applyBaseDealFilters("d")}
        AND ${wonStageSlugFilterSql("psc.slug")}
        AND d.won_closed_date IS NOT NULL${wonWindow}
    `)
  )[0];

  const wonInWindow = num(coverage?.won_in_window);
  const withVarianceBasis = num(coverage?.with_basis);

  const rows: BidAwardVarianceRow[] = perRep.map((r) => {
    const n = num(r.n);
    return {
      rep: r.rep_name || (r.rep_id ? "Unknown rep" : "Unassigned"),
      n,
      avgVariancePct: num(r.avg_variance_pct),
      medianVariancePct: num(r.median_variance_pct),
      variancePctStdDev: r.variance_pct_stddev == null ? null : num(r.variance_pct_stddev),
      dollarMagnitude: num(r.dollar_magnitude),
      lowSample: n < LOW_SAMPLE_THRESHOLD,
    };
  });

  return {
    preset,
    coverage: {
      wonInWindow,
      withVarianceBasis,
      caption:
        `Variance computed over ${withVarianceBasis} of ${wonInWindow} Won deals in the window ` +
        `that have both a bid_estimate and an awarded_amount (deals missing either are excluded; ` +
        `awarded-but-not-Won deals are out of scope).`,
    },
    rows,
  };
}

export function registerGetBidAwardVariance(server: McpServer, context: McpAuthContext): void {
  server.registerTool(
    "get_bid_award_variance",
    {
      title: "Bid → award variance (per rep)",
      description:
        "Per-rep variance between original bid_estimate and final awarded_amount on Won deals, " +
        "windowed by won_closed_date. Returns, per rep: n, avg & median variance %, variability " +
        "(std-dev), and dollar magnitude (total awarded); reps with fewer than 5 deals are flagged " +
        "lowSample. Includes a coverage caption. Flat row array suitable for charting.",
      inputSchema: {
        preset: z
          .enum(WON_WINDOW_PRESETS)
          .optional()
          .describe("won_closed_date window (mtd|qtd|ytd|last_90d|all). Default ytd."),
      },
    },
    async ({ preset }) => {
      const resolved: WonWindowPreset = preset ?? "ytd";
      const result = await withOfficeSchema(context.office, (db) =>
        computeBidAwardVariance(db, resolved)
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
}
