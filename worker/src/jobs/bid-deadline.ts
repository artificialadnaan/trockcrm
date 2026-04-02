import { pool } from "../db.js";

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

        // Define countdown thresholds
        const thresholds: { days: number; title: string; priority: string }[] = [
          { days: 14, title: `Prepare final bid for ${deal.name}`, priority: "normal" },
          { days: 7, title: `Confirm bid submission for ${deal.name}`, priority: "high" },
          { days: 1, title: `BID DUE TOMORROW: ${deal.name}`, priority: "urgent" },
        ];

        for (const threshold of thresholds) {
          if (daysUntil !== threshold.days) continue;

          // Dedup: check if task with matching title already exists
          const existing = await client.query(
            `SELECT id FROM ${schemaName}.tasks
             WHERE deal_id = $1
               AND title = $2
               AND status IN ('pending', 'in_progress')
             LIMIT 1`,
            [deal.id, threshold.title]
          );

          if (existing.rows.length > 0) continue;

          await client.query(
            `INSERT INTO ${schemaName}.tasks
             (title, type, priority, status, assigned_to, deal_id, due_date, created_by)
             VALUES ($1, 'system', $2, 'pending', $3, $4, $5, $3)`,
            [threshold.title, threshold.priority, deal.assigned_rep_id, deal.id, deal.expected_close_date]
          );

          totalTasksCreated++;
        }
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
