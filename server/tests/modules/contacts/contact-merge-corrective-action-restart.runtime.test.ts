import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { addTeamMember } from "../../../src/modules/deals/team-service.js";
import { mergeContacts } from "../../../src/modules/contacts/merge-service.js";
import {
  mintCorrectiveActionToken,
  verifyCorrectiveActionToken,
} from "../../../src/modules/field/corrective-action-tokens.js";
import {
  dealTeamMembers,
  contacts,
  deals,
  duplicateQueue,
  emails,
  activities,
  files,
  tasks,
  contactDealAssociations,
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
  scorecardCorrectiveActions,
  scorecardCorrectiveActionTokens,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

// Merging a contact repoints its active deal_team_members rows to the winner. If the loser was an active
// super/PM on a deal with an OPEN corrective-action card and the winner's email DIFFERS, verify-time
// revalidation 403s the delivered loser-email token while corrective_action_email_sent_at stays set → the
// winner never gets a link (stranded). mergeContacts must revoke the orphaned token and restart the cycle.
const DEAL_A = "11111111-1111-1111-1111-111111111111";
const DEAL_B = "11111111-1111-1111-1111-1111111111bb";
const USER = "33333333-3333-3333-3333-333333333333";
const SCORECARD_A = "55555555-5555-5555-5555-00000000000a";
const SCORECARD_B = "55555555-5555-5555-5555-00000000000b";
const WINNER = "22222222-2222-2222-2222-2222222222aa";
const LOSER = "22222222-2222-2222-2222-2222222222bb";
const PLAIN_CONTACT = "22222222-2222-2222-2222-2222222222cc";
const RESOLVER = "44444444-4444-4444-4444-444444444444";
const WINNER_EMAIL = "winner@example.com";
const LOSER_EMAIL = "loser@example.com";

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
      duplicateQueue,
      emails,
      activities,
      files,
      tasks,
      contactDealAssociations,
      fieldScorecards,
      fieldScorecardItems,
      fieldScorecardPhotos,
      scorecardCorrectiveActions,
      scorecardCorrectiveActionTokens,
    ]),
  );
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
  // Winner + loser share the responder role; a third plain contact is unrelated to any deal team.
  await tdb.execute(sql`
    INSERT INTO contacts (id, first_name, last_name, email, category, is_active)
    VALUES
      (${WINNER}, 'Win', 'Ner', ${WINNER_EMAIL}, 'other', true),
      (${LOSER}, 'Los', 'Er', ${LOSER_EMAIL}, 'other', true),
      (${PLAIN_CONTACT}, 'Plain', 'Jane', 'plain@example.com', 'other', true)
  `);
  // Two open corrective-action scorecards on two deals.
  await tdb.execute(sql`
    INSERT INTO field_scorecards (id, client_submission_id, deal_id, week_of, form_version, kind, total_score, rating, status, submitted_by)
    VALUES
      (${SCORECARD_A}, '66666666-0000-0000-0000-00000000000a', ${DEAL_A}, '2026-06-30', 1, 'project', 60, 'corrective_action', 'corrective_action_open', ${USER}),
      (${SCORECARD_B}, '66666666-0000-0000-0000-00000000000b', ${DEAL_B}, '2026-06-30', 1, 'project', 60, 'corrective_action', 'corrective_action_open', ${USER})
  `);
});

describe("mergeContacts restarts each affected deal's open corrective-action cycle (finding P2)", () => {
  it("winner has a DIFFERENT email → revokes the orphaned loser-email token, clears sent_at, and enqueues one fresh job per affected deal", async () => {
    // Loser is an active super on DEAL_A and PM on DEAL_B; both cards were already notified to the loser's email.
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: LOSER, role: "superintendent" });
    await addTeamMember(tdb, { dealId: DEAL_B, contactId: LOSER, role: "project_manager" });
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id IN (${SCORECARD_A}, ${SCORECARD_B})`);
    // The delivered token keyed to the LOSER email — after merge it must no longer authorize.
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD_A,
      recipientEmail: LOSER_EMAIL,
      role: "superintendent",
      ttlDays: 30,
    });
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).not.toBeNull();
    expect(await correctiveJobCount()).toBe(0);

    await mergeContacts(tdb, WINNER, LOSER, RESOLVER, undefined, OFFICE);

    // Both affected deals' open cards: sent stamp cleared and one fresh job each.
    const sentAt = await tdb.execute(
      sql`SELECT corrective_action_email_sent_at AS s FROM field_scorecards WHERE id IN (${SCORECARD_A}, ${SCORECARD_B})`,
    );
    for (const row of sentAt.rows as { s: unknown }[]) expect(row.s).toBeNull();
    expect(await correctiveJobCount()).toBe(2);
    const sids = (
      await tdb.execute(sql`
        SELECT payload->>'scorecardId' AS sid FROM public.job_queue WHERE job_type = 'scorecard_corrective_action_email'
      `)
    ).rows as { sid: string }[];
    expect(sids.map((r) => r.sid).sort()).toEqual([SCORECARD_A, SCORECARD_B].sort());
    // Job routing carries the threaded office context.
    const job = await tdb.execute(
      sql`SELECT office_id, payload FROM public.job_queue WHERE job_type = 'scorecard_corrective_action_email' LIMIT 1`,
    );
    const jr = job.rows[0] as { office_id: string; payload: any };
    expect(jr.office_id).toBe(OFFICE.id);
    expect(jr.payload.tenantSchema).toBe(`office_${OFFICE.slug}`);
    // The delivered loser-email token was revoked (a fresh cycle drops prior tokens) and no longer authorizes.
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).toBeNull();
    // The assignment now resolves to the winner.
    const dtm = await tdb.execute(
      sql`SELECT contact_id FROM deal_team_members WHERE deal_id = ${DEAL_A} AND is_active = true`,
    );
    expect((dtm.rows[0] as { contact_id: string }).contact_id).toBe(WINNER);
  });

  it("winner has the SAME email → no restart (delivered token still resolves to the winner)", async () => {
    // Give the winner the loser's email so resolution is unchanged after the repoint.
    await tdb.execute(sql`UPDATE contacts SET email = ${LOSER_EMAIL} WHERE id = ${WINNER}`);
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: LOSER, role: "superintendent" });
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id = ${SCORECARD_A}`);
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD_A,
      recipientEmail: LOSER_EMAIL,
      role: "superintendent",
      ttlDays: 30,
    });

    await mergeContacts(tdb, WINNER, LOSER, RESOLVER, undefined, OFFICE);

    expect(await correctiveJobCount()).toBe(0);
    const sentAt = await tdb.execute(
      sql`SELECT corrective_action_email_sent_at AS s FROM field_scorecards WHERE id = ${SCORECARD_A}`,
    );
    expect((sentAt.rows[0] as { s: unknown }).s).not.toBeNull();
    // The token still resolves — the winner now carries that same email as the active responder.
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).not.toBeNull();
  });

  it("winner had NO email (absorbs the loser's) → resolution unchanged, no restart", async () => {
    await tdb.execute(sql`UPDATE contacts SET email = NULL WHERE id = ${WINNER}`);
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: LOSER, role: "superintendent" });
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id = ${SCORECARD_A}`);

    await mergeContacts(tdb, WINNER, LOSER, RESOLVER, undefined, OFFICE);

    // Winner absorbed the loser's email → same address → the delivered token still resolves → no restart.
    expect(await correctiveJobCount()).toBe(0);
    const sentAt = await tdb.execute(
      sql`SELECT corrective_action_email_sent_at AS s FROM field_scorecards WHERE id = ${SCORECARD_A}`,
    );
    expect((sentAt.rows[0] as { s: unknown }).s).not.toBeNull();
    const w = await tdb.execute(sql`SELECT email FROM contacts WHERE id = ${WINNER}`);
    expect((w.rows[0] as { email: string }).email).toBe(LOSER_EMAIL);
  });

  it("merge NOT touching a responder assignment does NOT restart the cycle", async () => {
    // The loser is only a non-responder team member (or not on any deal team) → no super/PM repoint, no card
    // resolution changes. Loser is a plain deal-team `other` role on DEAL_A, which the restart must ignore.
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: LOSER, role: "other" });
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id = ${SCORECARD_A}`);

    await mergeContacts(tdb, WINNER, LOSER, RESOLVER, undefined, OFFICE);

    expect(await correctiveJobCount()).toBe(0);
    const sentAt = await tdb.execute(
      sql`SELECT corrective_action_email_sent_at AS s FROM field_scorecards WHERE id = ${SCORECARD_A}`,
    );
    expect((sentAt.rows[0] as { s: unknown }).s).not.toBeNull();
  });

  it("no office threaded → best-effort restart is skipped even when the email differs", async () => {
    await addTeamMember(tdb, { dealId: DEAL_A, contactId: LOSER, role: "superintendent" });
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id = ${SCORECARD_A}`);

    // No office passed → the restart is skipped (the merge itself still repoints the assignment).
    await mergeContacts(tdb, WINNER, LOSER, RESOLVER);

    expect(await correctiveJobCount()).toBe(0);
    const sentAt = await tdb.execute(
      sql`SELECT corrective_action_email_sent_at AS s FROM field_scorecards WHERE id = ${SCORECARD_A}`,
    );
    expect((sentAt.rows[0] as { s: unknown }).s).not.toBeNull();
    const dtm = await tdb.execute(
      sql`SELECT contact_id FROM deal_team_members WHERE deal_id = ${DEAL_A} AND is_active = true`,
    );
    expect((dtm.rows[0] as { contact_id: string }).contact_id).toBe(WINNER);
  });
});
