import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { getFollowUpCompliance } from "../../../src/modules/reports/service.js";
import { buildContactLastTouchAtSql, buildContactUntouchedSql } from "../../../src/modules/contacts/service.js";

/**
 * REAL-SQL (PGlite) proof for the two READ surfaces the terminal-deal task drain moves.
 *
 * The drain (worker/src/jobs/daily-tasks.ts) bulk-dismisses ~3,268 automated tasks that had accumulated on
 * Won/Lost deals. Dismissing a task is not a neutral act here — two surfaces read task rows in ways that
 * turn the cleanup into a regression, and neither is anywhere near the code being fixed:
 *
 *  1. getFollowUpCompliance scores `status IN ('completed','dismissed')` as the DENOMINATOR and only
 *     'completed' as the numerator, over a window that DEFAULTS TO THE WHOLE YEAR. So every follow-up the
 *     drain retires reads as a rep's missed follow-up, retroactively. The rep who reported the phantom
 *     follow-ups would have watched his own compliance number get worse the morning after the fix, and the
 *     "compliance below 80%" strategic alert would have fired for nearly every rep.
 *
 *  2. buildContactLastTouchAtSql folds MAX(tasks.updated_at) into a contact's "Last touch", and
 *     set_tasks_updated_at is a BEFORE UPDATE row trigger — so ANY write to a task, including a bulk system
 *     dismissal, reads as human contact. ~2,400 of the drained tasks carry a contact_id, so all of those
 *     contacts would have silently dropped out of the "Untouched 30d+" card. Migration 0233 documents this
 *     exact hazard ("nothing would look inconsistent enough for anyone to notice").
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const REP = U("a01");
const CONTACT = U("c01");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE contacts (id uuid PRIMARY KEY, last_contacted_at timestamptz);
    CREATE TABLE activities (id uuid PRIMARY KEY, contact_id uuid, occurred_at timestamptz);
    CREATE TABLE emails (id uuid PRIMARY KEY, contact_id uuid, sent_at timestamptz);
    CREATE TABLE contact_deal_associations (contact_id uuid, deal_id uuid, is_primary boolean DEFAULT false);
    CREATE TABLE tasks (
      id uuid PRIMARY KEY, title text, type text, status text NOT NULL,
      assigned_to uuid, contact_id uuid, deal_id uuid,
      due_date date, completed_at timestamptz,
      is_test_data boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE task_resolution_state (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id uuid, origin_rule text NOT NULL, dedupe_key text NOT NULL,
      resolution_status text NOT NULL, resolution_reason text, resolved_at timestamptz
    );
    INSERT INTO contacts (id, last_contacted_at) VALUES ('${CONTACT}', now() - interval '90 days');
  `);
  tdb = drizzle(pg);
});

describe("follow-up compliance after the drain", () => {
  beforeEach(async () => {
    await pg.exec(`
      INSERT INTO tasks (id, title, type, status, assigned_to, due_date, completed_at, created_at) VALUES
        ('${U("f01")}', 'done on time', 'follow_up', 'completed', '${REP}', CURRENT_DATE - 5, now() - interval '6 days', now() - interval '10 days'),
        ('${U("f02")}', 'rep dismissed it', 'follow_up', 'dismissed', '${REP}', CURRENT_DATE - 5, NULL, now() - interval '10 days'),
        ('${U("f03")}', 'drained as debris', 'follow_up', 'dismissed', '${REP}', CURRENT_DATE - 5, NULL, now() - interval '10 days');
      INSERT INTO task_resolution_state (task_id, origin_rule, dedupe_key, resolution_status, resolution_reason, resolved_at)
        VALUES ('${U("f03")}', 'daily_close_date_follow_up', 'deal:x:daily_close_date_follow_up', 'dismissed', 'deal_reached_terminal_stage', now());
    `);
  });

  it("does not score a task the SYSTEM retired as debris against the rep", async () => {
    const result = await getFollowUpCompliance(tdb, REP);
    // t01 (completed on time) + t02 (a real human dismissal) = 2. t03 is excluded entirely.
    expect(result.total).toBe(2);
    expect(result.onTime).toBe(1);
    expect(result.complianceRate).toBe(50);
  });

  it("CONTROL — a human dismissal is still counted, so the exclusion is not blanket", async () => {
    // Strip only the drain's audit row. t03 becomes an ordinary dismissal and must re-enter the denominator,
    // proving the predicate keys on the resolution REASON and not merely on 'dismissed'.
    await pg.exec(`DELETE FROM task_resolution_state WHERE task_id = '${U("f03")}'`);
    const result = await getFollowUpCompliance(tdb, REP);
    expect(result.total).toBe(3);
    expect(result.onTime).toBe(1);
  });
});

describe("contact last-touch after the drain", () => {
  it("a dismissed task's updated_at is not a touch, so the contact stays Untouched 30d+", async () => {
    // Exactly what the drain leaves behind: a task on this contact, dismissed, updated_at = now.
    await pg.exec(`
      INSERT INTO tasks (id, title, type, status, contact_id, updated_at)
      VALUES ('${U("f10")}', 'drained', 'follow_up', 'dismissed', '${CONTACT}', now());
    `);

    const result = await tdb.execute(sql`
      SELECT ${buildContactLastTouchAtSql()} AS last_touch,
             ${buildContactUntouchedSql()} AS untouched
      FROM contacts
      WHERE contacts.id = ${CONTACT}
    `);
    const row = ((result as any).rows ?? result)[0];
    expect(row.untouched).toBe(true);
    // 90 days ago, from last_contacted_at — NOT today.
    expect(new Date(row.last_touch).getTime()).toBeLessThan(Date.now() - 80 * 24 * 3600 * 1000);
  });

  it("CONTROL — an OPEN task on the same contact still counts as a touch", async () => {
    await pg.exec(`
      INSERT INTO tasks (id, title, type, status, contact_id, updated_at)
      VALUES ('${U("f11")}', 'live work', 'follow_up', 'pending', '${CONTACT}', now());
    `);
    const result = await tdb.execute(sql`
      SELECT ${buildContactUntouchedSql()} AS untouched
      FROM contacts WHERE contacts.id = ${CONTACT}
    `);
    const row = ((result as any).rows ?? result)[0];
    expect(row.untouched).toBe(false);
  });
});
