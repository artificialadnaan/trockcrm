import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { addTeamMember } from "../../../src/modules/deals/team-service.js";
import { deleteContact } from "../../../src/modules/contacts/service.js";
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

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true);
    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text);
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
  await pg.exec(`INSERT INTO public.users (id, display_name, email, is_active) VALUES ('${USER}', 'Sam Super', 'sam.super@trock.com', true);`);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
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
