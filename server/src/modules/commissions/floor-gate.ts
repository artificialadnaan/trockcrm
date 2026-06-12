import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  dealSignedCommissions,
  deals,
  pipelineStageConfig,
  userCommissionSettings,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { aliasedActiveDealCountFilterSql } from "../shared/deal-value-sql.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface RepEarnedFloorGate {
  /**
   * The rep's booked SIGNED book — SUM of source value (awarded_amount → bid_estimate → dd_estimate,
   * matching the commission writer's resolver) over deals the rep OWNS (assigned_rep_id) that are signed,
   * non-lost, non-on-hold, non-test, in the period. This is what the floor gates against.
   *
   * Deliberately OWNER-based, NOT commission-attribution (dsc.rep_user_id): HubSpot-imported signed deals
   * often have contract_signed_date set without ever running calculateCommissionForDeal, so they carry no
   * commission row — dsc-attributed revenue badly undercounts an owner-rep's real book (e.g. an owner with
   * a ~$300k signed book but only two change-order commission rows). The floor is a hurdle on the book.
   */
  qualifyingRevenue: number;
  /**
   * SUM(amount) of the commission rows attributed to the rep (dsc.rep_user_id) over the same period — the
   * earned commission the gate RELEASES (when met) or HOLDS at $0 (when below floor).
   */
  earnedCommission: number;
  /** The rep's stored commission floor (user_commission_settings.rolling_floor). */
  floor: number;
  /** True when qualifyingRevenue >= floor (exact-equal passes). Below floor => earned gates to $0. */
  met: boolean;
}

/**
 * Single source of truth for the commission FLOOR GATE.
 *
 * The floor is a per-period GATE, not a deductible: while the rep's booked signed book (qualifyingRevenue)
 * is below their stored floor, earned commission is $0 everywhere; once it reaches the floor (exact-equal
 * passes), the FULL earned amount is recognized from dollar one — nothing below the floor is subtracted.
 *
 * BOTH aggregation engines (getRepCommissionDashboard and getRepCommissionSummary) and the manager-override
 * roll-up route their floor check through THIS function — there is exactly one floor check, so the surfaces
 * cannot drift. `qualifyingRevenue` (owner book) drives `met`; `earnedCommission` (dsc attribution) is what
 * gets released or held. Both use the SAME period window.
 *
 * An INACTIVE commission config is treated as NO floor (floor 0 => always met), matching how
 * getRepCommissionSummary zeroes rollingFloor for inactive configs — a disabled config with a stale
 * non-zero rolling_floor must not gate earned rows. The floor is returned even when the rep owns no deals.
 */
export async function computeRepEarnedFloorGate(
  tenantDb: TenantDb,
  repId: string,
  dateRange: { from: string | null; to: string | null }
): Promise<RepEarnedFloorGate> {
  // Owner-book signed date (no commission row to fall back on); earned uses the dsc fallback to match how
  // the earned surfaces date their rows (earnedSignedDateSql / dashboardEarnedSignedDateSql).
  const ownedSignedDate = sql`COALESCE(d.contract_signed_at::date, d.contract_signed_date)`;
  const earnedSignedDate = sql`COALESCE(d.contract_signed_at::date, d.contract_signed_date, dsc.contract_signed_date_at_signing)`;
  const notLost = sql`psc.slug NOT IN ('lost', 'production_lost', 'service_lost', 'closed_lost')`;

  const result = await tenantDb.execute(sql`
    SELECT
      COALESCE((
        SELECT SUM(COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0))
        FROM ${deals} d
        JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
        WHERE d.assigned_rep_id = ${repId}
          AND COALESCE(d.is_test_data, false) = false
          AND (d.contract_signed_at IS NOT NULL OR d.contract_signed_date IS NOT NULL)
          AND ${notLost}
          AND ${aliasedActiveDealCountFilterSql("d")}
          ${dateRange.from ? sql`AND ${ownedSignedDate} >= ${dateRange.from}::date` : sql``}
          ${dateRange.to ? sql`AND ${ownedSignedDate} <= ${dateRange.to}::date` : sql``}
      ), 0)::numeric AS qualifying_revenue,
      COALESCE((
        SELECT SUM(dsc.amount)
        FROM ${dealSignedCommissions} dsc
        JOIN ${deals} d ON d.id = dsc.deal_id
        JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
        WHERE dsc.rep_user_id = ${repId}
          AND COALESCE(d.is_test_data, false) = false
          AND ${earnedSignedDate} IS NOT NULL
          AND ${notLost}
          AND ${aliasedActiveDealCountFilterSql("d")}
          ${dateRange.from ? sql`AND ${earnedSignedDate} >= ${dateRange.from}::date` : sql``}
          ${dateRange.to ? sql`AND ${earnedSignedDate} <= ${dateRange.to}::date` : sql``}
      ), 0)::numeric AS earned_commission,
      COALESCE((
        SELECT cs.rolling_floor FROM ${userCommissionSettings} cs
        WHERE cs.user_id = ${repId} AND COALESCE(cs.is_active, true) = true
      ), 0)::numeric AS floor
  `);
  const rows = (result as any).rows ?? result;
  const row = rows[0] ?? {};
  const qualifyingRevenue = Number(Number(row.qualifying_revenue ?? 0).toFixed(2));
  const earnedCommission = Number(Number(row.earned_commission ?? 0).toFixed(2));
  const floor = Number(Number(row.floor ?? 0).toFixed(2));
  return {
    qualifyingRevenue,
    earnedCommission,
    floor,
    met: qualifyingRevenue >= floor,
  };
}
