import { sql, type SQL } from "drizzle-orm";
import { userCommissionSettings, users } from "@trock-crm/shared/schema";

/**
 * Shared commission POTENTIAL-rate SQL fragments used by BOTH the commission reporting service
 * (reporting-service.ts) and the dashboard (dashboard/service.ts). They live here — not duplicated in each —
 * so the estimator eligibility rule and the per-rep involved-rate CASE can never drift between the two and
 * desync the totals they report.
 *
 * CONTRACT: every fragment references the query aliases `d` (deals), `cs` (owner's user_commission_settings),
 * and `ecs`/`eu` (estimator's settings + user — see estimatorRateJoinSql). A caller must join `cs` on the
 * assigned rep and splice estimatorRateJoinSql() so `ecs`/`eu` resolve.
 */

/**
 * Per-rep involved POTENTIAL rate: the owner's rate when the rep OWNS the deal, else the estimator's rate when
 * the rep ESTIMATED it (and isn't also the owner), else 0. `repRef` may be a bound id string OR a raw SQL
 * expression (e.g. a lateral `involved.rep_id` in the dashboard's per-rep unnest).
 */
export function involvedPotentialRateSql(repRef: string | SQL): SQL {
  const rep = typeof repRef === "string" ? sql`${repRef}` : repRef;
  return sql`CASE
    WHEN d.assigned_rep_id = ${rep} THEN COALESCE(cs.commission_rate, 0)::numeric
    WHEN d.estimator_user_id = ${rep} AND d.assigned_rep_id IS DISTINCT FROM ${rep} THEN COALESCE(ecs.commission_rate, 0)::numeric
    ELSE 0::numeric
  END`;
}

/**
 * The estimator-settings join (aliased `ecs`), GATED so the estimator's potential rate only applies when the
 * estimator USER is active AND an internal CRM user (isCrmUserRole == role <> 'field_contractor') — mirroring
 * resolveAppliedRateForRole(…, "estimator") in the commission service. The `eu` (users) join carries that
 * predicate into the `ecs` join so ecs.commission_rate is NULL — and the COALESCE(ecs.commission_rate, 0) in
 * involvedPotentialRateSql (and reporting's office-wide additive arm) yields 0 — for a deactivated or
 * field_contractor estimator, matching the $0 they already EARN. `eu` is a LEFT JOIN so the driving deal row
 * is never dropped (deal_count / deal_value are unaffected).
 */
export function estimatorRateJoinSql(): SQL {
  return sql`LEFT JOIN ${users} eu ON eu.id = d.estimator_user_id
    LEFT JOIN ${userCommissionSettings} ecs ON ecs.user_id = d.estimator_user_id
      AND ecs.is_active = true AND eu.is_active = true AND eu.role <> 'field_contractor'`;
}
