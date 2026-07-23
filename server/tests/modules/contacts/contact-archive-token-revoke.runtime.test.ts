import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { addTeamMember } from "../../../src/modules/deals/team-service.js";
import { deleteContact, updateContact } from "../../../src/modules/contacts/service.js";
import {
  mintCorrectiveActionToken,
  verifyCorrectiveActionToken,
} from "../../../src/modules/field/corrective-action-tokens.js";
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

// Archiving (soft-deleting) a contact-backed super/PM must revoke that contact's outstanding corrective-action
// web tokens on the deals it was a responder on — verifyCorrectiveActionToken checks only hash + expiry, so an
// archived contact would otherwise keep read/write access to the responder page for the token TTL (30 days).
const DEAL_A = "11111111-1111-1111-1111-111111111111";
const DEAL_B = "11111111-1111-1111-1111-1111111111bb";
const USER = "33333333-3333-3333-3333-333333333333";
const SCORECARD_A = "55555555-5555-5555-5555-00000000000a";
const SCORECARD_B = "55555555-5555-5555-5555-00000000000b";
const PM_CONTACT = "22222222-2222-2222-2222-2222222222aa";
const OTHER_CONTACT = "22222222-2222-2222-2222-2222222222bb";
const PM_EMAIL = "pm.contact@example.com";
const OTHER_EMAIL = "other.contact@example.com";

let pg: PGlite;
let tdb: any;

const OFFICE = { id: "00000000-0000-0000-0000-0000000000f1", slug: "test" };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true);
    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text);
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
  // updateContact reads getContactById, whose select carries subqueries over these auxiliary tables
  // (linked-deals count / primary flag / last-touch). Create minimal shapes so the read succeeds.
  await pg.exec(`
    CREATE TABLE contact_deal_associations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, deal_id uuid, is_primary boolean DEFAULT false);
    CREATE TABLE activities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, occurred_at timestamptz);
    CREATE TABLE emails (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, sent_at timestamptz);
    CREATE TABLE tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, updated_at timestamptz);
  `);
  await pg.exec(`INSERT INTO public.users (id, display_name, email, is_active) VALUES ('${USER}', 'Sam Super', 'sam.super@trock.com', true);`);
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

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM public.job_queue`);
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_tokens`);
  await tdb.execute(sql`DELETE FROM deal_team_members`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`DELETE FROM contacts`);
  // Two contacts; the PM_CONTACT is a super/PM responder, OTHER_CONTACT is unrelated.
  await tdb.execute(sql`
    INSERT INTO contacts (id, first_name, last_name, email, category, is_active)
    VALUES
      (${PM_CONTACT}, 'Pat', 'Manager', ${PM_EMAIL}, 'other', true),
      (${OTHER_CONTACT}, 'Uma', 'Related', ${OTHER_EMAIL}, 'other', true)
  `);
  // Two scorecards on two different deals.
  await tdb.execute(sql`
    INSERT INTO field_scorecards (id, client_submission_id, deal_id, week_of, form_version, kind, total_score, rating, status, submitted_by)
    VALUES
      (${SCORECARD_A}, '66666666-0000-0000-0000-00000000000a', ${DEAL_A}, '2026-06-30', 1, 'project', 60, 'corrective_action', 'corrective_action_open', ${USER}),
      (${SCORECARD_B}, '66666666-0000-0000-0000-00000000000b', ${DEAL_B}, '2026-06-30', 1, 'project', 60, 'corrective_action', 'corrective_action_open', ${USER})
  `);
});

describe("deleteContact revokes an archived contact-backed responder's corrective-action tokens", () => {
  it("archiving a contact-backed PM revokes its token so it no longer authorizes", async () => {
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: PM_CONTACT, role: "project_manager" });
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD_A,
      recipientEmail: PM_EMAIL,
      role: "project_manager",
      ttlDays: 30,
    });
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).not.toBeNull();

    await deleteContact(tdb, PM_CONTACT, "director");

    expect(await verifyCorrectiveActionToken(tdb, rawToken)).toBeNull();
    // The team assignment is also deactivated.
    const dtm = await tdb.execute(
      sql`SELECT is_active FROM deal_team_members WHERE contact_id = ${PM_CONTACT}`,
    );
    expect(dtm.rows[0].is_active).toBe(false);
  });

  it("revokes across EVERY deal the contact was a super/PM on (multiple deals)", async () => {
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: PM_CONTACT, role: "project_manager" });
    await addTeamMember(tdb, { dealId: DEAL_B, contactId: PM_CONTACT, role: "superintendent" });
    const a = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD_A,
      recipientEmail: PM_EMAIL,
      role: "project_manager",
      ttlDays: 30,
    });
    const b = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD_B,
      recipientEmail: PM_EMAIL,
      role: "superintendent",
      ttlDays: 30,
    });

    await deleteContact(tdb, PM_CONTACT, "admin");

    expect(await verifyCorrectiveActionToken(tdb, a.rawToken)).toBeNull();
    expect(await verifyCorrectiveActionToken(tdb, b.rawToken)).toBeNull();
  });

  it("leaves an UNRELATED contact's tokens untouched", async () => {
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: PM_CONTACT, role: "project_manager" });
    await addTeamMember(tdb, { dealId: DEAL_B, contactId: OTHER_CONTACT, role: "project_manager" });
    const target = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD_A,
      recipientEmail: PM_EMAIL,
      role: "project_manager",
      ttlDays: 30,
    });
    const unrelated = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD_B,
      recipientEmail: OTHER_EMAIL,
      role: "project_manager",
      ttlDays: 30,
    });

    await deleteContact(tdb, PM_CONTACT, "director");

    expect(await verifyCorrectiveActionToken(tdb, target.rawToken)).toBeNull();
    // The other contact was never archived → its token still authorizes.
    expect(await verifyCorrectiveActionToken(tdb, unrelated.rawToken)).not.toBeNull();
  });

  it("KEEPS the token when another ACTIVE super/PM on the deal shares the archived contact's email", async () => {
    // The archived contact shares PM_EMAIL with an email-only assignment that stays active → the token is still
    // legitimately held, so the shared revoke helper must not delete it.
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: PM_CONTACT, role: "project_manager" });
    await addTeamMember(tdb, {
      dealId: DEAL_A,
      role: "superintendent",
      memberName: "Shared Mailbox",
      memberEmail: PM_EMAIL,
    });
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD_A,
      recipientEmail: PM_EMAIL,
      role: "project_manager",
      ttlDays: 30,
    });

    await deleteContact(tdb, PM_CONTACT, "director");

    expect(await verifyCorrectiveActionToken(tdb, rawToken)).not.toBeNull();
  });
});

describe("archiving a super/PM contact restarts each affected deal's open corrective-action cycle (finding D)", () => {
  it("clears sent_at + prior-cycle tokens and enqueues a fresh job per affected deal's open card", async () => {
    // Archiving a super/PM contact is a responder removal. If an older active assignment remains, resolution
    // falls back to it — but the fallback's prior token was deleted when the newer row was added and the sent
    // stamp is still set, so without a restart the fallback is stranded. Assert the restart clears the stamp,
    // drops prior-cycle tokens, and enqueues one fresh job for each affected deal's open card.
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id = ${SCORECARD_A}`);
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: PM_CONTACT, role: "project_manager" });
    // A prior-cycle token that the restart must clear.
    await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD_A,
      recipientEmail: PM_EMAIL,
      role: "project_manager",
      ttlDays: 30,
    });
    expect(await correctiveJobCount()).toBe(0);

    await deleteContact(tdb, PM_CONTACT, "director", OFFICE);

    // The open card's sent stamp is cleared, its tokens are gone, and exactly one fresh job was enqueued.
    const sentAt = await tdb.execute(
      sql`SELECT corrective_action_email_sent_at AS s FROM field_scorecards WHERE id = ${SCORECARD_A}`,
    );
    expect((sentAt.rows[0] as { s: unknown }).s).toBeNull();
    const tokens = await tdb.execute(
      sql`SELECT COUNT(*)::int AS c FROM scorecard_corrective_action_tokens WHERE scorecard_id = ${SCORECARD_A}`,
    );
    expect((tokens.rows[0] as { c: number }).c).toBe(0);
    expect(await correctiveJobCount()).toBe(1);
    const job = await tdb.execute(
      sql`SELECT office_id, status, max_attempts, payload FROM public.job_queue WHERE job_type = 'scorecard_corrective_action_email' LIMIT 1`,
    );
    const jr = job.rows[0] as { office_id: string; status: string; max_attempts: number; payload: any };
    expect(jr.office_id).toBe(OFFICE.id);
    expect(jr.payload.tenantSchema).toBe(`office_${OFFICE.slug}`);
    expect(jr.payload.scorecardId).toBe(SCORECARD_A);
    expect(jr.payload.dealId).toBe(DEAL_A);
  });

  it("restarts across EVERY deal the contact was a super/PM on (multiple deals)", async () => {
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id IN (${SCORECARD_A}, ${SCORECARD_B})`);
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: PM_CONTACT, role: "project_manager" });
    await addTeamMember(tdb, { dealId: DEAL_B, contactId: PM_CONTACT, role: "superintendent" });

    await deleteContact(tdb, PM_CONTACT, "admin", OFFICE);

    // One fresh job per affected deal's open card (two deals → two jobs).
    expect(await correctiveJobCount()).toBe(2);
    const perDeal = await tdb.execute(sql`
      SELECT payload->>'scorecardId' AS sid FROM public.job_queue WHERE job_type = 'scorecard_corrective_action_email'
    `);
    const sids = (perDeal.rows as { sid: string }[]).map((r) => r.sid).sort();
    expect(sids).toEqual([SCORECARD_A, SCORECARD_B].sort());
  });

  it("does NOT restart when NO office context was threaded (best-effort, skipped)", async () => {
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id = ${SCORECARD_A}`);
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: PM_CONTACT, role: "project_manager" });

    // No office threaded → the restart is skipped (the token revoke still runs). No job, stamp untouched.
    await deleteContact(tdb, PM_CONTACT, "director");

    expect(await correctiveJobCount()).toBe(0);
    const sentAt = await tdb.execute(
      sql`SELECT corrective_action_email_sent_at AS s FROM field_scorecards WHERE id = ${SCORECARD_A}`,
    );
    expect((sentAt.rows[0] as { s: unknown }).s).not.toBeNull();
  });
});

describe("changing a super/PM contact's EMAIL restarts each affected deal's open cycle (finding P2)", () => {
  it("clears sent_at + prior-cycle tokens and enqueues a fresh job per affected deal's open card", async () => {
    // Changing a super/PM contact's email 403s the old delivered token (recipient-email no longer matches the
    // active assignment) while the new address never got a link. The email UPDATE must restart the cycle so the
    // worker re-sends a working link to the NEW email. The PM_CONTACT is an active PM on TWO deals.
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id IN (${SCORECARD_A}, ${SCORECARD_B})`);
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: PM_CONTACT, role: "project_manager" });
    await addTeamMember(tdb, { dealId: DEAL_B, contactId: PM_CONTACT, role: "superintendent" });
    // A prior-cycle token keyed to the OLD email that the restart must clear.
    await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD_A,
      recipientEmail: PM_EMAIL,
      role: "project_manager",
      ttlDays: 30,
    });
    expect(await correctiveJobCount()).toBe(0);

    await updateContact(tdb, PM_CONTACT, { email: "pat.new@example.com" }, OFFICE);

    // Both affected deals' open cards: sent stamp cleared, prior-cycle tokens dropped, one fresh job each.
    const sentAt = await tdb.execute(
      sql`SELECT id, corrective_action_email_sent_at AS s FROM field_scorecards WHERE id IN (${SCORECARD_A}, ${SCORECARD_B})`,
    );
    for (const row of sentAt.rows as { s: unknown }[]) expect(row.s).toBeNull();
    const tokens = await tdb.execute(
      sql`SELECT COUNT(*)::int AS c FROM scorecard_corrective_action_tokens WHERE scorecard_id = ${SCORECARD_A}`,
    );
    expect((tokens.rows[0] as { c: number }).c).toBe(0);
    expect(await correctiveJobCount()).toBe(2);
    const sids = (
      await tdb.execute(sql`
        SELECT payload->>'scorecardId' AS sid FROM public.job_queue WHERE job_type = 'scorecard_corrective_action_email'
      `)
    ).rows as { sid: string }[];
    expect(sids.map((r) => r.sid).sort()).toEqual([SCORECARD_A, SCORECARD_B].sort());
  });

  it("an UNRELATED field change (no email change) does NOT restart the cycle", async () => {
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id = ${SCORECARD_A}`);
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: PM_CONTACT, role: "project_manager" });
    expect(await correctiveJobCount()).toBe(0);

    // A non-email edit (job title) leaves the recipient email intact → the delivered token still verifies → no
    // restart, sent stamp untouched, no job.
    await updateContact(tdb, PM_CONTACT, { jobTitle: "Site Lead" }, OFFICE);

    expect(await correctiveJobCount()).toBe(0);
    const sentAt = await tdb.execute(
      sql`SELECT corrective_action_email_sent_at AS s FROM field_scorecards WHERE id = ${SCORECARD_A}`,
    );
    expect((sentAt.rows[0] as { s: unknown }).s).not.toBeNull();
  });

  it("changing the email of a NON-responder contact does NOT restart (not an active super/PM)", async () => {
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id = ${SCORECARD_A}`);
    // OTHER_CONTACT is not on any deal team as a super/PM → an email change touches no responder assignment.
    expect(await correctiveJobCount()).toBe(0);

    await updateContact(tdb, OTHER_CONTACT, { email: "uma.new@example.com" }, OFFICE);

    expect(await correctiveJobCount()).toBe(0);
    const sentAt = await tdb.execute(
      sql`SELECT corrective_action_email_sent_at AS s FROM field_scorecards WHERE id = ${SCORECARD_A}`,
    );
    expect((sentAt.rows[0] as { s: unknown }).s).not.toBeNull();
  });

  it("does NOT restart when NO office context was threaded (best-effort, skipped)", async () => {
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id = ${SCORECARD_A}`);
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: PM_CONTACT, role: "project_manager" });

    // No office threaded → the restart is skipped. No job, stamp untouched (the email still changes).
    await updateContact(tdb, PM_CONTACT, { email: "pat.noff@example.com" });

    expect(await correctiveJobCount()).toBe(0);
    const sentAt = await tdb.execute(
      sql`SELECT corrective_action_email_sent_at AS s FROM field_scorecards WHERE id = ${SCORECARD_A}`,
    );
    expect((sentAt.rows[0] as { s: unknown }).s).not.toBeNull();
    const updated = await tdb.execute(sql`SELECT email FROM contacts WHERE id = ${PM_CONTACT}`);
    expect((updated.rows[0] as { email: string }).email).toBe("pat.noff@example.com");
  });
});
