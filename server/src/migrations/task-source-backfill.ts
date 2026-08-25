import type pg from "pg";
import { runPerOfficeTransactionalStep, validateOfficeSchemaName } from "./per-office-step.js";

// The 0233 classification backfill, expressed as a per-office transactional step.
//
// WHY IT IS NOT IN THE MIGRATION FILE. It has to disable two triggers around itself, and
// `ALTER TABLE ... DISABLE TRIGGER` takes a lock that conflicts with task inserts, updates and deletes.
// runner.ts sends each .sql file as ONE client.query(sql), so a DO block doing this per office would
// hold the first office's lock until the LAST office finished — task writes blocking progressively
// across every tenant, on the deploy that ships the feature, on the table people are already calling
// overloaded. See per-office-step.ts for the general rule and the mechanism; this file is only the
// configuration for it.
//
// WHY THOSE TWO TRIGGERS. `tasks` carries set_tasks_updated_at (0001:858 -> set_updated_at at 0001:368),
// which sets NEW.updated_at = NOW() on every UPDATE, unconditionally. The contacts list reads
// MAX(tasks.updated_at) straight through as a contact's "Last touch"
// (contacts/service.ts buildContactLastTouchAtSql), and the "Untouched 30d+" card, its ?card=untouched
// drill and the aggregate count are ALL derived from that one expression. A backfill that let the
// trigger fire would stamp every contact that has ever had a task with the migration's timestamp: the
// sort would collapse, the card would read zero, and because the card, the drill and the aggregate move
// together nothing would look inconsistent enough for anyone to notice. The original values are not
// recoverable. audit_tasks is suspended for the same window because it fires ~30 dynamic EXECUTEs per
// row and would otherwise write an audit entry per task, in every office, for a column no person edited.
export const TASK_SOURCE_BACKFILL_MIGRATION = "0233_task_source_classification.sql";

/** Suspended for the duration of each office's transaction, and restored in reverse. */
export const BACKFILL_SUSPENDED_TRIGGERS = ["set_tasks_updated_at", "audit_tasks"] as const;

/**
 * A task with no originating rule but a person recorded against it is a person's task.
 *
 * Every automated shape in production carries a non-null origin_rule (rules engine, email queue,
 * AI-disconnect cron, revision routing), so they are all excluded here and keep the 'automated' column
 * default without being rewritten. Some long-lived office schemas predate that column entirely. A
 * missing field is unknown provenance, not a NULL origin_rule: inspect the row as JSON so this statement
 * can run there, but only classify rows whose schema actually contains the field. Those unknown rows keep
 * the conservative 'automated' default rather than being silently guessed into Manual. Reassignment tasks
 * are the exception that has to be named: they
 * record the person who reassigned the deal, so they look hand-typed on every column, and they are
 * exactly the volume people are asking to filter away. They are excluded HERE rather than corrected in
 * a second pass so the backfill converges in ONE pass — setting them to 'manual' and putting them back
 * would rewrite every reassignment row twice to arrive where it started. Two markers identify them
 * together: the fixed title AND the assignedAt key their snapshot always carries; the title alone would
 * misfile a person's task worded the same way, and COALESCE keeps a NULL snapshot on the human side.
 *
 * Guarded on `source = 'automated'` so a row already classified correctly is never rewritten at all.
 *
 * @param schema an ALREADY validated and quoted schema identifier.
 */
export function buildClassifyStatement(schema: string): string {
  return `
    UPDATE ${schema}.tasks AS t SET source = 'manual'
     WHERE to_jsonb(t) ? 'origin_rule'
       AND (to_jsonb(t) ->> 'origin_rule') IS NULL
       AND t.created_by IS NOT NULL
       AND t.source = 'automated'
       AND NOT (
         t.title IN ('New Deal Assignment', 'New Lead Assignment')
         AND COALESCE(t.entity_snapshot ? 'assignedAt', false)
       )`;
}

/**
 * Repairs a reassignment task some earlier run left on 'manual' — a partially-applied backfill, or a
 * hand replay against a restored dump taken mid-flight. A converged schema matches nothing here, which
 * is the point: it is a repair, not part of the classification.
 *
 * @param schema an ALREADY validated and quoted schema identifier.
 */
export function buildRepairStatement(schema: string): string {
  return `
    UPDATE ${schema}.tasks AS t SET source = 'automated'
     WHERE to_jsonb(t) ? 'origin_rule'
       AND (to_jsonb(t) ->> 'origin_rule') IS NULL
       AND t.title IN ('New Deal Assignment', 'New Lead Assignment')
       AND t.entity_snapshot ? 'assignedAt'
       AND t.source <> 'automated'`;
}

/**
 * Validates the CHECK that 0233 adds NOT VALID.
 *
 * 0233 cannot validate inline: ADD CONSTRAINT ... CHECK scans every existing row while holding ACCESS
 * EXCLUSIVE, and the migration file is one transaction, so the first office's lock would be held while
 * every later office was scanned. Adding it NOT VALID defers only the scan of PRE-EXISTING rows — the
 * constraint rejects every new INSERT and UPDATE from the moment it exists — and VALIDATE CONSTRAINT
 * then takes only SHARE UPDATE EXCLUSIVE, which blocks neither reads nor writes.
 *
 * A second caller of the shared mechanism, and a useful demonstration that it generalises: no triggers
 * to suspend, a different statement, same per-office transaction boundary.
 *
 * Idempotent: VALIDATE CONSTRAINT on an already-validated constraint is a no-op.
 */
export const TASK_SOURCE_VALIDATE_STEP = {
  label: "0233 task source CHECK validation",
  table: "tasks",
  requiredColumn: "source",
  buildStatements: (schema: string) => [
    `ALTER TABLE ${schema}.tasks VALIDATE CONSTRAINT tasks_source_check`,
  ],
} as const;

export const TASK_SOURCE_BACKFILL_STEP = {
  label: "0233 task source backfill",
  table: "tasks",
  requiredColumn: "source",
  suspendTriggers: BACKFILL_SUSPENDED_TRIGGERS,
  buildStatements: (schema: string) => [buildClassifyStatement(schema), buildRepairStatement(schema)],
} as const;

/**
 * Classifies existing tasks and validates the deferred CHECK, per office, one transaction per office.
 *
 * Classification runs FIRST so validation scans rows that are already in their final state. It would
 * pass either way — every row carries the column default until the backfill runs, and both values
 * satisfy the constraint — but validating what was actually written is the honest order.
 */
export async function runTaskSourceBackfill(client: pg.Client): Promise<void> {
  await runPerOfficeTransactionalStep(client, TASK_SOURCE_BACKFILL_STEP);
  await runPerOfficeTransactionalStep(client, TASK_SOURCE_VALIDATE_STEP);
}

export { validateOfficeSchemaName };
