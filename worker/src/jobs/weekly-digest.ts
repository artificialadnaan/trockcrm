import { getDealAtRiskResult, reportableDealSqlPredicate, type WorkflowRoute } from "@trock-crm/shared/types";
import { pool } from "../db.js";

const SERVER_MODULE_ROOT =
  process.env.NODE_ENV === "production" ? "../../../server/dist/modules" : "../../../server/src/modules";
const SERVER_EVALUATOR_MODULE = `${SERVER_MODULE_ROOT}/tasks/rules/evaluator.js` as string;
const SERVER_TASK_RULES_MODULE = `${SERVER_MODULE_ROOT}/tasks/rules/config.js` as string;
const SERVER_TASK_PERSISTENCE_MODULE = `${SERVER_MODULE_ROOT}/tasks/rules/persistence.js` as string;
const REPORTABLE_DEAL_SQL = reportableDealSqlPredicate("d");

async function loadTaskRuleDependencies() {
  const [{ evaluateTaskRules }, { TASK_RULES }, { createTenantTaskRulePersistence }] = (await Promise.all([
    import(SERVER_EVALUATOR_MODULE),
    import(SERVER_TASK_RULES_MODULE),
    import(SERVER_TASK_PERSISTENCE_MODULE),
  ])) as any;

  return { evaluateTaskRules, TASK_RULES, createTenantTaskRulePersistence };
}

interface DigestAtRiskDealRow {
  stage_slug: string | null;
  workflow_route: string | null;
  stage_entered_at: string | Date | null;
  on_hold: boolean | null;
  on_hold_started_at: string | Date | null;
  on_hold_accumulated_seconds: string | number | bigint | null;
  on_hold_accumulated_seconds_at_stage_entry: string | number | bigint | null;
}

function normalizeWorkflowRoute(value: string | null | undefined): WorkflowRoute {
  return value === "service" ? "service" : "normal";
}

function numberOrNull(value: string | number | bigint | null | undefined) {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function countDigestAtRiskDeals(rows: DigestAtRiskDealRow[], now: Date): number {
  let count = 0;

  for (const row of rows) {
    const atRisk = getDealAtRiskResult(
      {
        stageSlug: row.stage_slug,
        workflowRoute: normalizeWorkflowRoute(row.workflow_route),
        stageEnteredAt: row.stage_entered_at,
        onHold: row.on_hold,
        onHoldStartedAt: row.on_hold_started_at,
        onHoldAccumulatedSeconds: numberOrNull(row.on_hold_accumulated_seconds),
        onHoldAccumulatedSecondsAtStageEntry: numberOrNull(
          row.on_hold_accumulated_seconds_at_stage_entry
        ),
      },
      "rep",
      now
    );

    if (atRisk.isAtRisk) count += 1;
  }

  return count;
}

/**
 * Generates a weekly digest task for each director/admin in every active office.
 *
 * Runs Monday at 7am CT via cron. Per-office with advisory lock to prevent
 * duplicate runs in multi-worker deployments.
 *
 * Stats included:
 * - Stale deals (shared hold-aware At Risk engine, rep audience)
 * - Deals approaching deadline (expected_close_date within next 7 days)
 * - New deals this week (created_at >= NOW() - 7 days)
 * - Total active pipeline value (SUM of awarded_amount or bid_estimate, non-terminal)
 */
export async function runWeeklyDigest(): Promise<void> {
  console.log("[Worker:weekly-digest] Starting weekly digest generation...");

  const client = await pool.connect();
  try {
    // Get all active offices
    const offices = await client.query(
      "SELECT id, slug, name FROM public.offices WHERE is_active = true"
    );

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:weekly-digest] Invalid office slug: "${office.slug}" — skipping`);
        continue;
      }

      const schemaName = `office_${office.slug}`;

      // Advisory lock per office to prevent duplicate digest runs
      const lockId = Buffer.from(office.id.replace(/-/g, "").slice(0, 8), "hex").readUInt32BE(0);
      const lockResult = await client.query(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [lockId]
      );

      if (!lockResult.rows[0]?.acquired) {
        console.log(`[Worker:weekly-digest] Could not acquire lock for office ${office.slug} — skipping`);
        continue;
      }

      try {
        await client.query("BEGIN");

        // 1. Stale deals count, using the shared hold-aware At Risk engine.
        const atRiskDealRows = await client.query(
          `SELECT
             COALESCE(d.bid_board_stage_slug, psc.slug) AS stage_slug,
             d.workflow_route,
             COALESCE(
               d.bid_board_stage_entered_at,
               d.stage_entered_at,
               latest_current_stage_entered_at.entered_at
             ) AS stage_entered_at,
             d.on_hold,
             d.on_hold_started_at,
             d.on_hold_accumulated_seconds,
             d.on_hold_accumulated_seconds_at_stage_entry
           FROM ${schemaName}.deals d
           JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
           LEFT JOIN LATERAL (
             SELECT dsh.entered_at
             FROM ${schemaName}.deal_stage_history dsh
             WHERE dsh.deal_id = d.id
               AND dsh.to_stage_id = d.stage_id
             ORDER BY dsh.entered_at DESC NULLS LAST, dsh.created_at DESC
             LIMIT 1
           ) latest_current_stage_entered_at ON true
           WHERE d.is_active = true
             AND psc.is_terminal = false
             AND ${REPORTABLE_DEAL_SQL}
             AND COALESCE(d.is_test_data, false) = false`
        );
        const staleCount = countDigestAtRiskDeals(atRiskDealRows.rows, new Date());

        // 2. Deals approaching deadline (expected_close_date within next 7 days)
        const approachingRes = await client.query(
          `SELECT COUNT(*) AS count
           FROM ${schemaName}.deals d
           JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
           WHERE d.is_active = true
             AND psc.is_terminal = false
             AND d.expected_close_date IS NOT NULL
             AND ${REPORTABLE_DEAL_SQL}
             AND d.expected_close_date BETWEEN CURRENT_DATE AND CURRENT_DATE + interval '7 days'`
        );
        const approachingCount = Number(approachingRes.rows[0]?.count ?? 0);

        // 3. New deals this week
        const newDealsRes = await client.query(
          `SELECT COUNT(*) AS count
           FROM ${schemaName}.deals d
           WHERE d.is_active = true
             AND ${REPORTABLE_DEAL_SQL}
             AND d.created_at >= NOW() - interval '7 days'`
        );
        const newDealsCount = Number(newDealsRes.rows[0]?.count ?? 0);

        // 4. Total active pipeline value
        const valueRes = await client.query(
          `SELECT COALESCE(SUM(COALESCE(d.awarded_amount, d.bid_estimate, 0)), 0) AS total_value
           FROM ${schemaName}.deals d
           JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
           WHERE d.is_active = true
             AND ${REPORTABLE_DEAL_SQL}
             AND psc.is_terminal = false`
        );
        const totalValue = Number(valueRes.rows[0]?.total_value ?? 0);
        // Find all directors/admins in this office
        const directors = await client.query(
          `SELECT id FROM public.users
           WHERE office_id = $1 AND role IN ('director', 'admin') AND is_active = true`,
          [office.id]
        );

        if (directors.rows.length === 0) {
          console.log(`[Worker:weekly-digest] No directors/admins in office ${office.slug} — skipping`);
          await client.query("COMMIT");
          continue;
        }

        const { evaluateTaskRules, TASK_RULES, createTenantTaskRulePersistence } = await loadTaskRuleDependencies();
        const taskPersistence = createTenantTaskRulePersistence(client, schemaName);
        let createdCount = 0;

        for (const director of directors.rows) {
          const outcomes = await evaluateTaskRules(
            {
              now: new Date(),
              officeId: office.id,
              officeName: office.name,
              entityId: `office:${office.id}`,
              sourceEvent: "cron.weekly_digest",
              taskAssigneeId: director.id,
              staleCount,
              approachingCount,
              newDealsCount,
              pipelineValue: totalValue,
            },
            taskPersistence,
            TASK_RULES
          );
          createdCount += outcomes.filter((outcome: { action: string }) => outcome.action === "created").length;
        }

        await client.query("COMMIT");
        console.log(`[Worker:weekly-digest] Digest created for office ${office.slug}: ${createdCount} task(s)`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`[Worker:weekly-digest] Error for office ${office.slug}:`, err);
      } finally {
        // Release advisory lock
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => {});
      }
    }

    console.log("[Worker:weekly-digest] Weekly digest generation complete.");
  } catch (err) {
    console.error("[Worker:weekly-digest] Fatal error:", err);
    throw err;
  } finally {
    client.release();
  }
}
