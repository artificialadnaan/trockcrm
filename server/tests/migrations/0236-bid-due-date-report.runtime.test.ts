// Executes migration 0236 FROM DISK against a real Postgres (PGlite).
//
// 0236 creates the bid-due-date report's receipt ledger and its two recipient groups, and WARNS — without
// failing — when the `to` group matches nobody.
//
// The warning is the whole reason this file exists. The 0079 seed pattern it is built on is a conditional
// join against `public.users` with `ON CONFLICT DO NOTHING`, which is a SILENT no-op when it matches
// nothing; the address this feature was specified against appears nowhere in production source; and this
// group has no admin/director fallback. Three independent ways to arrive at "the report has no
// recipients", none of which says anything out loud.
//
// WHY IT WARNS RATHER THAN RAISES, because that is the assertion most likely to be "corrected" later: the
// Dockerfile CMD is `runner.js && index.js` and the runner exits non-zero, so a raising migration
// crash-loops the API container. The guard of record is the JOB's throw on an empty recipient list — see
// bid-due-date-report.test.ts, "THROWS when the report group resolves to nobody, and writes no receipt".
// This migration's job is to say so at deploy time and then get out of the way.
//
// So the assertions below are that the warning IS emitted, that the migration completes ANYWAY, and that
// it stays idempotent — a warning that aborted half the file would be a raise with extra steps.

import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0236_bid_due_date_report";

let pg: PGlite;

/** 0079's tables, plus the `public.users` columns the seed matches on. */
async function baseSchema(): Promise<void> {
  await pg.exec(`
    CREATE TABLE public.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      display_name text,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.notification_recipient_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL UNIQUE,
      name text NOT NULL,
      description text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.notification_recipient_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES public.notification_recipient_groups(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (group_id, user_id)
    );
  `);
}

const addUser = (email: string, displayName: string, isActive = true) =>
  pg.exec(
    `INSERT INTO public.users (email, display_name, is_active)
     VALUES ('${email}', '${displayName}', ${isActive});`,
  );

/**
 * Runs the migration and CAPTURES the notices Postgres raised, WITH their severity.
 *
 * The warning is the deliverable here, so it has to be observed rather than inferred from the migration
 * not throwing — "did not raise" is equally true of a `RAISE WARNING`, a `RAISE NOTICE`, and no check at
 * all, and only one of those tells an operator anything.
 *
 * SEVERITY IS PART OF THE ASSERTION, not decoration. `onNotice` fires for NOTICE and WARNING alike, so a
 * message-only match cannot tell them apart — and downgrading this to NOTICE would hide it: NOTICE is the
 * level psql prints for every `CREATE TABLE IF NOT EXISTS` that skipped, so a real fault at that level
 * arrives buried in routine chatter, while WARNING is what an operator scanning deploy output actually
 * stops on. Asserting the text alone let `RAISE WARNING -> RAISE NOTICE` survive mutation.
 */
async function runCapturingNotices(): Promise<{ severity: string; message: string }[]> {
  const notices: { severity: string; message: string }[] = [];
  await pg.exec(migrationSql(MIGRATION), {
    onNotice: (notice) =>
      notices.push({
        severity: String(notice.severity ?? ""),
        message: String(notice.message ?? ""),
      }),
  });
  return notices;
}

const EMPTY_REPORT_GROUP = /"bid_due_date_report" group matched no ACTIVE user/;

/** The messages raised at WARNING and nothing else, joined for matching. */
const warningsIn = (notices: { severity: string; message: string }[]) =>
  notices
    .filter((notice) => notice.severity === "WARNING")
    .map((notice) => notice.message)
    .join("\n");

const run = () => pg.exec(migrationSql(MIGRATION));

async function recipientEmails(key: string): Promise<string[]> {
  const result = await pg.query<{ email: string }>(
    `SELECT u.email
       FROM public.notification_recipient_groups g
       JOIN public.notification_recipient_assignments a ON a.group_id = g.id
       JOIN public.users u ON u.id = a.user_id
      WHERE g.key = $1
      ORDER BY u.email`,
    [key],
  );
  return result.rows.map((row) => row.email);
}

beforeEach(async () => {
  pg = new PGlite();
  await baseSchema();
});

describe("0236 — the receipt ledger", () => {
  it("creates public.bid_due_date_report_receipts keyed (tenant_schema, week_of)", async () => {
    await addUser("sidney@trockgc.com", "Sidney Gibson");
    await run();
    const key = await pg.query<{ attname: string }>(
      `SELECT a.attname
         FROM pg_index i
         JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
        WHERE n.nspname = 'public'
          AND t.relname = 'bid_due_date_report_receipts'
          AND i.indisprimary
        ORDER BY a.attname`,
    );
    expect(key.rows.map((row) => row.attname)).toEqual(["tenant_schema", "week_of"]);
  });

  it("takes a second run without complaint — the operator recovery path re-runs this file", async () => {
    await addUser("sidney@trockgc.com", "Sidney Gibson");
    await run();
    await expect(run()).resolves.toBeDefined();
    expect(await recipientEmails("bid_due_date_report")).toEqual(["sidney@trockgc.com"]);
  });
});

describe("0236 — the seed", () => {
  it("seeds the report group by EMAIL when that is what the database carries", async () => {
    await addUser("sidney@trockgc.com", "Someone Else Entirely");
    await run();
    expect(await recipientEmails("bid_due_date_report")).toEqual(["sidney@trockgc.com"]);
  });

  it("seeds it by DISPLAY NAME when the address differs — the address was never verified in source", async () => {
    // sidney@trockgc.com appears in two test fixtures and nowhere in production source. Matching only on
    // it would be seeding on a guess; 0222's header records the NAME as this person's known identity.
    await addUser("s.gibson@trockconstruction.com", "Sidney Gibson");
    await run();
    expect(await recipientEmails("bid_due_date_report")).toEqual(["s.gibson@trockconstruction.com"]);
  });

  it("seeds the cc group with the address 0079 already proved this database carries", async () => {
    await addUser("sidney@trockgc.com", "Sidney Gibson");
    await addUser("adnaan.iqbal@gmail.com", "Adnaan Iqbal");
    await run();
    expect(await recipientEmails("bid_due_date_report_cc")).toEqual(["adnaan.iqbal@gmail.com"]);
  });

  it("registers BOTH group rows, so the admin page can edit a list it did not have to create", async () => {
    await addUser("sidney@trockgc.com", "Sidney Gibson");
    await run();
    const groups = await pg.query<{ key: string }>(
      `SELECT key FROM public.notification_recipient_groups WHERE key LIKE 'bid_due_date_report%' ORDER BY key`,
    );
    expect(groups.rows.map((row) => row.key)).toEqual([
      "bid_due_date_report",
      "bid_due_date_report_cc",
    ]);
  });
});

describe("0236 — warning, and continuing", () => {
  it("WARNS when the report group matches nobody, instead of seeding nothing quietly", async () => {
    await addUser("someone.else@trockgc.com", "Someone Else");
    const notices = await runCapturingNotices();
    expect(warningsIn(notices)).toMatch(EMPTY_REPORT_GROUP);
  });

  it("raises it at WARNING, not NOTICE — NOTICE is where routine DDL chatter lives", async () => {
    await addUser("someone.else@trockgc.com", "Someone Else");
    const notices = await runCapturingNotices();
    const match = notices.find((notice) => EMPTY_REPORT_GROUP.test(notice.message));
    expect(match?.severity).toBe("WARNING");
  });

  it("does NOT raise — the runner exits non-zero and the API container would crash-loop", async () => {
    // The single most important assertion in this file, and the one a later "this should be louder"
    // change would break: `runner.js && index.js` means a failing migration keeps the CRM from booting.
    await addUser("someone.else@trockgc.com", "Someone Else");
    await expect(run()).resolves.toBeDefined();
  });

  it("COMPLETES the rest of the file after warning — a warning that aborted would be a raise", async () => {
    await addUser("someone.else@trockgc.com", "Someone Else");
    await run();
    const table = await pg.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'bid_due_date_report_receipts'`,
    );
    expect(table.rows[0]?.count).toBe(1);
    const groups = await pg.query<{ key: string }>(
      `SELECT key FROM public.notification_recipient_groups WHERE key LIKE 'bid_due_date_report%' ORDER BY key`,
    );
    expect(groups.rows.map((row) => row.key)).toEqual([
      "bid_due_date_report",
      "bid_due_date_report_cc",
    ]);
  });

  it("stays idempotent while warning, so the un-seeded state is not a one-way door", async () => {
    await addUser("someone.else@trockgc.com", "Someone Else");
    await run();
    await expect(run()).resolves.toBeDefined();
    // ...and the operator recovery path from the header closes it out, with no migration edit.
    await pg.exec(`
      INSERT INTO public.notification_recipient_assignments (group_id, user_id)
      SELECT g.id, u.id
        FROM public.notification_recipient_groups g, public.users u
       WHERE g.key = 'bid_due_date_report'
         AND u.email = 'someone.else@trockgc.com';
    `);
    const notices = await runCapturingNotices();
    expect(warningsIn(notices)).not.toMatch(EMPTY_REPORT_GROUP);
    expect(await recipientEmails("bid_due_date_report")).toEqual(["someone.else@trockgc.com"]);
  });

  it("WARNS when the only match is DEACTIVATED — an inactive user is not a recipient", async () => {
    // The resolver filters `is_active`, so a deactivated Sidney empties the group at read time. A seed
    // that counted her would hand back a group that looks configured and resolves to nobody.
    await addUser("sidney@trockgc.com", "Sidney Gibson", false);
    const notices = await runCapturingNotices();
    expect(warningsIn(notices)).toMatch(EMPTY_REPORT_GROUP);
  });

  it("WARNS on a re-run whose ONLY assignee has since been deactivated", async () => {
    // The case the seed's own `is_active` filter cannot reach, and the reason the COUNT carries the filter
    // separately: here the assignment row already exists and is skipped by ON CONFLICT DO NOTHING, so the
    // insert has no opinion at all. The person left; the group still lists them; the resolver returns
    // nobody. Without the filter on the count this stays quiet and so does the report.
    await addUser("sidney@trockgc.com", "Sidney Gibson");
    expect(warningsIn(await runCapturingNotices())).not.toMatch(EMPTY_REPORT_GROUP);
    await pg.exec(`UPDATE public.users SET is_active = false WHERE email = 'sidney@trockgc.com';`);
    expect(warningsIn(await runCapturingNotices())).toMatch(EMPTY_REPORT_GROUP);
  });

  it("points at the JOB's throw as the guard of record, not at itself", async () => {
    // The message has to tell an operator that the report is already refusing to send — otherwise the
    // warning reads as advisory and gets scrolled past, which is the failure mode a warning has and a
    // raise does not.
    await addUser("someone.else@trockgc.com", "Someone Else");
    const message = warningsIn(await runCapturingNotices());
    expect(message).toMatch(/refuse to send/);
    expect(message).toMatch(/one-line INSERT/);
  });

  it("says nothing about the report group when it IS seeded", async () => {
    await addUser("sidney@trockgc.com", "Sidney Gibson");
    const notices = await runCapturingNotices();
    expect(warningsIn(notices)).not.toMatch(EMPTY_REPORT_GROUP);
  });

  it("warns separately about an empty CC group — oversight is a choice, audience is not", async () => {
    await addUser("sidney@trockgc.com", "Sidney Gibson");
    const notices = await runCapturingNotices();
    expect(warningsIn(notices)).toMatch(/"bid_due_date_report_cc" group matched no ACTIVE user/);
    expect(warningsIn(notices)).toMatch(/report will still be sent/);
    expect(await recipientEmails("bid_due_date_report_cc")).toEqual([]);
    expect(await recipientEmails("bid_due_date_report")).toEqual(["sidney@trockgc.com"]);
  });
});
