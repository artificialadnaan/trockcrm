import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { resolveCorrectiveActionRecipients } from "../../../src/modules/field/corrective-action-recipients.js";
import { dealTeamMembers, contacts } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
const OTHER_DEAL = "22222222-2222-2222-2222-222222222222";
const SUPER_USER = "33333333-3333-3333-3333-333333333333";
const DEACTIVATED_USER = "33333333-3333-3333-3333-3333333333de";

let pg: PGlite;
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true);
  `);
  await pg.exec(tenantSchemaSql("public", [dealTeamMembers, contacts]));
  await pg.exec(`
    INSERT INTO public.users (id, display_name, email, is_active) VALUES
      ('${SUPER_USER}', 'Sam Super', 'sam.super@trock.com', true),
      ('${DEACTIVATED_USER}', 'Gone User', 'gone.user@trock.com', false);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM deal_team_members`);
});

describe("resolveCorrectiveActionRecipients", () => {
  it("returns the super (CRM user) + PM (email-only), with the right identity per row", async () => {
    // Superintendent = a CRM user → email/name from public.users, userId set.
    await tdb.insert(dealTeamMembers).values({
      dealId: DEAL,
      userId: SUPER_USER,
      role: "superintendent",
    });
    // PM = an email-only member → user_id + contact_id both null; email/name from member_email/member_name.
    await tdb.insert(dealTeamMembers).values({
      dealId: DEAL,
      memberName: "Dana Cole",
      memberEmail: "dana.cole@example.com",
      role: "project_manager",
    });
    // An INACTIVE member (is_active false) — must be ignored.
    await tdb.insert(dealTeamMembers).values({
      dealId: DEAL,
      memberName: "Old Super",
      memberEmail: "old.super@example.com",
      role: "superintendent",
      isActive: false,
    });
    // A member whose role is neither super nor PM — must be ignored.
    await tdb.insert(dealTeamMembers).values({
      dealId: DEAL,
      userId: SUPER_USER,
      role: "estimator",
    });

    const recipients = await resolveCorrectiveActionRecipients(tdb, DEAL);
    const byRole = Object.fromEntries(recipients.map((r) => [r.role, r]));

    expect(recipients).toHaveLength(2);

    expect(byRole.superintendent).toEqual({
      role: "superintendent",
      name: "Sam Super",
      email: "sam.super@trock.com",
      userId: SUPER_USER,
    });
    expect(byRole.project_manager).toEqual({
      role: "project_manager",
      name: "Dana Cole",
      email: "dana.cole@example.com",
      userId: null,
    });
  });

  it("skips a role whose CRM user is deactivated (no resolvable active identity)", async () => {
    await tdb.insert(dealTeamMembers).values({
      dealId: DEAL,
      userId: DEACTIVATED_USER,
      role: "superintendent",
    });
    // PM email-only present so the deal has at least one recipient.
    await tdb.insert(dealTeamMembers).values({
      dealId: DEAL,
      memberName: "Dana Cole",
      memberEmail: "dana.cole@example.com",
      role: "project_manager",
    });

    const recipients = await resolveCorrectiveActionRecipients(tdb, DEAL);
    expect(recipients.map((r) => r.role)).toEqual(["project_manager"]);
  });

  it("drops a row with no resolvable email", async () => {
    // An email-only row can't exist without member_email (DB check), but a stray whitespace-only email must
    // still be dropped rather than emailed. The check permits member_email non-null, so store a blank.
    await tdb.insert(dealTeamMembers).values({
      dealId: DEAL,
      memberName: "No Email Super",
      memberEmail: "   ",
      role: "superintendent",
    });
    const recipients = await resolveCorrectiveActionRecipients(tdb, DEAL);
    expect(recipients).toHaveLength(0);
  });

  it("only resolves the requested deal's members", async () => {
    await tdb.insert(dealTeamMembers).values({
      dealId: OTHER_DEAL,
      memberName: "Other Super",
      memberEmail: "other@example.com",
      role: "superintendent",
    });
    const recipients = await resolveCorrectiveActionRecipients(tdb, DEAL);
    expect(recipients).toHaveLength(0);
  });
});
