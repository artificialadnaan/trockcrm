import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "@trock-crm/shared/schema";
import type { McpAuthContext } from "../auth/contract.js";
import { withOfficeSchema, type TenantDb } from "../data/withOfficeSchema.js";
import { applyBaseDealFilters } from "../data/applyBaseDealFilters.js";
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

/**
 * Lists individual Dallas deals (reportable: applyBaseDealFilters) filtered by stage / owner /
 * value / close-date, newest-value first, bounded to 25 (max 100). Value is the raw awarded-first
 * headline estimate (awarded > bid_board > bid), so it reads sensibly across stages. All numbers and
 * filters are SQL; every filter value is bound as a parameter.
 */
export async function computeListDeals(db: TenantDb, filters: ListDealsFilters): Promise<DealRow[]> {
  const value = aliasedDealBestEstimateSql("d");
  const conds: SQL[] = [applyBaseDealFilters("d")];

  if (filters.stage) {
    conds.push(sql`(psc.slug = ${filters.stage} OR psc.name ILIKE ${"%" + filters.stage + "%"})`);
  }
  if (filters.owner) {
    conds.push(sql`u.display_name ILIKE ${"%" + filters.owner + "%"}`);
  }
  if (filters.minValue != null) conds.push(sql`${value} >= ${filters.minValue}`);
  if (filters.maxValue != null) conds.push(sql`${value} <= ${filters.maxValue}`);
  if (filters.closeDateFrom) conds.push(sql`d.expected_close_date >= ${filters.closeDateFrom}::date`);
  if (filters.closeDateTo) conds.push(sql`d.expected_close_date <= ${filters.closeDateTo}::date`);

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
      FROM ${deals} d
      JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
      LEFT JOIN ${users} u ON u.id = d.assigned_rep_id
      WHERE ${sql.join(conds, sql` AND `)}
      ORDER BY value DESC NULLS LAST, d.name ASC
      LIMIT ${limit}
    `)
  );

  return raw.map((r) => ({
    dealNumber: r.deal_number == null ? null : String(r.deal_number),
    name: r.name,
    stage: r.stage_name,
    owner: r.owner || (r.owner === "" ? "Unassigned" : r.owner),
    value: num(r.value),
    expectedCloseDate: r.expected_close_date == null ? null : String(r.expected_close_date).slice(0, 10),
    wonClosedDate: r.won_closed_date == null ? null : String(r.won_closed_date).slice(0, 10),
  }));
}

export function registerListDeals(server: McpServer, context: McpAuthContext): void {
  server.registerTool(
    "list_deals",
    {
      title: "List deals",
      description:
        "Lists individual Dallas deals filtered by stage, owner, value range, or expected close " +
        "date, ordered by value (highest first). Returns at most 25 rows (max 100). Each row: " +
        "dealNumber, name, stage, owner, value, expectedCloseDate, wonClosedDate.",
      inputSchema: {
        stage: z.string().optional().describe("Stage slug or name fragment (e.g. 'won', 'estimating')."),
        owner: z.string().optional().describe("Rep name fragment (case-insensitive)."),
        minValue: z.number().optional().describe("Minimum deal value (USD)."),
        maxValue: z.number().optional().describe("Maximum deal value (USD)."),
        closeDateFrom: z.string().optional().describe("Earliest expected close date, YYYY-MM-DD."),
        closeDateTo: z.string().optional().describe("Latest expected close date, YYYY-MM-DD."),
        limit: z.number().int().optional().describe("Max rows (1-100, default 25)."),
      },
    },
    async (filters) => {
      const rows = await withOfficeSchema(context.office, (db) => computeListDeals(db, filters));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: rows.length, rows }, null, 2) }],
      };
    }
  );
}
