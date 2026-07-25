import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { resolveScorecardCorrectiveActionRecipients } from "../../../src/modules/field/corrective-action-recipients.js";
import { resolveScorecardResponderPick } from "../../../src/modules/field/field-responders-service.js";
import {
  contacts,
  dealTeamMembers,
  fieldResponders,
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

// The SERVER half of scorecard-scoped recipient resolution. It backs the corrective-action token's verify-time
// revalidation, so it must admit exactly the people the WORKER mints tokens for
// (worker/tests/jobs/scorecard-corrective-action-recipients.runtime.test.ts covers that side against the same
// fixtures) — a disagreement means a link that sends fine and then 403s on its first click.

const DEAL = "11111111-1111-1111-1111-111111111111";
const CARD = "aaaaaaaa-0000-0000-0000-00000000000a";
const SIBLING_CARD = "aaaaaaaa-0000-0000-0000-00000000000b";
const UNKNOWN_CARD = "aaaaaaaa-0000-0000-0000-0000000000ff";
const SUPER_USER = "33333333-3333-3333-3333-333333333333";
const ROSTER_SUPER = "44444444-4444-4444-4444-444444444401";
const ROSTER_PM = "44444444-4444-4444-4444-444444444402";
const ROSTER_INACTIVE = "44444444-4444-4444-4444-444444444403";
const DANGLING = "44444444-4444-4444-4444-4444444444ff";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

async function setPicks(superintendentResponderId: string | null, pmResponderId: string | null, card = CARD) {
  await tdb.execute(sql`
    UPDATE field_scorecards
       SET superintendent_responder_id = ${superintendentResponderId}::uuid,
           pm_responder_id = ${pmResponderId}::uuid
     WHERE id = ${card}
  `);
}

/** role:email pairs, sorted — the shape every assertion below compares. */
function pairs(recipients: Array<{ role: string; email: string }>): string[] {
  return recipients.map((r) => `${r.role}:${r.email}`).sort();
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true);
  `);
  await pg.exec(
    tenantSchemaSql("public", [
      dealTeamMembers,
      contacts,
      fieldResponders,
      fieldScorecards,
      fieldScorecardItems,
      fieldScorecardPhotos,
    ]),
  );
  await pg.exec(`
    INSERT INTO public.users (id, display_name, email, is_active) VALUES
      ('${SUPER_USER}', 'Sam Super', 'sam.super@trock.com', true);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM deal_team_members`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`DELETE FROM field_responders`);

  await tdb.insert(fieldResponders).values([
    { id: ROSTER_SUPER, name: "James Helms", email: "james@trock.test", role: "superintendent" },
    { id: ROSTER_PM, name: "Tim Mitchell", email: "tim@trock.test", role: "project_manager" },
    { id: ROSTER_INACTIVE, name: "Gone Guy", email: "gone@trock.test", role: "superintendent", isActive: false },
  ]);
  for (const [id, submissionId] of [
    [CARD, "bbbbbbbb-0000-0000-0000-00000000000a"],
    [SIBLING_CARD, "bbbbbbbb-0000-0000-0000-00000000000b"],
  ]) {
    await tdb.execute(sql`
      INSERT INTO field_scorecards (id, deal_id, client_submission_id, week_of, total_score, rating, submitted_by)
      VALUES (${id}, ${DEAL}, ${submissionId}, '2026-07-20', 60, 'corrective_action', ${SUPER_USER})
    `);
  }
  // The deal team: a CRM-user superintendent and an email-only PM.
  await tdb.insert(dealTeamMembers).values([
    { dealId: DEAL, userId: SUPER_USER, role: "superintendent" },
    { dealId: DEAL, memberName: "Team PM", memberEmail: "team.pm@trock.test", role: "project_manager" },
  ]);
});

describe("resolveScorecardCorrectiveActionRecipients", () => {
  it("with no pick, returns exactly the deal-team resolution", async () => {
    const recipients = await resolveScorecardCorrectiveActionRecipients(tdb, CARD);
    expect(pairs(recipients)).toEqual([
      "project_manager:team.pm@trock.test",
      "superintendent:sam.super@trock.com",
    ]);
    expect(recipients.find((r) => r.role === "superintendent")?.userId).toBe(SUPER_USER);
  });

  it("a picked superintendent replaces the deal-team superintendent, leaving the PM alone", async () => {
    await setPicks(ROSTER_SUPER, null);
    const recipients = await resolveScorecardCorrectiveActionRecipients(tdb, CARD);
    expect(pairs(recipients)).toEqual([
      "project_manager:team.pm@trock.test",
      "superintendent:james@trock.test",
    ]);
  });

  it("marks a picked responder email-only (userId null) so they authorize by token, never a session", async () => {
    // field_responders carries no CRM identity, so a pick can never grant in-app/session access. If userId
    // were ever populated here the responder would be treated as a CRM user by the deep-link branch.
    await setPicks(ROSTER_SUPER, null);
    const picked = (await resolveScorecardCorrectiveActionRecipients(tdb, CARD)).find(
      (r) => r.role === "superintendent",
    )!;
    expect(picked.userId).toBeNull();
    expect(picked.name).toBe("James Helms");
  });

  it("resolves picks for both roles at once", async () => {
    await setPicks(ROSTER_SUPER, ROSTER_PM);
    expect(pairs(await resolveScorecardCorrectiveActionRecipients(tdb, CARD))).toEqual([
      "project_manager:tim@trock.test",
      "superintendent:james@trock.test",
    ]);
  });

  it("stops honoring a pick as soon as the roster person is deactivated (this IS the revoke)", async () => {
    // There is no separate token-revocation hook for the roster: because this resolver re-reads the roster row
    // on every verify, a deactivated person's outstanding link stops authorizing on their very next request.
    await setPicks(ROSTER_INACTIVE, null);
    const recipients = await resolveScorecardCorrectiveActionRecipients(tdb, CARD);
    expect(pairs(recipients)).toEqual([
      "project_manager:team.pm@trock.test",
      "superintendent:sam.super@trock.com",
    ]);
    expect(recipients.map((r) => r.email)).not.toContain("gone@trock.test");
  });

  it("ignores a pick whose roster row now holds the other role", async () => {
    await setPicks(ROSTER_PM, null);
    const recipients = await resolveScorecardCorrectiveActionRecipients(tdb, CARD);
    expect(recipients.find((r) => r.role === "superintendent")?.email).toBe("sam.super@trock.com");
  });

  it("ignores a dangling pick (the roster row was deleted) rather than dropping the role", async () => {
    await setPicks(DANGLING, null);
    const recipients = await resolveScorecardCorrectiveActionRecipients(tdb, CARD);
    expect(recipients.find((r) => r.role === "superintendent")?.email).toBe("sam.super@trock.com");
  });

  it("notifies a picked role that has no deal-team assignment at all", async () => {
    await tdb.execute(sql`DELETE FROM deal_team_members WHERE role = 'superintendent'`);
    await setPicks(ROSTER_SUPER, null);
    expect(pairs(await resolveScorecardCorrectiveActionRecipients(tdb, CARD))).toEqual([
      "project_manager:team.pm@trock.test",
      "superintendent:james@trock.test",
    ]);
  });

  it("scopes a pick to its OWN card — a sibling scorecard on the same deal is unaffected", async () => {
    await setPicks(ROSTER_SUPER, null, CARD);
    expect(
      (await resolveScorecardCorrectiveActionRecipients(tdb, SIBLING_CARD)).find(
        (r) => r.role === "superintendent",
      )?.email,
    ).toBe("sam.super@trock.com");
  });

  it("returns [] for an unknown scorecard rather than resolving some other deal's team", async () => {
    expect(await resolveScorecardCorrectiveActionRecipients(tdb, UNKNOWN_CARD)).toEqual([]);
  });
});

describe("resolveScorecardResponderPick (storage-time validation)", () => {
  it("accepts an active roster row whose role matches the slot, returning the address to notify", async () => {
    expect(await resolveScorecardResponderPick(tdb, ROSTER_SUPER, "superintendent")).toEqual({
      id: ROSTER_SUPER,
      name: "James Helms",
      email: "james@trock.test",
    });
  });

  it("rejects a role mismatch, a deactivated row, an unknown id, and an absent id — all as null", async () => {
    expect(await resolveScorecardResponderPick(tdb, ROSTER_PM, "superintendent")).toBeNull();
    expect(await resolveScorecardResponderPick(tdb, ROSTER_INACTIVE, "superintendent")).toBeNull();
    expect(await resolveScorecardResponderPick(tdb, DANGLING, "superintendent")).toBeNull();
    expect(await resolveScorecardResponderPick(tdb, null, "superintendent")).toBeNull();
    expect(await resolveScorecardResponderPick(tdb, undefined, "project_manager")).toBeNull();
  });

  it("returns null (never throws) for a malformed id, so a bad value can't 500 a field submit", async () => {
    // A scorecard filed from the truck must save even if its picked-responder hint is garbage; the link is
    // optional and degrades to the deal-team fallback.
    expect(await resolveScorecardResponderPick(tdb, "not-a-uuid", "superintendent")).toBeNull();
    expect(await resolveScorecardResponderPick(tdb, "", "project_manager")).toBeNull();
  });
});
