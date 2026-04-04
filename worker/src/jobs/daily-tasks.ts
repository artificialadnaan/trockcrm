import { pool } from "../db.js";

/**
 * Daily task list generation job.
 *
 * Runs daily at 6:00 AM CT. For each active office:
 * 1. Mark overdue tasks: any pending/in_progress task with due_date < today
 * 2. Create follow-up tasks for deals with upcoming expected_close_date (7 days out)
 * 3. Create touchpoint tasks for contacts with first_outreach_completed = false (older than 3 days)
 * 4. Create follow-up tasks for contacts overdue on their stage's touchpoint_cadence_days
 *
 * Stale deal tasks and inbound email tasks are already created by their respective
 * workers (stale-deals.ts and email-sync.ts). This job handles the remaining
 * automated task types.
 */
export async function runDailyTaskGeneration(): Promise<void> {
  console.log("[Worker:daily-tasks] Starting daily task generation...");

  const client = await pool.connect();
  try {
    // Get all active offices
    const offices = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    let totalTasksCreated = 0;
    let totalOverdueMarked = 0;

    for (const office of offices.rows) {
      try {
        let officeTasksCreated = 0;
        let officeOverdueMarked = 0;

        // Acquire advisory lock per office to prevent concurrent runs from racing
        await client.query("BEGIN");
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext('daily_task_generation_' || $1))`,
          [office.id]
        );
        const slugRegex = /^[a-z][a-z0-9_]*$/;
        if (!slugRegex.test(office.slug)) {
          console.error(`[Worker:daily-tasks] Invalid office slug: "${office.slug}" -- skipping`);
          await client.query("ROLLBACK");
          continue;
        }
        const schemaName = `office_${office.slug}`;

        // Step 1: Mark overdue tasks as is_overdue AND escalate to 'urgent' priority
        // Per spec: the daily job should mark existing overdue tasks as urgent priority
        // if they aren't already, so the task list surfaces them prominently.
        // Stale-deal and email-sync workers already CREATE those tasks; this job
        // just ensures they are flagged correctly.
        const overdueResult = await client.query(
          `UPDATE ${schemaName}.tasks
           SET is_overdue = true,
               priority = CASE WHEN priority != 'urgent' THEN 'urgent' ELSE priority END
           WHERE status IN ('pending', 'in_progress')
             AND due_date < CURRENT_DATE
             AND (is_overdue = false OR priority != 'urgent')`
        );
        officeOverdueMarked += overdueResult.rowCount ?? 0;

        // Create notifications for assignees of overdue tasks (dedup: one per task per day)
        // Dedup: body contains [task:{uuid}] marker. This is a text-based dedup strategy.
        // TODO: Add a dedup_key column to notifications for robust dedup.
        await client.query(
          `INSERT INTO ${schemaName}.notifications (type, title, body, user_id, is_read)
           SELECT 'system',
                  'Overdue Task',
                  'Task "' || t.title || '" is overdue (due ' || t.due_date::text || ') [task:' || t.id::text || ']',
                  t.assigned_to,
                  false
           FROM ${schemaName}.tasks t
           WHERE t.is_overdue = true
             AND t.status IN ('pending', 'in_progress')
             AND t.assigned_to IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM ${schemaName}.notifications n
               WHERE n.user_id = t.assigned_to
                 AND n.type = 'system'
                 AND n.body LIKE '%[task:' || t.id::text || ']%'
                 AND n.created_at >= CURRENT_DATE
             )`
        );

        // Step 2: Create follow-up tasks for deals with expected_close_date within 7 days
        // Only for deals that don't already have an active follow_up task
        const upcomingDeals = await client.query(
          `SELECT d.id AS deal_id, d.name AS deal_name, d.deal_number,
                  d.assigned_rep_id, d.expected_close_date
           FROM ${schemaName}.deals d
           WHERE d.is_active = true
             AND d.expected_close_date IS NOT NULL
             AND d.expected_close_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
             AND NOT EXISTS (
               SELECT 1 FROM ${schemaName}.tasks t
               WHERE t.deal_id = d.id
                 AND t.type = 'follow_up'
                 AND t.status IN ('pending', 'in_progress')
             )`
        );

        for (const deal of upcomingDeals.rows) {
          await client.query(
            `INSERT INTO ${schemaName}.tasks
             (title, description, type, priority, status, assigned_to, deal_id, due_date)
             VALUES ($1, $2, 'follow_up', 'high', 'pending', $3, $4, $5)`,
            [
              `Follow up: ${deal.deal_number} closes ${deal.expected_close_date}`,
              `${deal.deal_name} has an expected close date of ${deal.expected_close_date}. Ensure all pre-close tasks are complete.`,
              deal.assigned_rep_id,
              deal.deal_id,
              deal.expected_close_date,
            ]
          );
          officeTasksCreated++;
        }

        // Step 3: Create touchpoint tasks for contacts needing first outreach
        // Only contacts older than 3 days without outreach and no active touchpoint task
        const needsOutreach = await client.query(
          `SELECT c.id AS contact_id, c.first_name, c.last_name
           FROM ${schemaName}.contacts c
           WHERE c.is_active = true
             AND c.first_outreach_completed = false
             AND c.created_at < CURRENT_DATE - INTERVAL '3 days'
             AND NOT EXISTS (
               SELECT 1 FROM ${schemaName}.tasks t
               WHERE t.contact_id = c.id
                 AND t.type = 'touchpoint'
                 AND t.status IN ('pending', 'in_progress')
             )`
        );

        // Assign touchpoint tasks to the rep who has the most deals with this contact,
        // or fall back to the first active rep in the office
        for (const contact of needsOutreach.rows) {
          const repResult = await client.query(
            `SELECT cda.deal_id, d.assigned_rep_id
             FROM ${schemaName}.contact_deal_associations cda
             JOIN ${schemaName}.deals d ON d.id = cda.deal_id AND d.is_active = true
             WHERE cda.contact_id = $1
             ORDER BY d.created_at DESC
             LIMIT 1`,
            [contact.contact_id]
          );

          let assignedTo: string | null = repResult.rows[0]?.assigned_rep_id ?? null;

          // Fallback: first active rep in this office
          if (!assignedTo) {
            const fallbackRep = await client.query(
              `SELECT id FROM public.users
               WHERE office_id = $1 AND role = 'rep' AND is_active = true
               LIMIT 1`,
              [office.id]
            );
            assignedTo = fallbackRep.rows[0]?.id ?? null;
          }

          if (!assignedTo) continue; // No rep available

          await client.query(
            `INSERT INTO ${schemaName}.tasks
             (title, type, priority, status, assigned_to, contact_id, due_date)
             VALUES ($1, 'touchpoint', 'normal', 'pending', $2, $3, CURRENT_DATE)`,
            [
              `First outreach needed: ${contact.first_name} ${contact.last_name}`,
              assignedTo,
              contact.contact_id,
            ]
          );
          officeTasksCreated++;

          // Create a touchpoint_alert notification for the assigned rep.
          // The body embeds the contact_id so the dedup LIKE check is reliable.
          // Dedup: skip if a touchpoint_alert for this contact already exists today.
          await client.query(
            `INSERT INTO ${schemaName}.notifications
             (type, title, body, user_id, is_read)
             SELECT 'touchpoint_alert',
                    'Contact Needs Outreach',
                    $1,
                    $2,
                    false
             WHERE NOT EXISTS (
               SELECT 1 FROM ${schemaName}.notifications
               WHERE type = 'touchpoint_alert'
                 AND user_id = $2
                 AND body LIKE $3
                 AND created_at >= CURRENT_DATE
             )`,
            [
              `New contact ${contact.first_name} ${contact.last_name} has not received first outreach. [contact:${contact.contact_id}]`,
              assignedTo,
              `%[contact:${contact.contact_id}]%`,
            ]
          );
        }

        // Step 4: Create follow-up tasks for contacts behind their touchpoint cadence.
        // Finds contacts on active deals where last_contacted_at is overdue per the
        // stage's touchpoint_cadence_days. Skips contacts that already have a pending
        // cadence follow_up task for the same deal.
        // NOTE: public.pipeline_stage_config is fully qualified because search_path
        // is set to the tenant schema inside the transaction.
        const overdueContacts = await client.query(
          `SELECT c.id AS contact_id, c.first_name, c.last_name, c.last_contacted_at,
                  d.id AS deal_id, d.deal_number, d.name AS deal_name,
                  d.assigned_rep_id, psc.touchpoint_cadence_days
           FROM ${schemaName}.contacts c
           JOIN ${schemaName}.contact_deal_associations cda ON cda.contact_id = c.id
           JOIN ${schemaName}.deals d ON d.id = cda.deal_id AND d.is_active = true
           JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
           WHERE c.is_active = true
             AND psc.touchpoint_cadence_days IS NOT NULL
             AND (
               c.last_contacted_at IS NULL
               OR c.last_contacted_at < CURRENT_DATE - psc.touchpoint_cadence_days * INTERVAL '1 day'
             )
             AND NOT EXISTS (
               SELECT 1 FROM ${schemaName}.tasks t
               WHERE t.deal_id = d.id
                 AND t.type = 'follow_up'
                 AND t.status = 'pending'
                 AND t.description LIKE '%touchpoint cadence%'
             )`
        );

        for (const row of overdueContacts.rows) {
          const lastContactText = row.last_contacted_at
            ? new Date(row.last_contacted_at).toISOString().split("T")[0]
            : "Never";
          await client.query(
            `INSERT INTO ${schemaName}.tasks
             (type, title, description, priority, status, assigned_to, deal_id, due_date)
             VALUES ('follow_up', $1, $2, 'normal', 'pending', $3, $4, CURRENT_DATE)`,
            [
              `Contact Follow-Up: ${row.first_name} ${row.last_name}`,
              `Touchpoint cadence overdue for ${row.first_name} ${row.last_name} on deal ${row.deal_number}. Last contact: ${lastContactText}`,
              row.assigned_rep_id,
              row.deal_id,
            ]
          );
          officeTasksCreated++;
        }

        // Release the advisory lock by committing the transaction for this office
        await client.query("COMMIT");
        totalOverdueMarked += officeOverdueMarked;
        totalTasksCreated += officeTasksCreated;
      } catch (officeErr) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`[Worker:daily-tasks] Office ${office.id} failed:`, officeErr);
      }
    }

    console.log(`[Worker:daily-tasks] Complete. Marked ${totalOverdueMarked} overdue, created ${totalTasksCreated} new tasks`);
  } catch (err) {
    console.error("[Worker:daily-tasks] Failed:", err);
    throw err;
  } finally {
    client.release();
  }
}
