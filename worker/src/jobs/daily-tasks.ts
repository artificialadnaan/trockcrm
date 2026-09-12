import { getDealAtRiskResult, type WorkflowRoute } from "@trock-crm/shared/types";
import { pool } from "../db.js";

const SERVER_MODULE_ROOT =
  process.env.NODE_ENV === "production" ? "../../../server/dist/modules" : "../../../server/src/modules";
const SERVER_EVALUATOR_MODULE = `${SERVER_MODULE_ROOT}/tasks/rules/evaluator.js` as string;
const SERVER_TASK_RULES_MODULE = `${SERVER_MODULE_ROOT}/tasks/rules/config.js` as string;
const SERVER_TASK_PERSISTENCE_MODULE = `${SERVER_MODULE_ROOT}/tasks/rules/persistence.js` as string;
const SERVER_STALE_LEAD_KEY_MODULE = `${SERVER_MODULE_ROOT}/tasks/rules/stale-lead-key.js` as string;

/**
 * First-outreach window. A `daily_first_outreach_touchpoint` task exists only for contacts 3..N days old:
 * the create query mints for contacts older than 3 days but NOT older than this many days, and
 * dismissResolvedFirstOutreachTasks expires any open task once its contact ages past this window. Using
 * ONE constant on ONE axis (contacts.created_at) makes the create and dismiss conditions exact complements,
 * so an expired/dismissed task can never be re-minted (the contact is out of the create window).
 */
export const FIRST_OUTREACH_WINDOW_DAYS = 30;

/**
 * Daily task list generation job.
 *
 * Runs daily at 6:00 AM CT. For each active office:
 * 1. Mark overdue tasks: any pending/in_progress task with due_date < today
 * 2. Create follow-up tasks for deals with upcoming expected_close_date (7 days out)
 * 3. Create touchpoint tasks for contacts with first_outreach_completed = false (older than 3 days)
 * 4. Create follow-up tasks for contacts overdue on their stage's touchpoint_cadence_days
 * 5. Create follow-up tasks for leads stuck past the shared SLA policy threshold
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

function normalizeWorkflowRoute(value: string | null | undefined): WorkflowRoute {
  return value === "service" ? "service" : "normal";
}

function getStaleLeadAtRisk(
  lead: { pipeline_type?: string | null; stage_entered_at?: string | Date | null },
  now: Date
) {
  return getDealAtRiskResult(
    {
      stageSlug: "opportunity",
      workflowRoute: normalizeWorkflowRoute(lead.pipeline_type),
      stageEnteredAt: lead.stage_entered_at,
    },
    "rep",
    now
  );
}

type Queryable = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
};

// Postgres schema names are interpolated into raw SQL (Postgres can't parameterize identifiers), so any
// function that does so must validate the identifier itself rather than trust the caller. A tenant schema
// is `office_<slug>` / `public` — a lowercase SQL identifier. Reject anything else before it reaches a query.
const SAFE_SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
function assertSafeSchemaName(schemaName: string): void {
  if (!SAFE_SCHEMA_NAME.test(schemaName)) {
    throw new Error(`Unsafe schema name: ${JSON.stringify(schemaName)}`);
  }
}

export async function dismissResolvedStaleLeadTasks(
  client: Queryable,
  schemaName: string,
  officeId: string,
  activeStaleLeadDedupeKeys: string[],
  resolvedAt: Date = new Date()
): Promise<number> {
  const activeTaskStatusesSql = ["pending", "scheduled", "in_progress", "waiting_on", "blocked"]
    .map((status) => `'${status}'`)
    .join(", ");

  const dismissalWhereClause = activeStaleLeadDedupeKeys.length > 0
    ? `AND dedupe_key <> ALL($2::text[])`
    : "";
  const dismissalParams: unknown[] = activeStaleLeadDedupeKeys.length > 0
    ? [resolvedAt, activeStaleLeadDedupeKeys]
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

/**
 * Resolve the lifecycle gap for `daily_first_outreach_touchpoint` tasks. Mirrors
 * dismissResolvedStaleLeadTasks: dismiss every OPEN first-outreach task whose reason to exist is gone, and
 * record a task_resolution_state row so the dismissal is audited. A task is dismissed when EITHER:
 *   - RESOLVED: its contact no longer needs first outreach — first_outreach_completed flipped true (the PG
 *     touchpoint_trigger sets this on any call/email/meeting), or the contact went inactive / was deleted.
 *     This is the core fix: outreach logged as an ACTIVITY flips the flag but never closed the open task.
 *   - EXPIRED: the contact has aged past the first-outreach window (created_at < now - WINDOW). Ongoing
 *     contact is governed by the touchpoint-cadence rule, so a months-old "first outreach" reminder is debris.
 * Re-mint is prevented structurally, NOT by suppression (the rule has suppressionWindowDays:0): a RESOLVED
 * contact fails the create query's first_outreach_completed=false filter; an EXPIRED contact fails its
 * created_at >= now-WINDOW bound. Both reference the SAME FIRST_OUTREACH_WINDOW_DAYS constant the create
 * query uses, so they are exact complements on contacts.created_at and a dismissed task can never re-mint.
 */
export async function dismissResolvedFirstOutreachTasks(
  client: Queryable,
  schemaName: string,
  officeId: string,
  resolvedAt: Date = new Date()
): Promise<number> {
  assertSafeSchemaName(schemaName);
  const activeTaskStatusesSql = ["pending", "scheduled", "in_progress", "waiting_on", "blocked"]
    .map((status) => `'${status}'`)
    .join(", ");

  // A contact "still needs first outreach" iff it is active and not yet contacted. RESOLVED = NOT that.
  const stillNeedsOutreachSql = `EXISTS (
    SELECT 1 FROM ${schemaName}.contacts c
    WHERE c.id = t.contact_id AND c.is_active = true AND c.first_outreach_completed = false
  )`;

  const dismissedTasks = await client.query<{
    id: string;
    origin_rule: string;
    dedupe_key: string;
    reason_code: string | null;
    entity_snapshot: Record<string, unknown> | null;
    resolution_reason: string;
  }>(
    `UPDATE ${schemaName}.tasks AS t
     SET status = 'dismissed',
         completed_at = $1,
         is_overdue = false,
         waiting_on = NULL,
         blocked_by = NULL,
         updated_at = NOW()
     WHERE t.origin_rule = 'daily_first_outreach_touchpoint'
       AND t.status IN (${activeTaskStatusesSql})
       AND (
         NOT ${stillNeedsOutreachSql}
         OR EXISTS (
           SELECT 1 FROM ${schemaName}.contacts c
           WHERE c.id = t.contact_id
             AND c.created_at < CURRENT_DATE - (${FIRST_OUTREACH_WINDOW_DAYS} * INTERVAL '1 day')
         )
       )
     RETURNING id, origin_rule, dedupe_key, reason_code, entity_snapshot,
       CASE WHEN NOT ${stillNeedsOutreachSql}
            THEN 'first_outreach_resolved' ELSE 'first_outreach_expired' END AS resolution_reason`,
    [resolvedAt]
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
        task.resolution_reason,
        resolvedAt,
        task.entity_snapshot ?? null,
      ]
    );
  }

  return dismissedTasks.rowCount ?? dismissedTasks.rows.length;
}

/**
 * Origin rules whose tasks exist ONLY to move an OPEN deal forward, and are therefore debris the moment
 * the deal reaches a terminal stage (Won / Lost).
 *
 * This is an explicit ALLOWLIST rather than `origin_rule IS NOT NULL`, because two other populations sit
 * on terminal deals legitimately and must NOT be swept:
 *  - Post-close workflow rules — `deal_won_*_handoff`, `deal_won_cross_sell`,
 *    `deal_lost_competitor_intel`, `scoping_estimating_review_handoff`. Those tasks exist BECAUSE the deal
 *    closed; dismissing them would delete the hand-off the close is supposed to trigger.
 *  - MANUAL tasks (`origin_rule IS NULL`) — a person's stated intent. `stage-change.ts` already dismisses
 *    everything open at the moment of the transition, so a manual task on a closed deal was filed
 *    deliberately, after the fact ("Client Data and Follow up data needed" on a Lost deal is real work).
 */
export const TERMINAL_DEAL_DISMISSIBLE_ORIGIN_RULES = [
  "daily_close_date_follow_up",
  "daily_cadence_overdue_follow_up",
  "inbound_email_reply_needed",
  "ai_disconnect_admin_task",
  "cold_lead_warming",
] as const;

/**
 * Dismiss every OPEN forward-motion task whose deal has reached a terminal stage (Won / Lost).
 *
 * `stage-change.ts` ALREADY dismisses open tasks when a deal transitions to a terminal stage — and that
 * dismissal is precisely what made this leak self-sustaining. The generators below dedupe on "no OPEN task
 * of this kind exists", so closing a deal CLEARED the guard and the next 6 AM run re-minted the task onto
 * the now-closed deal. Prod on 2026-09-12: DFW-4-22226-ag went Won on 2026-08-10 and was handed a fresh
 * "Follow up: … closes 2026-09-10" task on 2026-09-03, 24 days later; office-wide, 3,395 open tasks sat on
 * Won/Lost deals across 14 reps.
 *
 * The create side is now filtered on `psc.is_terminal = false` (here, in ai-disconnect-admin-tasks.ts and
 * in email-sync.ts), so this pass and those predicates are exact complements on ONE axis — the deal's
 * stage — which is what makes a dismissal stay dismissed instead of re-minting next run. It also drains the
 * historical backlog on the first run after deploy.
 *
 * `suppressed_until` is left NULL deliberately: a deal CAN come back (return-to-opportunity), and when it
 * does these tasks should be free to re-mint. The 0-day rules (close-date, cadence) therefore resume
 * immediately, while `inbound_email_reply_needed` rides its own 30-day rule window — the same contract the
 * sibling dismissers use.
 */
export async function dismissResolvedTerminalDealTasks(
  client: Queryable,
  schemaName: string,
  officeId: string,
  resolvedAt: Date = new Date()
): Promise<number> {
  assertSafeSchemaName(schemaName);
  const activeTaskStatusesSql = ["pending", "scheduled", "in_progress", "waiting_on", "blocked"]
    .map((status) => `'${status}'`)
    .join(", ");

  // ONE round-trip, via a data-modifying CTE, rather than the UPDATE-then-loop the sibling dismissers use.
  // That shape costs a round-trip per dismissed task, and this pass has a first-run backlog of ~3,400 rows
  // in a single office — 3,400 sequential round-trips inside one transaction, holding this office's
  // advisory lock the whole time. Measured against the prod proxy it did not finish inside 10 minutes. The
  // siblings drain tens of rows and get away with it; this one cannot.
  //
  // DISTINCT ON (origin_rule, dedupe_key) is required, not tidiness: ON CONFLICT DO UPDATE raises
  // "cannot affect row a second time" if the source rows carry a duplicate business key, which two open
  // tasks sharing a dedupe key would produce — and that error would roll back the dismissal too.
  const result = await client.query<{ dismissed_count: string | number }>(
    `WITH dismissed AS (
       UPDATE ${schemaName}.tasks AS t
       SET status = 'dismissed',
           -- NOT completed_at. The "Completed this week" count is
           -- status IN ('completed','dismissed') AND completed_at >= NOW() - 7 days, so stamping it here
           -- would report ~3,268 completions nobody made and leave that card disagreeing with its own
           -- sibling (which counts 'completed' only) for a week, while burying every real completion in
           -- the Completed tab. Five of the eight dismissal writers in this codebase — stage-change.ts
           -- included, i.e. the human-equivalent path — leave it null for exactly this reason. The
           -- timestamp is not lost: task_resolution_state.resolved_at records when this pass ran.
           is_overdue = false,
           waiting_on = NULL,
           blocked_by = NULL,
           updated_at = NOW()
       WHERE t.origin_rule = ANY($2::text[])
         AND t.status IN (${activeTaskStatusesSql})
         AND EXISTS (
           SELECT 1
           FROM ${schemaName}.deals d
           JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
           WHERE d.id = t.deal_id
             AND psc.is_terminal = true
         )
       RETURNING id, origin_rule, dedupe_key, entity_snapshot
     ),
     auditable AS (
       SELECT DISTINCT ON (origin_rule, dedupe_key) id, origin_rule, dedupe_key, entity_snapshot
       FROM dismissed
       WHERE dedupe_key IS NOT NULL
       ORDER BY origin_rule, dedupe_key, id
     ),
     audited AS (
       INSERT INTO ${schemaName}.task_resolution_state
         (office_id, task_id, origin_rule, dedupe_key, resolution_status, resolution_reason, resolved_at, suppressed_until, entity_snapshot)
       SELECT $3, a.id, a.origin_rule, a.dedupe_key, 'dismissed', $4, $1, NULL, a.entity_snapshot
       FROM auditable a
       ON CONFLICT (origin_rule, dedupe_key) DO UPDATE
       SET office_id = EXCLUDED.office_id,
           task_id = EXCLUDED.task_id,
           resolution_status = EXCLUDED.resolution_status,
           resolution_reason = EXCLUDED.resolution_reason,
           resolved_at = EXCLUDED.resolved_at,
           suppressed_until = EXCLUDED.suppressed_until,
           entity_snapshot = EXCLUDED.entity_snapshot,
           updated_at = NOW()
       RETURNING 1
     )
     SELECT (SELECT COUNT(*) FROM dismissed) AS dismissed_count`,
    [resolvedAt, [...TERMINAL_DEAL_DISMISSIBLE_ORIGIN_RULES], officeId, "deal_reached_terminal_stage"]
  );

  return Number(result.rows[0]?.dismissed_count ?? 0);
}

export async function runDailyTaskGeneration(): Promise<void> {
  console.log("[Worker:daily-tasks] Starting daily task generation...");

  const client = await pool.connect();
  try {
    const offices = await client.query("SELECT id, slug FROM public.offices WHERE is_active = true");

    let totalTasksCreated = 0;
    let totalOverdueMarked = 0;
    let totalOverdueCleared = 0;
    let totalFirstOutreachDismissed = 0;
    let totalTerminalDealDismissed = 0;

    for (const office of offices.rows) {
      try {
        let officeTasksCreated = 0;
        let officeOverdueMarked = 0;
        let officeOverdueCleared = 0;
        let officeFirstOutreachDismissed = 0;
        let officeTerminalDealDismissed = 0;

        const slugRegex = /^[a-z][a-z0-9_]*$/;
        if (!slugRegex.test(office.slug)) {
          console.error(`[Worker:daily-tasks] Invalid office slug: "${office.slug}" -- skipping`);
          continue;
        }

        const schemaName = `office_${office.slug}`;

        // Drain forward-motion tasks whose deal has already closed, in a transaction OF ITS OWN, committed
        // before generation begins. Two reasons it is not folded into the generation transaction below:
        //
        // 1. LOCK DURATION. The first run after deploy dismisses ~3,268 rows in one office. Inside the
        //    generation transaction those row locks would be held across the whole generator loop — many
        //    further round-trips — so a rep marking one of those deals Won would block until COMMIT and,
        //    past the app's 30-45s timeout, simply fail. stage-change.ts takes its own bulk
        //    `UPDATE tasks ... WHERE deal_id = X` on the same rows, and the two scan in different orders
        //    (deal_id index vs. an origin_rule-driven scan), which is a genuine deadlock cycle.
        // 2. COST. `audit_tasks` is a FOR EACH ROW trigger that runs a dynamic EXECUTE per column
        //    (~36 on tasks), so the drain costs ~118k dynamic executions on its first run regardless of
        //    how few statements it takes. Migrations 0233 and 0239 disable that trigger around bulk task
        //    updates for exactly this reason; a cron job cannot, so the least it can do is not hold the
        //    generation transaction open while paying it.
        //
        // Committing separately is also the safer failure mode: the drain is idempotent and independently
        // correct, so a later generation failure no longer un-does the cleanup.
        //
        // It still runs FIRST, before the overdue marking and its notification INSERT, because that order
        // decides whether the run that finally cleans a task up ALSO emails the rep about it one last time.
        try {
          await client.query("BEGIN");
          await client.query(`SELECT pg_advisory_xact_lock(hashtext('daily_task_generation_' || $1))`, [office.id]);
          officeTerminalDealDismissed = await dismissResolvedTerminalDealTasks(client, schemaName, office.id);
          await client.query("COMMIT");
          totalTerminalDealDismissed += officeTerminalDealDismissed;
        } catch (drainErr) {
          await client.query("ROLLBACK").catch(() => {});
          officeTerminalDealDismissed = 0;
          console.error(`[Worker:daily-tasks] Office ${office.id} terminal-deal drain failed:`, drainErr);
        }

        await client.query("BEGIN");
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('daily_task_generation_' || $1))`, [office.id]);

        const { evaluateTaskRules, TASK_RULES, createTenantTaskRulePersistence } = await loadTaskRuleDependencies();
        const taskPersistence = createTenantTaskRulePersistence(client, schemaName);

        // `is_overdue` is a STORED flag, and the marking step below only ever sets it TRUE. Nothing ever
        // reset it, so moving a due date forward (snooze, re-plan) left the task flagged overdue for good:
        // on prod a task due 2026-12-01 was still emailing its assignee a daily "Task … is overdue (due
        // 2026-12-01)", and still sorting to the top of the list as `urgent`. Clear it first, then re-derive
        // it, so the flag is a function of TODAY's due date rather than a high-water mark.
        //
        // Undated work is included: a task with no due date has no date to be past, so it cannot be overdue.
        // This only ever clears — it cannot invent an overdue task — and the marking step immediately below
        // re-sets the flag for everything genuinely past due.
        const overdueClearedResult = await client.query(
          `UPDATE ${schemaName}.tasks
           SET is_overdue = false,
               updated_at = NOW()
           WHERE is_overdue = true
             AND status IN ('pending', 'scheduled', 'in_progress', 'waiting_on', 'blocked')
             AND (due_date IS NULL OR due_date >= CURRENT_DATE)`
        );
        officeOverdueCleared += overdueClearedResult.rowCount ?? 0;

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
           JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
           WHERE d.is_active = true
             -- A Won or Lost deal has no close left to follow up ON. Without this the rule minted a fresh
             -- "Follow up: <number> closes <date>" onto closed work, and did it REPEATEDLY: stage-change.ts
             -- dismisses open tasks at the terminal transition, which cleared the NOT EXISTS guard below, so
             -- every dismissal handed the next 6 AM run permission to re-mint. Complements
             -- dismissResolvedTerminalDealTasks on the same axis (the deal's stage), so a drained task stays
             -- drained. is_terminal = false matches the stale-deal and cold-lead rules.
             AND psc.is_terminal = false
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

        // Lifecycle: dismiss first-outreach tasks whose contact has been contacted (flag flipped via the
        // touchpoint trigger), gone inactive, or aged out of the window — BEFORE re-evaluating who still
        // needs one (mirrors the stale-lead dismiss ordering). This also drains the historical backlog on
        // the first run after deploy.
        // Folded into the running total only AFTER COMMIT (like officeTasksCreated/officeOverdueMarked), so
        // a later-step failure that rolls back this office doesn't over-report dismissals in the summary log.
        officeFirstOutreachDismissed = await dismissResolvedFirstOutreachTasks(client, schemaName, office.id);

        const needsOutreach = await client.query(
          `SELECT c.id AS contact_id, c.first_name, c.last_name
           FROM ${schemaName}.contacts c
           WHERE c.is_active = true
             AND c.first_outreach_completed = false
             AND c.created_at < CURRENT_DATE - INTERVAL '3 days'
             -- Upper bound: only NEW contacts get a first-outreach task. Past the window the moment has
             -- passed (cadence rules govern ongoing contact), and bounding here is what makes an
             -- expiry-dismissed task stay dismissed instead of re-minting next run.
             AND c.created_at >= CURRENT_DATE - (${FIRST_OUTREACH_WINDOW_DAYS} * INTERVAL '1 day')
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
             -- Terminal stages carry a touchpoint cadence too (prod: Won and Lost are both 14 days), and
             -- last_contacted_at only ages, so without this filter EVERY closed deal re-mints a contact
             -- follow-up forever. 417 of the 3,395 stuck tasks came from here.
             AND psc.is_terminal = false
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
                  l.stage_entered_at,
                  l.pipeline_type,
                  psc.name AS stage_name
           FROM ${schemaName}.leads l
           JOIN public.pipeline_stage_config psc ON psc.id = l.stage_id
           WHERE l.is_active = true
             AND l.status = 'open'
             AND psc.workflow_family = 'lead'
             AND psc.is_terminal = false`
        );
        const { buildStaleLeadDedupeKey } = (await import(SERVER_STALE_LEAD_KEY_MODULE)) as any;
        const staleLeadRows = staleLeads.rows
          .map((lead) => ({
            lead,
            atRisk: getStaleLeadAtRisk(lead, new Date()),
          }))
          .filter(({ atRisk }) => atRisk.isAtRisk);

        await dismissResolvedStaleLeadTasks(
          client,
          schemaName,
          office.id,
          staleLeadRows
            .map(({ lead }) => buildStaleLeadDedupeKey(lead.lead_id, lead.stage_entered_at))
            .filter((dedupeKey): dedupeKey is string => typeof dedupeKey === "string" && dedupeKey.length > 0)
        );

        for (const { lead, atRisk } of staleLeadRows) {
          const outcomes = await evaluateTaskRules(
            {
              now: new Date(),
              officeId: office.id,
              entityId: `lead:${lead.lead_id}`,
              sourceEvent: "cron.daily_task_generation.stale_lead",
              leadId: lead.lead_id,
              leadName: lead.lead_name,
              stageEnteredAt: lead.stage_entered_at,
              stage: lead.stage_name,
              staleAge: atRisk.effectiveStageAgeDays,
              taskAssigneeId: lead.assigned_rep_id,
            },
            taskPersistence,
            TASK_RULES
          );
          officeTasksCreated += countGeneratedTasks(outcomes);
        }

        await client.query("COMMIT");
        totalOverdueMarked += officeOverdueMarked;
        totalOverdueCleared += officeOverdueCleared;
        totalTasksCreated += officeTasksCreated;
        totalFirstOutreachDismissed += officeFirstOutreachDismissed;
        // NOTE: totalTerminalDealDismissed is folded in at its own COMMIT above, not here.
      } catch (officeErr) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`[Worker:daily-tasks] Office ${office.id} failed:`, officeErr);
      }
    }

    console.log(
      `[Worker:daily-tasks] Complete. Marked ${totalOverdueMarked} overdue, cleared ${totalOverdueCleared} ` +
        `no-longer-overdue, created ${totalTasksCreated} new tasks, ` +
        `dismissed ${totalFirstOutreachDismissed} resolved/expired first-outreach tasks, ` +
        `dismissed ${totalTerminalDealDismissed} tasks on closed deals`
    );
  } catch (err) {
    console.error("[Worker:daily-tasks] Failed:", err);
    throw err;
  } finally {
    client.release();
  }
}
