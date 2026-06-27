import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "@trock-crm/shared/schema";
import type { McpAuthContext } from "../auth/contract.js";
import { withOfficeSchema, type TenantDb } from "../data/withOfficeSchema.js";
import { applyBaseDealFilters, wonStageSlugFilterSql } from "../data/applyBaseDealFilters.js";
import { aliasedDealBestEstimateSql } from "../../modules/shared/deal-value-sql.js";

const { deals, pipelineStageConfig, users } = schema;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export interface ListDealsFilters {
  stage?: string;
  owner?: string;
  minValue?: number;
  maxValue?: number;
  closeDateFrom?: string;
  closeDateTo?: string;
  limit?: number;
}

/** Flat, chartable deal row. `value` is the raw awarded-first headline estimate. */
export interface DealRow {
  dealNumber: string | null;
  name: string;
  stage: string;
  owner: string;
  value: number;
  expectedCloseDate: string | null;
  wonClosedDate: string | null;
}

const num = (v: unknown): number => Number(v ?? 0);
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

interface RawDealRow {
  deal_number: string | null;
  name: string;
  stage_name: string;
  owner: string;
  value: unknown;
  expected_close_date: unknown;
  won_closed_date: unknown;
}

export function clampLimit(limit: number | undefined): number {
  if (limit == null || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

export interface ListDealsResult {
  rows: DealRow[];
  /** Real SQL COUNT(*) of ALL deals matching the filters (not just the returned page). */
  totalMatching: number;
  /** rows.length — the size of this page. */
  returned: number;
  /** true when totalMatching exceeds what was returned (the page was capped). */
  truncated: boolean;
}

/**
 * Lists individual Dallas deals (reportable: applyBaseDealFilters) filtered by stage / owner /
 * value / close-date, newest-value first, bounded to 25 (max 100). Value is the raw awarded-first
 * headline estimate (awarded > bid_board > bid), so it reads sensibly across stages.
 *
 * Returns the page of rows PLUS `totalMatching` — a real SQL COUNT(*) over the same WHERE — so a
 * "how many" question has an actual SQL answer rather than the LIMIT page size, and `truncated`
 * signals when the result set was capped. All numbers and filters are SQL; every filter value is a
 * bound parameter.
 */
export async function computeListDeals(db: TenantDb, filters: ListDealsFilters): Promise<ListDealsResult> {
  const value = aliasedDealBestEstimateSql("d");
  const conds: SQL[] = [applyBaseDealFilters("d")];

  // Normalize text filters up front so surrounding whitespace can't break a slug/name match
  // (and " won " still routes to the canonical Won family).
  const stage = filters.stage?.trim();
  const owner = filters.owner?.trim();

  if (stage) {
    if (stage.toLowerCase() === "won") {
      // "won" means the canonical 6-slug Won family, so list_deals reconciles with the aggregate
      // Won tools (get_pipeline_summary / get_bid_award_variance) — not just the literal "won" slug.
      conds.push(wonStageSlugFilterSql("psc.slug"));
    } else {
      conds.push(sql`(psc.slug = ${stage} OR psc.name ILIKE ${"%" + stage + "%"})`);
    }
  }
  if (owner) {
    conds.push(sql`u.display_name ILIKE ${"%" + owner + "%"}`);
  }
  if (filters.minValue != null) conds.push(sql`${value} >= ${filters.minValue}`);
  if (filters.maxValue != null) conds.push(sql`${value} <= ${filters.maxValue}`);
  if (filters.closeDateFrom) conds.push(sql`d.expected_close_date >= ${filters.closeDateFrom}::date`);
  if (filters.closeDateTo) conds.push(sql`d.expected_close_date <= ${filters.closeDateTo}::date`);

  // Shared FROM + WHERE so the COUNT and the page apply IDENTICAL filtering.
  const fromWhere = sql`
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    LEFT JOIN ${users} u ON u.id = d.assigned_rep_id
    WHERE ${sql.join(conds, sql` AND `)}
  `;

  const totalRow = rowsOf<{ count: unknown }>(
    await db.execute(sql`SELECT COUNT(*)::int AS count ${fromWhere}`)
  )[0];
  const totalMatching = num(totalRow?.count);

  const limit = clampLimit(filters.limit);
  const raw = rowsOf<RawDealRow>(
    await db.execute(sql`
      SELECT d.deal_number AS deal_number,
             d.name AS name,
             COALESCE(psc.name, '') AS stage_name,
             COALESCE(u.display_name, '') AS owner,
             ${value}::numeric AS value,
             d.expected_close_date AS expected_close_date,
             d.won_closed_date AS won_closed_date
      ${fromWhere}
      ORDER BY value DESC NULLS LAST, d.name ASC
      LIMIT ${limit}
    `)
  );

  const rows = raw.map((r) => ({
    dealNumber: r.deal_number == null ? null : String(r.deal_number),
    name: r.name,
    stage: r.stage_name,
    owner: r.owner || "Unassigned",
    value: num(r.value),
    expectedCloseDate: r.expected_close_date == null ? null : String(r.expected_close_date).slice(0, 10),
    wonClosedDate: r.won_closed_date == null ? null : String(r.won_closed_date).slice(0, 10),
  }));

  return { rows, totalMatching, returned: rows.length, truncated: totalMatching > rows.length };
}

export function registerListDeals(server: McpServer, context: McpAuthContext): void {
  server.registerTool(
    "list_deals",
    {
      title: "List deals",
      description:
        "Lists individual Dallas deals filtered by stage, owner, value range, or expected close " +
        "date, ordered by value (highest first). Returns a PAGE of at most 25 rows (max 100) plus " +
        "`totalMatching` (a real SQL count of ALL matching deals) and `truncated`. For a 'how many' " +
        "question use `totalMatching` (never the page length); for Won/pipeline counts prefer " +
        "get_pipeline_summary. Each row: dealNumber, name, stage, owner, value, expectedCloseDate, " +
        "wonClosedDate.",
      inputSchema: {
        stage: z
          .string()
          .optional()
          .describe(
            "Stage slug or name fragment (e.g. 'estimating'). The special value 'won' matches the " +
              "canonical Won family (consistent with get_pipeline_summary), not just the literal 'won' slug."
          ),
        owner: z.string().optional().describe("Rep name fragment (case-insensitive)."),
        minValue: z.number().optional().describe("Minimum deal value (USD)."),
        maxValue: z.number().optional().describe("Maximum deal value (USD)."),
        closeDateFrom: z.string().date().optional().describe("Earliest expected close date, YYYY-MM-DD."),
        closeDateTo: z.string().date().optional().describe("Latest expected close date, YYYY-MM-DD."),
        limit: z.number().int().optional().describe("Max rows (1-100, default 25)."),
      },
    },
    async (filters) => {
      const result = await withOfficeSchema(context.office, (db) => computeListDeals(db, filters));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
