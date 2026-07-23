import { readFileSync } from "fs";
import { resolve } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { addTeamMember } from "../../../src/modules/deals/team-service.js";
import {
  dealTeamMembers,
  contacts,
  deals,
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
  scorecardCorrectiveActions,
  scorecardCorrectiveActionTokens,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

// Finding E: migration 0193 introduced the EMAIL-ONLY deal_team_members shape (user_id AND contact_id both
// NULL, member_email set) with NO uniqueness. So a retried add — or the same external email + role entered
// twice — created a SECOND active assignment (duplicates, split access, a needless cycle restart per dup).
// Migration 0196 adds a per-tenant CASE-INSENSITIVE partial unique index on ACTIVE email-only rows
// (deal_id, lower(member_email), role), and addTeamMember handles the conflict (onConflictDoNothing + return
// the existing active row, no cycle restart). This file applies the REAL index DDL from 0196 and proves the
// dedup + no-second-restart behavior, plus a shape check on the migration file.

const DEAL = "11111111-1111-1111-1111-111111111111";
const SCORECARD = "55555555-5555-5555-5555-000000000001";
const EXT_EMAIL = "ext.super@example.com";

let pg: PGlite;
let tdb: any;
const OFFICE = { id: "00000000-0000-0000-0000-0000000000f1", slug: "test" };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true);
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type varchar(100) NOT NULL, payload jsonb NOT NULL, office_id uuid,
      status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 3,
      last_error text, started_processing_at timestamptz, run_after timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    );
  `);
  await pg.exec(
    tenantSchemaSql("public", [
      dealTeamMembers,
      contacts,
      deals,
      fieldScorecards,
      fieldScorecardItems,
      fieldScorecardPhotos,
      scorecardCorrectiveActions,
      scorecardCorrectiveActionTokens,
    ]),
  );
  // tenantSchemaSql intentionally omits indexes, so apply the ACTUAL email-only unique index the migration
  // creates (against `public` here, where the test tables live) — otherwise the dedup couldn't be exercised.
  await pg.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS deal_team_members_deal_email_role_uidx
      ON public.deal_team_members (deal_id, lower(member_email), role)
      WHERE user_id IS NULL AND contact_id IS NULL AND is_active = TRUE AND member_email IS NOT NULL;
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

async function correctiveJobCount(): Promise<number> {
  const res = await tdb.execute(sql`
    SELECT COUNT(*)::int AS c FROM public.job_queue WHERE job_type = 'scorecard_corrective_action_email'
  `);
  return (res.rows[0] as { c: number }).c;
}

async function activeEmailOnlyCount(email: string, role: string): Promise<number> {
  const res = await tdb.execute(sql`
    SELECT COUNT(*)::int AS c FROM deal_team_members
     WHERE deal_id = ${DEAL} AND role = ${role} AND is_active = TRUE
       AND user_id IS NULL AND contact_id IS NULL AND LOWER(member_email) = LOWER(${email})
  `);
  return (res.rows[0] as { c: number }).c;
}

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM public.job_queue`);
  await tdb.execute(sql`DELETE FROM deal_team_members`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`
    INSERT INTO field_scorecards (id, client_submission_id, deal_id, week_of, form_version, kind, total_score, rating, status, submitted_by)
    VALUES (${SCORECARD}, '66666666-0000-0000-0000-000000000001', ${DEAL}, '2026-06-30', 1, 'project', 60, 'corrective_action', 'corrective_action_open', '33333333-3333-3333-3333-333333333333')
  `);
});

describe("addTeamMember dedups active email-only assignments (finding E)", () => {
  it("adding the same email-only super twice yields ONE active row (no duplicate)", async () => {
    const first = await addTeamMember(tdb, {
      dealId: DEAL,
      role: "superintendent",
      memberName: "Ext Super",
      memberEmail: EXT_EMAIL,
    });
    const second = await addTeamMember(tdb, {
      dealId: DEAL,
      role: "superintendent",
      memberName: "Ext Super (dup)",
      memberEmail: EXT_EMAIL,
    });

    // Exactly one active row, and the duplicate add returned the SAME existing row (not a new id).
    expect(await activeEmailOnlyCount(EXT_EMAIL, "superintendent")).toBe(1);
    expect(second.id).toBe(first.id);
  });

  it("dedups CASE-INSENSITIVELY on the email", async () => {
    await addTeamMember(tdb, {
      dealId: DEAL,
      role: "superintendent",
      memberName: "Ext Super",
      memberEmail: EXT_EMAIL,
    });
    await addTeamMember(tdb, {
      dealId: DEAL,
      role: "superintendent",
      memberName: "Ext Super (caps)",
      memberEmail: EXT_EMAIL.toUpperCase(),
    });
    expect(await activeEmailOnlyCount(EXT_EMAIL, "superintendent")).toBe(1);
  });

  it("a duplicate add does NOT restart the notification cycle (no-op → no second cycle)", async () => {
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id = ${SCORECARD}`);
    // First add restarts the cycle (one job) and clears the stamp.
    await addTeamMember(
      tdb,
      { dealId: DEAL, role: "superintendent", memberName: "Ext Super", memberEmail: EXT_EMAIL },
      OFFICE,
    );
    expect(await correctiveJobCount()).toBe(1);
    // Re-stamp as sent so a second restart would be observable.
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id = ${SCORECARD}`);

    // Duplicate add: a no-op → NO second job and the re-stamp survives.
    await addTeamMember(
      tdb,
      { dealId: DEAL, role: "superintendent", memberName: "Ext Super (dup)", memberEmail: EXT_EMAIL },
      OFFICE,
    );
    expect(await correctiveJobCount()).toBe(1);
    const sentAt = await tdb.execute(
      sql`SELECT corrective_action_email_sent_at AS s FROM field_scorecards WHERE id = ${SCORECARD}`,
    );
    expect((sentAt.rows[0] as { s: unknown }).s).not.toBeNull();
  });

  it("a DIFFERENT role for the same email is NOT deduped (distinct responder role)", async () => {
    await addTeamMember(tdb, {
      dealId: DEAL,
      role: "superintendent",
      memberName: "Ext Person",
      memberEmail: EXT_EMAIL,
    });
    await addTeamMember(tdb, {
      dealId: DEAL,
      role: "project_manager",
      memberName: "Ext Person",
      memberEmail: EXT_EMAIL,
    });
    // The index keys on role too, so super + PM for the same email are two distinct active assignments.
    expect(await activeEmailOnlyCount(EXT_EMAIL, "superintendent")).toBe(1);
    expect(await activeEmailOnlyCount(EXT_EMAIL, "project_manager")).toBe(1);
  });
});

describe("migration 0196 file shape", () => {
  const migrationPath = resolve(
    import.meta.dirname,
    "../../../../migrations/0196_deal_team_members_email_only_uidx.sql",
  );
  const migration = readFileSync(migrationPath, "utf8");

  it("creates the case-insensitive partial email-only unique index in the per-office DO-loop", () => {
    expect(migration).toContain("deal_team_members_deal_email_role_uidx");
    expect(migration).toContain("(deal_id, lower(member_email), role)");
    expect(migration).toContain(
      "WHERE user_id IS NULL AND contact_id IS NULL AND is_active = TRUE AND member_email IS NOT NULL",
    );
    expect(migration).toContain("LIKE 'office\\_%'");
    expect(migration).toContain("to_regclass(format('%I.deal_team_members', schema_name))");
  });

  it("has a matching TENANT_SCHEMA block for the office provisioner (parity with the DO-loop)", () => {
    expect(migration).toContain("-- TENANT_SCHEMA_START");
    expect(migration).toContain("-- TENANT_SCHEMA_END");
    const block = migration.slice(
      migration.indexOf("-- TENANT_SCHEMA_START"),
      migration.indexOf("-- TENANT_SCHEMA_END"),
    );
    expect(block).toContain(
      "ON office_dallas.deal_team_members (deal_id, lower(member_email), role)",
    );
    expect(block).toContain(
      "WHERE user_id IS NULL AND contact_id IS NULL AND is_active = TRUE AND member_email IS NOT NULL",
    );
  });
});
