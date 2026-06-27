import { sql } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "@trock-crm/shared/schema";
import type { McpAuthContext } from "../auth/contract.js";
import { withOfficeSchema, type TenantDb } from "../data/withOfficeSchema.js";
import { applyBaseDealFilters, wonStageSlugFilterSql } from "../data/applyBaseDealFilters.js";
import { WON_WINDOW_PRESETS, wonWindowStartSql, type WonWindowPreset } from "../data/wonWindow.js";
import { dealValueSqlForBasis } from "../../modules/reports/foundations.js";
import { getAtRiskWatchlist } from "../../modules/reports/at-risk-service.js";

const { deals, pipelineStageConfig } = schema;

export const PIPELINE_PRESETS = WON_WINDOW_PRESETS;
export type PipelinePreset = WonWindowPreset;

/** Flat, chartable row (segment vs count/value). */
export interface PipelineSummaryRow {
  segment: "Won" | "Active" | "Stalled";
  count: number;
  value: number;
}

const num = (v: unknown): number => Number(v ?? 0);
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

/**
 * Computes the Won / Active / Stalled segments for the Dallas pipeline. Every number is SQL:
 *  - Won: applyBaseDealFilters + the canonical 6-slug Won family, windowed by won_closed_date;
 *         value via the canonical won (awarded-first) basis — same as the CRM reports.
 *  - Active: applyBaseDealFilters + non-terminal stage; value via the open best-estimate basis.
 *  - Stalled: the existing at-risk watchlist (open deals with a missing/past close date) — no new
 *    threshold; reuses getAtRiskWatchlist so it reconciles with the CRM at-risk surface.
 */
export async function computePipelineSummary(
  db: TenantDb,
  preset: PipelinePreset
): Promise<PipelineSummaryRow[]> {
  const start = wonWindowStartSql(preset);
  const wonWindow = start ? sql` AND d.won_closed_date >= ${sql.raw(start)}` : sql``;

  const wonRow = rowsOf<{ count: unknown; value: unknown }>(
    await db.execute(sql`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(${dealValueSqlForBasis("d", "won_awarded_first")}), 0)::numeric AS value
      FROM ${deals} d
      JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
      WHERE ${applyBaseDealFilters("d")}
        AND ${wonStageSlugFilterSql("psc.slug")}
        AND d.won_closed_date IS NOT NULL${wonWindow}
    `)
  )[0];

  const activeRow = rowsOf<{ count: unknown; value: unknown }>(
    await db.execute(sql`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(${dealValueSqlForBasis("d", "open_best_estimate")}), 0)::numeric AS value
      FROM ${deals} d
      JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
      WHERE ${applyBaseDealFilters("d")}
        AND psc.is_terminal = false
    `)
  )[0];

  const atRisk = await getAtRiskWatchlist(db);

  return [
    { segment: "Won", count: num(wonRow?.count), value: num(wonRow?.value) },
    { segment: "Active", count: num(activeRow?.count), value: num(activeRow?.value) },
    { segment: "Stalled", count: atRisk.summary.count, value: atRisk.summary.valueAtRisk },
  ];
}

export function registerGetPipelineSummary(server: McpServer, context: McpAuthContext): void {
  server.registerTool(
    "get_pipeline_summary",
    {
      title: "Pipeline summary",
      description:
        "Counts and dollar value for Won / Active / Stalled deals in the Dallas pipeline. Won is " +
        "windowed by won_closed_date over the chosen preset; Active = open (non-terminal) deals; " +
        "Stalled = the at-risk watchlist (open deals with a missing or past close date). Returns a " +
        "flat { segment, count, value } row array suitable for charting.",
      inputSchema: {
        preset: z
          .enum(PIPELINE_PRESETS)
          .optional()
          .describe("Won-revenue window by won_closed_date (mtd|qtd|ytd|last_90d|all). Default ytd."),
      },
    },
    async ({ preset }) => {
      const resolved: PipelinePreset = preset ?? "ytd";
      const rows = await withOfficeSchema(context.office, (db) =>
        computePipelineSummary(db, resolved)
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ preset: resolved, rows }, null, 2) }],
      };
    }
  );
}
