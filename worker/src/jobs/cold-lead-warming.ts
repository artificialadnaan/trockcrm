import { pool } from "../db.js";

/**
 * Cold lead warming job.
 *
 * Runs daily at 6:15 AM CT (after daily task generation completes).
 * For each active office:
 * 1. Find contacts where last_contacted_at < NOW() - 60 days
 *    AND they have at least one active (non-terminal) deal
 * 2. Create a follow-up task assigned to the deal's rep
 * 3. Dedup: skip if an active task already exists for this contact
 */
export async function runColdLeadWarming(): Promise<void> {
  console.log("[Worker:cold-lead-warming] Starting cold lead warming scan...");

  const client = await pool.connect();
  try {
    const offices = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    let totalTasksCreated = 0;

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:cold-lead-warming] Invalid office slug: "${office.slug}" -- skipping`);
        continue;
      }
      const schemaName = `office_${office.slug}`;

      // Acquire advisory lock per office to prevent concurrent runs from racing
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('cold_lead_warming_' || $1))`,
        [office.slug]
      );

      // Find contacts with no contact in 60+ days that have active deals
      // NOTE: deals.stage_id is a UUID FK to public.pipeline_stage_config.
      //       We join to pipeline_stage_config and filter by is_terminal = false.
      //       deals has assigned_rep_id (not assigned_to).
      const coldLeads = await client.query(
        `SELECT DISTINCT ON (c.id)
           c.id AS contact_id,
           c.first_name,
           c.last_name,
           d.id AS deal_id,
           d.assigned_rep_id
         FROM ${schemaName}.contacts c
         JOIN ${schemaName}.contact_deal_associations cda ON cda.contact_id = c.id
         JOIN ${schemaName}.deals d ON d.id = cda.deal_id
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         WHERE (c.last_contacted_at IS NULL OR c.last_contacted_at < NOW() - INTERVAL '60 days')
           AND c.is_active = true
           AND d.is_active = true
           AND psc.is_terminal = false
           AND d.assigned_rep_id IS NOT NULL
         ORDER BY c.id, c.last_contacted_at ASC`
      );

      for (const lead of coldLeads.rows) {
        // Dedup: check if an active follow_up task already exists for this contact
        const existingTask = await client.query(
          `SELECT id FROM ${schemaName}.tasks
           WHERE contact_id = $1
             AND status IN ('pending', 'in_progress')
             AND type = 'follow_up'
           LIMIT 1`,
          [lead.contact_id]
        );

        if (existingTask.rows.length > 0) continue;

        const title = `Re-engage ${lead.first_name} ${lead.last_name} — no contact in 60+ days`;

        await client.query(
          `INSERT INTO ${schemaName}.tasks
           (title, type, priority, status, assigned_to, contact_id, deal_id, due_date, created_by)
           VALUES ($1, 'follow_up', 'normal', 'pending', $2, $3, $4, CURRENT_DATE, $2)`,
          [title, lead.assigned_rep_id, lead.contact_id, lead.deal_id]
        );

        totalTasksCreated++;
      }

      // Release the advisory lock by committing the transaction for this office
      await client.query("COMMIT");
    }

    console.log(`[Worker:cold-lead-warming] Complete. Created ${totalTasksCreated} cold lead warming tasks`);
  } catch (err) {
    console.error("[Worker:cold-lead-warming] Scan failed:", err);
    // Attempt rollback if we were mid-transaction
    try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}
