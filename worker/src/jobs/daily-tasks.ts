import { pool } from "../db.js";

const SERVER_EVALUATOR_MODULE = "../../../server/src/modules/tasks/rules/evaluator.js" as string;
const SERVER_TASK_RULES_MODULE = "../../../server/src/modules/tasks/rules/config.js" as string;
const SERVER_TASK_PERSISTENCE_MODULE = "../../../server/src/modules/tasks/rules/persistence.js" as string;

/**
 * Daily task list generation job.
 *
 * Runs daily at 6:00 AM CT. For each active office:
 * 1. Mark overdue tasks: any pending/in_progress task with due_date < today
 * 2. Create follow-up tasks for deals with upcoming expected_close_date (7 days out)
 * 3. Create touchpoint tasks for contacts with first_outreach_completed = false (older than 3 days)
 * 4. Create follow-up tasks for contacts overdue on their stage's touchpoint_cadence_days
 * 5. Create follow-up tasks for leads stuck past their configured stage stale threshold
 *
 * Stale deal tasks and inbound email tasks are already created by their respective
 * workers (stale-deals.ts and email-sync.ts). This job handles the remaining
 * automated task types.
 */
async function loadTaskRuleDependencies() {
  const [{ evaluateTaskRules }, { TASK_RULES }, { createTenantTaskRulePersistence }] = (await Promise.all([
    import(SERVER_EVALUATOR_MODULE),
    import(SERVER_TASK_RULES_MODULE),
    import(SERVER_TASK_PERSISTENCE_MODULE),
  ])) as any;

  return { evaluateTaskRules, TASK_RULES, createTenantTaskRulePersistence };
}

function countGeneratedTasks(outcomes: Array<{ action: string }>) {
  return outcomes.filter((outcome) => outcome.action === "created").length;
}

type Queryable = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
};

export async function dismissResolvedStaleLeadTasks(
  client: Queryable,
  schemaName: string,
  officeId: string,
  activeStaleLeadIds: string[],
  resolvedAt: Date = new Date()
): Promise<number> {
  const activeDedupeKeys = activeStaleLeadIds.map((leadId) => `lead:${leadId}`);
  const activeTaskStatusesSql = ["pending", "scheduled", "in_progress", "waiting_on", "blocked"]
    .map((status) => `'${status}'`)
    .join(", ");

  const dismissalWhereClause = activeDedupeKeys.length > 0
    ? `AND dedupe_key <> ALL($2::text[])`
    : "";
  const dismissalParams: unknown[] = activeDedupeKeys.length > 0
    ? [resolvedAt, activeDedupeKeys]
    : [resolvedAt];

  const dismissedTasks = await client.query<{
    id: string;
    origin_rule: string;
    dedupe_key: string;
    reason_code: string | null;
    entity_snapshot: Record<string, unknown> | null;
  }>(
    `UPDATE ${schemaName}.tasks
     SET status = 'dismissed',
         completed_at = $1,
         is_overdue = false,
         waiting_on = NULL,
         blocked_by = NULL,
         updated_at = NOW()
     WHERE origin_rule = 'stale_lead'
       AND status IN (${activeTaskStatusesSql})
       ${dismissalWhereClause}
     RETURNING id, origin_rule, dedupe_key, reason_code, entity_snapshot`,
    dismissalParams
  );

  if ((dismissedTasks.rows?.length ?? 0) === 0) {
    return dismissedTasks.rowCount ?? 0;
  }

  for (const task of dismissedTasks.rows) {
    await client.query(
      `INSERT INTO ${schemaName}.task_resolution_state
         (office_id, task_id, origin_rule, dedupe_key, resolution_status, resolution_reason, resolved_at, suppressed_until, entity_snapshot)
       VALUES ($1, $2, $3, $4, 'dismissed', $5, $6, NULL, $7)
       ON CONFLICT (origin_rule, dedupe_key) DO UPDATE
       SET office_id = EXCLUDED.office_id,
           task_id = EXCLUDED.task_id,
           resolution_status = EXCLUDED.resolution_status,
           resolution_reason = EXCLUDED.resolution_reason,
           resolved_at = EXCLUDED.resolved_at,
           suppressed_until = EXCLUDED.suppressed_until,
           entity_snapshot = EXCLUDED.entity_snapshot,
           updated_at = NOW()`,
      [
        officeId,
        task.id,
        task.origin_rule,
        task.dedupe_key,
        "lead_no_longer_stale",
        resolvedAt,
        task.entity_snapshot ?? null,
      ]
    );
  }

  return dismissedTasks.rowCount ?? dismissedTasks.rows.length;
}

export async function runDailyTaskGeneration(): Promise<void> {
  console.log("[Worker:daily-tasks] Starting daily task generation...");

  const client = await pool.connect();
  try {
    const offices = await client.query("SELECT id, slug FROM public.offices WHERE is_active = true");

    let totalTasksCreated = 0;
    let totalOverdueMarked = 0;

    for (const office of offices.rows) {
      try {
        let officeTasksCreated = 0;
        let officeOverdueMarked = 0;

        await client.query("BEGIN");
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('daily_task_generation_' || $1))`, [office.id]);

        const slugRegex = /^[a-z][a-z0-9_]*$/;
        if (!slugRegex.test(office.slug)) {
          console.error(`[Worker:daily-tasks] Invalid office slug: "${office.slug}" -- skipping`);
          await client.query("ROLLBACK");
          continue;
        }

        const schemaName = `office_${office.slug}`;
        const { evaluateTaskRules, TASK_RULES, createTenantTaskRulePersistence } = await loadTaskRuleDependencies();
        const taskPersistence = createTenantTaskRulePersistence(client, schemaName);

        const overdueResult = await client.query(
          `UPDATE ${schemaName}.tasks
           SET is_overdue = true,
               priority = CASE WHEN priority != 'urgent' THEN 'urgent' ELSE priority END
           WHERE status IN ('pending', 'in_progress')
             AND due_date < CURRENT_DATE
             AND (is_overdue = false OR priority != 'urgent')`
        );
        officeOverdueMarked += overdueResult.rowCount ?? 0;

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
          const outcomes = await evaluateTaskRules(
            {
              now: new Date(),
              officeId: office.id,
              entityId: `deal:${deal.deal_id}`,
              sourceEvent: "cron.daily_task_generation.close_date_follow_up",
              dealId: deal.deal_id,
              dealName: deal.deal_name,
              dealNumber: deal.deal_number,
              dealOwnerId: deal.assigned_rep_id,
              taskAssigneeId: deal.assigned_rep_id,
              dueAt: deal.expected_close_date,
            },
            taskPersistence,
            TASK_RULES
          );
          officeTasksCreated += countGeneratedTasks(outcomes);
        }

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

          if (!assignedTo) {
            const fallbackRep = await client.query(
              `SELECT id FROM public.users
               WHERE office_id = $1 AND role = 'rep' AND is_active = true
               LIMIT 1`,
              [office.id]
            );
            assignedTo = fallbackRep.rows[0]?.id ?? null;
          }

          if (!assignedTo) continue;

          const outcomes = await evaluateTaskRules(
            {
              now: new Date(),
              officeId: office.id,
              entityId: `contact:${contact.contact_id}`,
              sourceEvent: "cron.daily_task_generation.first_outreach_touchpoint",
              contactId: contact.contact_id,
              contactName: `${contact.first_name} ${contact.last_name}`,
              taskAssigneeId: assignedTo,
              dueAt: new Date(),
            },
            taskPersistence,
            TASK_RULES
          );
          const createdTouchpoint = outcomes.some((outcome: { action: string }) => outcome.action === "created");
          officeTasksCreated += countGeneratedTasks(outcomes);

          if (createdTouchpoint) {
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
        }

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
          const outcomes = await evaluateTaskRules(
            {
              now: new Date(),
              officeId: office.id,
              entityId: `contact:${row.contact_id}`,
              sourceEvent: "cron.daily_task_generation.cadence_overdue_follow_up",
              contactId: row.contact_id,
              contactName: `${row.first_name} ${row.last_name}`,
              dealId: row.deal_id,
              dealName: row.deal_name,
              dealNumber: row.deal_number,
              dealOwnerId: row.assigned_rep_id,
              taskAssigneeId: row.assigned_rep_id,
              lastContactedAt: row.last_contacted_at,
              touchpointCadenceDays: row.touchpoint_cadence_days,
              dueAt: new Date(),
            },
            taskPersistence,
            TASK_RULES
          );
          officeTasksCreated += countGeneratedTasks(outcomes);
        }

        const staleLeads = await client.query(
          `SELECT l.id AS lead_id,
                  l.name AS lead_name,
                  l.assigned_rep_id,
                  psc.name AS stage_name,
                  psc.stale_threshold_days,
                  EXTRACT(DAY FROM NOW() - l.stage_entered_at)::int AS days_in_stage
           FROM ${schemaName}.leads l
           JOIN public.pipeline_stage_config psc ON psc.id = l.stage_id
           WHERE l.is_active = true
             AND l.status = 'open'
             AND psc.workflow_family = 'lead'
             AND psc.is_terminal = false
             AND psc.stale_threshold_days IS NOT NULL
             AND l.stage_entered_at < NOW() - (psc.stale_threshold_days || ' days')::interval`
        );

        await dismissResolvedStaleLeadTasks(
          client,
          schemaName,
          office.id,
          staleLeads.rows.map((lead) => lead.lead_id)
        );

        for (const lead of staleLeads.rows) {
          const outcomes = await evaluateTaskRules(
            {
              now: new Date(),
              officeId: office.id,
              entityId: `lead:${lead.lead_id}`,
              sourceEvent: "cron.daily_task_generation.stale_lead",
              leadId: lead.lead_id,
              leadName: lead.lead_name,
              stage: lead.stage_name,
              staleAge: lead.days_in_stage,
              taskAssigneeId: lead.assigned_rep_id,
            },
            taskPersistence,
            TASK_RULES
          );
          officeTasksCreated += countGeneratedTasks(outcomes);
        }

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
