import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { dealTeamMembers } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  listFieldResponders,
  createFieldResponder,
  updateFieldResponder,
  listFieldResponderAssignments,
} from "../../../src/modules/field/field-responders-service.js";
import { addTeamMember } from "../../../src/modules/deals/team-service.js";
import { resolveCorrectiveActionRecipients } from "../../../src/modules/field/corrective-action-recipients.js";

// SERVICE behavior for the field-responder roster (migration 0198), exercised against PGlite. The schema helper
// (tenantSchemaSql) emits column types verbatim from the real Drizzle defs but OMITS indexes/FKs; migration 0198
// adds the field_responders table + its ACTIVE-only case-insensitive email partial unique index + the
// deal_team_members.responder_id column. So here we:
//   - build deal_team_members from its Drizzle def (which already carries responder_id),
//   - apply the migration's field_responders table DDL + the partial unique index explicitly (the create/update
//     paths rely on it for the 409-on-duplicate active email),
//   - and stand up a minimal `deals` table (id, name, is_active) so assignmentCount / listAssignments (which JOIN
//     deals and filter d.is_active) resolve.
// Together these prove: create -> list (assignmentCount 0); duplicate ACTIVE email -> 409 (case-insensitive);
// re-add after deactivate -> allowed; update/deactivate; assignmentCount + listAssignments reflect an ACTIVE
// super/PM team row linked by responder_id; and the assign-from-roster path (addTeamMember w/ responderId) creates
// a resolvable email-only member linked to the responder.

const DEAL = "11111111-1111-1111-1111-111111111111";
const DEAL_TWO = "22222222-2222-2222-2222-222222222222";
const INACTIVE_DEAL = "33333333-3333-3333-3333-333333333333";

let pg: PGlite;
let tdb: any;

// The field_responders DDL from migration 0198 (TENANT_SCHEMA block), re-targeted at `public` for the test. The
// ACTIVE-only case-insensitive partial unique index is the backstop the create/update 409 paths depend on.
const RESPONDERS_DDL = `
  CREATE TABLE IF NOT EXISTS public.field_responders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    email text NOT NULL,
    role text NOT NULL CHECK (role IN ('superintendent', 'project_manager')),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS field_responders_active_email_uidx
    ON public.field_responders (lower(email))
    WHERE is_active = TRUE;
`;

// A minimal deals table — assignmentCount / listAssignments only need id, name, is_active (they JOIN deals and
// filter d.is_active = TRUE). Standing up the full deals Drizzle def would drag in the whole enum graph.
const DEALS_DDL = `
  CREATE TABLE IF NOT EXISTS public.deals (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    is_active boolean NOT NULL DEFAULT true
  );
`;

// The email-only dedup partial unique index from migration 0196 (re-targeted at public). tenantSchemaSql omits
// it, but the assign-from-roster dedup path in addTeamMember relies on it: a second ACTIVE email-only row for the
// same (deal, lower(email), role) must conflict so the code takes the dedup/relink branch instead of inserting a
// duplicate row. Required to exercise the responder-relink behavior below.
const DTM_EMAIL_UIDX_DDL = `
  CREATE UNIQUE INDEX IF NOT EXISTS deal_team_members_deal_email_role_uidx
    ON public.deal_team_members (deal_id, lower(member_email), role)
    WHERE user_id IS NULL AND contact_id IS NULL AND is_active = TRUE AND member_email IS NOT NULL;
`;

// Empty users/contacts tables so resolveCorrectiveActionRecipients' LEFT JOINs resolve. The relink recipient test
// uses only email-only rows (both fks NULL), so these stay empty — they just need to exist for the query to run.
const USERS_CONTACTS_DDL = `
  CREATE TABLE IF NOT EXISTS public.users (
    id uuid PRIMARY KEY, display_name text, email text, is_active boolean NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS public.contacts (
    id uuid PRIMARY KEY, first_name text, last_name text, email text, is_active boolean NOT NULL DEFAULT true
  );
`;

beforeAll(async () => {
  pg = new PGlite();
  // deal_team_members from the real Drizzle def (carries responder_id; tenantSchemaSql omits its FK/indexes,
  // which is fine — these tests don't rely on the ON DELETE SET NULL FK, only on the responder_id column +
  // the field_responders partial unique index applied below).
  await pg.exec(tenantSchemaSql("public", [dealTeamMembers]));
  await pg.exec(RESPONDERS_DDL);
  await pg.exec(DEALS_DDL);
  await pg.exec(DTM_EMAIL_UIDX_DDL);
  await pg.exec(USERS_CONTACTS_DDL);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM deal_team_members`);
  await tdb.execute(sql`DELETE FROM field_responders`);
  await tdb.execute(sql`DELETE FROM deals`);
  await tdb.execute(sql`
    INSERT INTO deals (id, name, is_active) VALUES
      (${DEAL}, 'Alpha Job', TRUE),
      (${DEAL_TWO}, 'Bravo Job', TRUE),
      (${INACTIVE_DEAL}, 'Archived Job', FALSE)
  `);
});

describe("createFieldResponder + listFieldResponders", () => {
  it("creates a responder and lists it with assignmentCount 0", async () => {
    const created = await createFieldResponder(tdb, {
      name: "  Jane Super  ",
      email: "  jane@example.com  ",
      role: "superintendent",
    });
    expect(created.name).toBe("Jane Super");
    expect(created.email).toBe("jane@example.com");
    expect(created.role).toBe("superintendent");
    expect(created.isActive).toBe(true);
    expect(created.assignmentCount).toBe(0);

    const { responders } = await listFieldResponders(tdb);
    expect(responders).toHaveLength(1);
    expect(responders[0]).toMatchObject({
      id: created.id,
      name: "Jane Super",
      email: "jane@example.com",
      role: "superintendent",
      isActive: true,
      assignmentCount: 0,
    });
  });

  it("rejects an invalid role and a missing email/name with 400", async () => {
    await expect(
      createFieldResponder(tdb, { name: "X", email: "x@example.com", role: "estimator" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createFieldResponder(tdb, { name: "", email: "y@example.com", role: "superintendent" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createFieldResponder(tdb, { name: "Z", email: "not-an-email", role: "superintendent" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    // Non-string name/email from the untyped request body must 400, not throw a 500 on .trim().
    await expect(
      createFieldResponder(tdb, { name: 123 as unknown as string, email: "n@example.com", role: "superintendent" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createFieldResponder(tdb, { name: "N", email: { x: 1 } as unknown as string, role: "superintendent" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("409s (FIELD_RESPONDER_EMAIL_DUPLICATE) on a case-insensitive duplicate ACTIVE email", async () => {
    await createFieldResponder(tdb, {
      name: "First",
      email: "dup@example.com",
      role: "superintendent",
    });
    await expect(
      createFieldResponder(tdb, {
        name: "Second",
        email: "DUP@EXAMPLE.COM",
        role: "project_manager",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "FIELD_RESPONDER_EMAIL_DUPLICATE" });
  });

  it("allows re-adding the same email once the prior holder is deactivated", async () => {
    const first = await createFieldResponder(tdb, {
      name: "Left Company",
      email: "reuse@example.com",
      role: "superintendent",
    });
    await updateFieldResponder(tdb, first.id, { isActive: false });

    const second = await createFieldResponder(tdb, {
      name: "Rehired Or New",
      email: "reuse@example.com",
      role: "project_manager",
    });
    expect(second.id).not.toBe(first.id);
    expect(second.isActive).toBe(true);

    // Default list excludes the deactivated row; includeInactive surfaces both.
    const active = await listFieldResponders(tdb);
    expect(active.responders.map((r) => r.id)).toEqual([second.id]);
    const all = await listFieldResponders(tdb, { includeInactive: true });
    expect(all.responders.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());
  });
});

describe("updateFieldResponder", () => {
  it("updates name/role and deactivates a responder", async () => {
    const created = await createFieldResponder(tdb, {
      name: "Editable",
      email: "edit@example.com",
      role: "superintendent",
    });

    const renamed = await updateFieldResponder(tdb, created.id, {
      name: "Renamed Person",
      role: "project_manager",
    });
    expect(renamed.name).toBe("Renamed Person");
    expect(renamed.role).toBe("project_manager");
    expect(renamed.isActive).toBe(true);

    const deactivated = await updateFieldResponder(tdb, created.id, { isActive: false });
    expect(deactivated.isActive).toBe(false);

    // Now hidden from the default (active-only) list.
    const { responders } = await listFieldResponders(tdb);
    expect(responders).toHaveLength(0);
  });

  it("409s when a rename collides with another ACTIVE responder's email; 404s an unknown id", async () => {
    await createFieldResponder(tdb, {
      name: "Holder",
      email: "taken@example.com",
      role: "superintendent",
    });
    const other = await createFieldResponder(tdb, {
      name: "Mover",
      email: "mover@example.com",
      role: "superintendent",
    });
    await expect(
      updateFieldResponder(tdb, other.id, { email: "TAKEN@example.com" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "FIELD_RESPONDER_EMAIL_DUPLICATE" });

    await expect(
      updateFieldResponder(tdb, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", { name: "Nope" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a non-boolean isActive with 400 instead of silently deactivating", async () => {
    const created = await createFieldResponder(tdb, {
      name: "Stays Active",
      email: "stays@example.com",
      role: "superintendent",
    });
    // A malformed patch (null / string) must NOT coerce to false and deactivate the responder.
    await expect(
      updateFieldResponder(tdb, created.id, { isActive: null as unknown as boolean }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      updateFieldResponder(tdb, created.id, { isActive: "true" as unknown as boolean }),
    ).rejects.toMatchObject({ statusCode: 400 });
    // Unchanged: still active.
    const { responders } = await listFieldResponders(tdb);
    expect(responders.find((r) => r.id === created.id)?.isActive).toBe(true);
  });
});

describe("assignmentCount + listFieldResponderAssignments", () => {
  it("counts only ACTIVE super/PM rows on ACTIVE deals, and lists those deals", async () => {
    const responder = await createFieldResponder(tdb, {
      name: "Busy Super",
      email: "busy@example.com",
      role: "superintendent",
    });

    // Two ACTIVE assignments on two ACTIVE deals (should count as 2).
    await tdb.execute(sql`
      INSERT INTO deal_team_members (deal_id, role, member_name, member_email, responder_id, is_active)
      VALUES (${DEAL}, 'superintendent', 'Busy Super', 'busy@example.com', ${responder.id}, TRUE)
    `);
    await tdb.execute(sql`
      INSERT INTO deal_team_members (deal_id, role, member_name, member_email, responder_id, is_active)
      VALUES (${DEAL_TWO}, 'project_manager', 'Busy Super', 'busy@example.com', ${responder.id}, TRUE)
    `);
    // An INACTIVE team row — must NOT count.
    await tdb.execute(sql`
      INSERT INTO deal_team_members (deal_id, role, member_name, member_email, responder_id, is_active)
      VALUES (${DEAL}, 'project_manager', 'Busy Super', 'busy@example.com', ${responder.id}, FALSE)
    `);
    // An ACTIVE row but on an INACTIVE deal — must NOT count.
    await tdb.execute(sql`
      INSERT INTO deal_team_members (deal_id, role, member_name, member_email, responder_id, is_active)
      VALUES (${INACTIVE_DEAL}, 'superintendent', 'Busy Super', 'busy@example.com', ${responder.id}, TRUE)
    `);

    const { responders } = await listFieldResponders(tdb);
    const row = responders.find((r) => r.id === responder.id);
    expect(row?.assignmentCount).toBe(2);

    const { deals } = await listFieldResponderAssignments(tdb, responder.id);
    expect(deals).toHaveLength(2);
    const byDeal = Object.fromEntries(deals.map((d) => [d.dealId, d]));
    expect(byDeal[DEAL]).toMatchObject({ dealName: "Alpha Job", role: "superintendent" });
    expect(byDeal[DEAL_TWO]).toMatchObject({ dealName: "Bravo Job", role: "project_manager" });
  });

  it("404s listAssignments for an unknown responder id", async () => {
    await expect(
      listFieldResponderAssignments(tdb, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("assign-from-roster via addTeamMember(responderId)", () => {
  it("creates a resolvable email-only member linked to the responder, and assignmentCount reflects it", async () => {
    const responder = await createFieldResponder(tdb, {
      name: "Roster Pick",
      email: "roster.pick@example.com",
      role: "superintendent",
    });

    // The deal route copies the roster person's name+email onto the email-only insert and passes responderId
    // (office omitted so the corrective-action re-notify cycle is skipped in this harness).
    const member = await addTeamMember(tdb, {
      dealId: DEAL,
      memberName: responder.name,
      memberEmail: responder.email,
      responderId: responder.id,
      role: responder.role,
    });

    // The stored row is an email-only member (no user/contact) carrying the copied email + the roster link, so
    // corrective-action recipient resolution (which reads member_email) is unchanged.
    expect(member.userId).toBeNull();
    expect(member.contactId).toBeNull();
    expect(member.memberEmail).toBe("roster.pick@example.com");
    expect(member.responderId).toBe(responder.id);
    expect(member.role).toBe("superintendent");
    expect(member.isActive).toBe(true);

    // The roster now shows this responder as assigned to 1 deal, and the drill-down lists it.
    const { responders } = await listFieldResponders(tdb);
    expect(responders.find((r) => r.id === responder.id)?.assignmentCount).toBe(1);
    const { deals } = await listFieldResponderAssignments(tdb, responder.id);
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({ dealId: DEAL, role: "superintendent" });
  });

  it("re-points an existing email-only row to the NEW responder when a deactivated one's email is reused", async () => {
    // A is assigned to the deal from the roster, then deactivated. B is created with A's reused email (allowed
    // once A is inactive) and assigned to the SAME deal + role. The existing email-only row must relink to B —
    // otherwise B shows 0 assignments while retired A still "owns" the deal.
    const a = await createFieldResponder(tdb, {
      name: "Original Super",
      email: "shared@example.com",
      role: "superintendent",
    });
    const firstAssign = await addTeamMember(tdb, {
      dealId: DEAL,
      memberName: a.name,
      memberEmail: a.email,
      responderId: a.id,
      role: a.role,
    });
    expect(firstAssign.responderId).toBe(a.id);

    await updateFieldResponder(tdb, a.id, { isActive: false });
    const b = await createFieldResponder(tdb, {
      name: "Replacement Super",
      email: "shared@example.com",
      role: "superintendent",
    });
    expect(b.id).not.toBe(a.id);

    // Re-assign the same deal/role from the roster picker for B — dedup fires, and the row re-points to B.
    const relinked = await addTeamMember(tdb, {
      dealId: DEAL,
      memberName: b.name,
      memberEmail: b.email,
      responderId: b.id,
      role: b.role,
    });
    expect(relinked.id).toBe(firstAssign.id); // same underlying row, not a duplicate
    expect(relinked.responderId).toBe(b.id);
    expect(relinked.memberName).toBe("Replacement Super");

    // B now owns the assignment; deactivated A owns none.
    const all = await listFieldResponders(tdb, { includeInactive: true });
    expect(all.responders.find((r) => r.id === b.id)?.assignmentCount).toBe(1);
    expect(all.responders.find((r) => r.id === a.id)?.assignmentCount).toBe(0);
    const bDeals = await listFieldResponderAssignments(tdb, b.id);
    expect(bDeals.deals).toHaveLength(1);
    expect(bDeals.deals[0]).toMatchObject({ dealId: DEAL, role: "superintendent" });
    const aDeals = await listFieldResponderAssignments(tdb, a.id);
    expect(aDeals.deals).toHaveLength(0);
  });

  it("promotes a relinked row to newest-per-role so the new responder becomes the corrective-action recipient", async () => {
    // Row X: A assigned from the roster, then aged into the past so it is NOT the newest super row.
    const a = await createFieldResponder(tdb, { name: "Aged Super", email: "aged@example.com", role: "superintendent" });
    const rowX = await addTeamMember(tdb, {
      dealId: DEAL,
      memberName: a.name,
      memberEmail: a.email,
      responderId: a.id,
      role: a.role,
    });
    await tdb.execute(sql`UPDATE deal_team_members SET created_at = '2020-01-01T00:00:00Z' WHERE id = ${rowX.id}`);

    // Row Z: a DIFFERENT hand-typed email-only super assigned later — currently the newest, so the recipient.
    await tdb.execute(sql`
      INSERT INTO deal_team_members (deal_id, role, member_name, member_email, is_active, created_at)
      VALUES (${DEAL}, 'superintendent', 'Newer Super', 'newer@example.com', TRUE, '2020-01-02T00:00:00Z')
    `);
    const before = await resolveCorrectiveActionRecipients(tdb, DEAL);
    expect(before.find((r) => r.role === "superintendent")?.email).toBe("newer@example.com");

    // Reuse A's email for B, then assign B from the roster: the relink re-points row X to B AND bumps its
    // created_at to now, so it is now the newest super row and B — not the stale "newer@" row — is the recipient.
    await updateFieldResponder(tdb, a.id, { isActive: false });
    const b = await createFieldResponder(tdb, { name: "Replacement Super", email: "aged@example.com", role: "superintendent" });
    await addTeamMember(tdb, {
      dealId: DEAL,
      memberName: b.name,
      memberEmail: b.email,
      responderId: b.id,
      role: b.role,
    });

    const after = await resolveCorrectiveActionRecipients(tdb, DEAL);
    const superRecipient = after.find((r) => r.role === "superintendent");
    expect(superRecipient?.email).toBe("aged@example.com"); // B's (reused) email — the just-assigned responder
    expect(superRecipient?.userId).toBeNull(); // email-only responder
  });
});
