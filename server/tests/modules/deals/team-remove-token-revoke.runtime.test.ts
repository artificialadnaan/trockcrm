import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { addTeamMember, removeTeamMember, updateTeamMember } from "../../../src/modules/deals/team-service.js";
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

// Removing a deal's super/PM must revoke that recipient's outstanding corrective-action web tokens on the
// deal's scorecards — verifyCorrectiveActionToken checks only hash + expiry, so a removed email-only member
// would otherwise keep read/write access to the responder page until the token TTL expires (30 days).
const DEAL = "11111111-1111-1111-1111-111111111111";
const OTHER_DEAL = "11111111-1111-1111-1111-1111111111ff";
const USER = "33333333-3333-3333-3333-333333333333";
// Two staff users that both resolve to EXT_PM_EMAIL — one active, one deactivated. Used to prove the
// stillAssigned guard requires the OTHER same-email assignment's linked USER to be active.
const ACTIVE_EMAIL_USER = "33333333-3333-3333-3333-3333330000aa";
const INACTIVE_EMAIL_USER = "33333333-3333-3333-3333-3333330000bb";
const SCORECARD = "55555555-5555-5555-5555-000000000001";
const OTHER_SCORECARD = "55555555-5555-5555-5555-0000000000ff";
const EXT_PM_EMAIL = "ext.pm@example.com";

let pg: PGlite;
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true);
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
  await pg.exec(`
    INSERT INTO public.users (id, display_name, email, is_active) VALUES
      ('${USER}', 'Sam Super', 'sam.super@trock.com', true),
      ('${ACTIVE_EMAIL_USER}', 'Active Same-Email PM', '${EXT_PM_EMAIL}', true),
      ('${INACTIVE_EMAIL_USER}', 'Deactivated Same-Email PM', '${EXT_PM_EMAIL}', false);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_tokens`);
  await tdb.execute(sql`DELETE FROM deal_team_members`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  // Two scorecards: one on the deal under test, one on a different deal (its token must NOT be revoked).
  await tdb.execute(sql`
    INSERT INTO field_scorecards (id, client_submission_id, deal_id, week_of, form_version, kind, total_score, rating, status, submitted_by)
    VALUES
      (${SCORECARD}, '66666666-0000-0000-0000-000000000001', ${DEAL}, '2026-06-30', 1, 'project', 60, 'corrective_action', 'corrective_action_open', ${USER}),
      (${OTHER_SCORECARD}, '66666666-0000-0000-0000-0000000000ff', ${OTHER_DEAL}, '2026-06-30', 1, 'project', 60, 'corrective_action', 'corrective_action_open', ${USER})
  `);
});

describe("removeTeamMember revokes the removed recipient's corrective-action tokens", () => {
  it("deletes an email-only PM's token on the deal's scorecard, so it no longer authorizes", async () => {
    const member = await addTeamMember(tdb, {
      dealId: DEAL,
      role: "project_manager",
      memberName: "Ext PM",
      memberEmail: EXT_PM_EMAIL,
    });
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD,
      recipientEmail: EXT_PM_EMAIL,
      role: "project_manager",
      ttlDays: 30,
    });
    // The token authorizes before removal.
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).not.toBeNull();

    await removeTeamMember(tdb, member.id, DEAL);

    // After removal the token is revoked (deleted) → no longer authorizes.
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).toBeNull();
    const remaining = await tdb.execute(
      sql`SELECT COUNT(*)::int AS n FROM scorecard_corrective_action_tokens WHERE recipient_email = ${EXT_PM_EMAIL}`,
    );
    expect(remaining.rows[0].n).toBe(0);
  });

  it("resolves the email from a linked staff user and revokes that user's token", async () => {
    const member = await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "superintendent" });
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD,
      recipientEmail: "sam.super@trock.com",
      role: "superintendent",
      ttlDays: 30,
    });
    await removeTeamMember(tdb, member.id, DEAL);
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).toBeNull();
  });

  it("does NOT revoke a token for the same email on a DIFFERENT deal's scorecard", async () => {
    const member = await addTeamMember(tdb, {
      dealId: DEAL,
      role: "project_manager",
      memberName: "Ext PM",
      memberEmail: EXT_PM_EMAIL,
    });
    // A token for the same recipient but bound to another deal's scorecard.
    const { rawToken: otherToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: OTHER_SCORECARD,
      recipientEmail: EXT_PM_EMAIL,
      role: "project_manager",
      ttlDays: 30,
    });
    await removeTeamMember(tdb, member.id, DEAL);
    // The other deal's token is untouched — removal is scoped to THIS deal's scorecards.
    expect(await verifyCorrectiveActionToken(tdb, otherToken)).not.toBeNull();
  });

  it("keeps the token when another ACTIVE super/PM on the deal still resolves to the same email", async () => {
    // Two email-only PM assignments with the same email (e.g. a duplicate). Removing ONE must not revoke the
    // token, because the other active assignment still legitimately holds it.
    const dup1 = await addTeamMember(tdb, {
      dealId: DEAL,
      role: "project_manager",
      memberName: "Ext PM",
      memberEmail: EXT_PM_EMAIL,
    });
    await addTeamMember(tdb, {
      dealId: DEAL,
      role: "project_manager",
      memberName: "Ext PM (dup)",
      memberEmail: EXT_PM_EMAIL,
    });
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD,
      recipientEmail: EXT_PM_EMAIL,
      role: "project_manager",
      ttlDays: 30,
    });
    await removeTeamMember(tdb, dup1.id, DEAL);
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).not.toBeNull();
  });

  it("REVOKES when the only other same-email assignment is backed by a DEACTIVATED user", async () => {
    // The removed email-only PM shares EXT_PM_EMAIL with another super/PM assignment — but that assignment is
    // backed by a deactivated staff user. A deactivated user does not legitimately hold the token, so the
    // stillAssigned guard must NOT count it: revocation proceeds.
    const emailMember = await addTeamMember(tdb, {
      dealId: DEAL,
      role: "project_manager",
      memberName: "Ext PM",
      memberEmail: EXT_PM_EMAIL,
    });
    await addTeamMember(tdb, { dealId: DEAL, userId: INACTIVE_EMAIL_USER, role: "project_manager" });
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD,
      recipientEmail: EXT_PM_EMAIL,
      role: "project_manager",
      ttlDays: 30,
    });
    await removeTeamMember(tdb, emailMember.id, DEAL);
    // No ACTIVE identity still holds the email → token revoked.
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).toBeNull();
  });

  it("KEEPS the token when another same-email assignment is backed by an ACTIVE user", async () => {
    // Same shape as above but the other assignment's staff user is active → it legitimately holds the token.
    const emailMember = await addTeamMember(tdb, {
      dealId: DEAL,
      role: "project_manager",
      memberName: "Ext PM",
      memberEmail: EXT_PM_EMAIL,
    });
    await addTeamMember(tdb, { dealId: DEAL, userId: ACTIVE_EMAIL_USER, role: "project_manager" });
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD,
      recipientEmail: EXT_PM_EMAIL,
      role: "project_manager",
      ttlDays: 30,
    });
    await removeTeamMember(tdb, emailMember.id, DEAL);
    // The active user still resolves to the same email → token preserved.
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).not.toBeNull();
  });
});

describe("updateTeamMember revokes tokens when a super/PM LEAVES the responder role (finding 4)", () => {
  it("re-roling an email-only super to a non-responder role revokes their token", async () => {
    const member = await addTeamMember(tdb, {
      dealId: DEAL,
      role: "superintendent",
      memberName: "Ext Super",
      memberEmail: EXT_PM_EMAIL,
    });
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD,
      recipientEmail: EXT_PM_EMAIL,
      role: "superintendent",
      ttlDays: 30,
    });
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).not.toBeNull();

    // Re-role super → foreman (a non-responder role). The token must no longer authorize.
    await updateTeamMember(tdb, member.id, DEAL, { role: "foreman" });
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).toBeNull();
  });

  it("a LATERAL super→PM swap keeps the token (they remain a responder)", async () => {
    const member = await addTeamMember(tdb, {
      dealId: DEAL,
      role: "superintendent",
      memberName: "Ext Super",
      memberEmail: EXT_PM_EMAIL,
    });
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD,
      recipientEmail: EXT_PM_EMAIL,
      role: "superintendent",
      ttlDays: 30,
    });
    await updateTeamMember(tdb, member.id, DEAL, { role: "project_manager" });
    // Still a responder (now PM) → the token stays valid.
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).not.toBeNull();
  });

  it("does not revoke on a notes-only update (role unchanged)", async () => {
    const member = await addTeamMember(tdb, {
      dealId: DEAL,
      role: "project_manager",
      memberName: "Ext PM",
      memberEmail: EXT_PM_EMAIL,
    });
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD,
      recipientEmail: EXT_PM_EMAIL,
      role: "project_manager",
      ttlDays: 30,
    });
    await updateTeamMember(tdb, member.id, DEAL, { notes: "left a note" });
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).not.toBeNull();
  });

  it("keeps the token when ANOTHER active super/PM still resolves to the same email after the re-role", async () => {
    // Two same-email super/PM assignments; re-roling ONE off the responder roles must not strand the other.
    const one = await addTeamMember(tdb, {
      dealId: DEAL,
      role: "superintendent",
      memberName: "Ext Super",
      memberEmail: EXT_PM_EMAIL,
    });
    await addTeamMember(tdb, {
      dealId: DEAL,
      role: "project_manager",
      memberName: "Ext PM (same email)",
      memberEmail: EXT_PM_EMAIL,
    });
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: SCORECARD,
      recipientEmail: EXT_PM_EMAIL,
      role: "superintendent",
      ttlDays: 30,
    });
    await updateTeamMember(tdb, one.id, DEAL, { role: "foreman" });
    // The still-active PM assignment holds the same email → token preserved.
    expect(await verifyCorrectiveActionToken(tdb, rawToken)).not.toBeNull();
  });
});
