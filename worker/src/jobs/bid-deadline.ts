import { pool } from "../db.js";

const SERVER_MODULE_ROOT =
  process.env.NODE_ENV === "production" ? "../../../server/dist/modules" : "../../../server/src/modules";
const SERVER_EVALUATOR_MODULE = `${SERVER_MODULE_ROOT}/tasks/rules/evaluator.js` as string;
const SERVER_TASK_RULES_MODULE = `${SERVER_MODULE_ROOT}/tasks/rules/config.js` as string;
const SERVER_TASK_PERSISTENCE_MODULE = `${SERVER_MODULE_ROOT}/tasks/rules/persistence.js` as string;

/**
 * Bid deadline countdown job.
 *
 * Runs daily at 6:30 AM CT. For each active office:
 * 1. Find deals with expected_close_date set, in 'estimating' or 'bid_sent' stage
 * 2. Create countdown tasks at 14-day, 7-day, and 1-day thresholds
 * 3. Dedup: check if task with matching title already exists for this deal
 * 4. Auto-dismiss countdown tasks if deal has moved past Bid Sent stage
 */
export async function runBidDeadlineCountdown(): Promise<void> {
  console.log("[Worker:bid-deadline] Starting bid deadline countdown scan...");

  const client = await pool.connect();
  try {
    const offices = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    let totalTasksCreated = 0;
    let totalTasksDismissed = 0;

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:bid-deadline] Invalid office slug: "${office.slug}" -- skipping`);
        continue;
      }
      const schemaName = `office_${office.slug}`;
      const [{ evaluateTaskRules }, { TASK_RULES }, { createTenantTaskRulePersistence }] = (await Promise.all([
        import(SERVER_EVALUATOR_MODULE),
        import(SERVER_TASK_RULES_MODULE),
        import(SERVER_TASK_PERSISTENCE_MODULE),
      ])) as any;
      const taskPersistence = createTenantTaskRulePersistence(client, schemaName);

      // Acquire advisory lock per office to prevent concurrent runs from racing
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('bid_deadline_countdown_' || $1))`,
        [office.slug]
      );

      // Auto-dismiss: find countdown tasks for deals no longer in estimating/bid_sent
      // NOTE: deals.stage_id is a UUID FK to public.pipeline_stage_config.
      //       We join to pipeline_stage_config and filter by slug.
      const dismissResult = await client.query(
        `UPDATE ${schemaName}.tasks t
         SET status = 'dismissed', completed_at = NOW()
         FROM ${schemaName}.deals d
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         WHERE t.deal_id = d.id
           AND t.type = 'system'
           AND t.status IN ('pending', 'in_progress')
           AND (t.title LIKE 'BID DUE%' OR t.title LIKE 'Prepare final bid%' OR t.title LIKE 'Confirm bid submission%')
           AND psc.slug NOT IN ('estimating', 'bid_sent')`
      );
      totalTasksDismissed += dismissResult.rowCount ?? 0;

      // Find deals with upcoming bid deadlines
      // NOTE: stage_id is a UUID FK; join to pipeline_stage_config for slug filtering.
      //       assigned_rep_id is the correct column (not assigned_to).
      const deals = await client.query(
        `SELECT d.id, d.name, d.expected_close_date, d.assigned_rep_id
         FROM ${schemaName}.deals d
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         WHERE d.expected_close_date IS NOT NULL
           AND psc.slug IN ('estimating', 'bid_sent')
           AND d.is_active = true
           AND d.assigned_rep_id IS NOT NULL
           AND d.expected_close_date > CURRENT_DATE`
      );

      for (const deal of deals.rows) {
        const closeDate = new Date(deal.expected_close_date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const daysUntil = Math.ceil((closeDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        const outcomes = await evaluateTaskRules(
          {
            now: new Date(),
            officeId: office.id,
            entityId: `deal:${deal.id}`,
            sourceEvent: "cron.bid_deadline",
            dealId: deal.id,
            dealName: deal.name,
            dealOwnerId: deal.assigned_rep_id,
            dueAt: deal.expected_close_date,
            daysUntil,
          },
          taskPersistence,
          TASK_RULES
        );

        totalTasksCreated += outcomes.filter((outcome: any) => outcome.action === "created" || outcome.action === "updated").length;
      }

      // Release the advisory lock by committing the transaction for this office
      await client.query("COMMIT");
    }

    console.log(`[Worker:bid-deadline] Complete. Created ${totalTasksCreated} countdown tasks, dismissed ${totalTasksDismissed} stale countdown tasks`);
  } catch (err) {
    console.error("[Worker:bid-deadline] Scan failed:", err);
    // Attempt rollback if we were mid-transaction
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}
