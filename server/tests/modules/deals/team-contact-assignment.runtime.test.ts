import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  addTeamMember,
  getTeamMembers,
  resolveScorecardTeamEmails,
  resolveScorecardTeamNames,
} from "../../../src/modules/deals/team-service.js";
import { dealTeamMembers, contacts } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

// deal_team_members can point at EITHER a staff user (public.users) OR a directory contact (tenant
// contacts) — this exercises the contact-assignment path, the one-of validation, and the read-side name/
// email resolution from whichever side is set.
const DEAL = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const CONTACT = "44444444-4444-4444-4444-444444444444";

let pg: PGlite;
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  // Staff-user island — only the columns getTeamMembers / resolveScorecardTeamEmails read (incl. is_active,
  // which the resolver now checks so a deactivated staff user stops receiving scorecard emails).
  await pg.exec(`
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true);
  `);
  await pg.exec(tenantSchemaSql("public", [dealTeamMembers, contacts]));
  await pg.exec(`
    INSERT INTO public.users (id, display_name, email, avatar_url, is_active) VALUES
      ('${USER}', 'Sam Super', 'sam.super@trock.com', 'https://cdn/sam.png', true);
    INSERT INTO contacts (id, first_name, last_name, email, category, is_active) VALUES
      ('${CONTACT}', 'Dana', 'Cole', 'dana.cole@example.com', 'client', true);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM deal_team_members`);
});

describe("addTeamMember (user vs contact one-of)", () => {
  it("assigns a directory contact (contactId, no userId)", async () => {
    const member = await addTeamMember(tdb, { dealId: DEAL, contactId: CONTACT, role: "superintendent" });
    expect(member.contactId).toBe(CONTACT);
    expect(member.userId).toBeNull();
    expect(member.role).toBe("superintendent");
  });

  it("assigns a staff user (userId, no contactId)", async () => {
    const member = await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "project_manager" });
    expect(member.userId).toBe(USER);
    expect(member.contactId).toBeNull();
  });

  it("rejects when NEITHER userId nor contactId is provided", async () => {
    await expect(addTeamMember(tdb, { dealId: DEAL, role: "superintendent" })).rejects.toThrow(
      /exactly one of userId or contactId/i,
    );
  });

  it("rejects when BOTH userId and contactId are provided", async () => {
    await expect(
      addTeamMember(tdb, { dealId: DEAL, userId: USER, contactId: CONTACT, role: "superintendent" }),
    ).rejects.toThrow(/exactly one of userId or contactId/i);
  });
});

describe("getTeamMembers (resolves name/email from user OR contact)", () => {
  it("resolves the display name + email from the user when userId is set", async () => {
    await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "project_manager" });
    const [row] = (await getTeamMembers(tdb, DEAL)) as any[];
    expect(row.displayName).toBe("Sam Super");
    expect(row.email).toBe("sam.super@trock.com");
    expect(row.avatarUrl).toBe("https://cdn/sam.png");
    expect(row.contactId).toBeNull();
  });

  it("resolves the display name + email from the CONTACT when contactId is set", async () => {
    await addTeamMember(tdb, { dealId: DEAL, contactId: CONTACT, role: "superintendent" });
    const [row] = (await getTeamMembers(tdb, DEAL)) as any[];
    expect(row.displayName).toBe("Dana Cole"); // first + last, trimmed
    expect(row.email).toBe("dana.cole@example.com");
    expect(row.userId).toBeNull();
    expect(row.contactId).toBe(CONTACT);
  });

  it("returns both user- and contact-backed members for the deal", async () => {
    await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "project_manager" });
    await addTeamMember(tdb, { dealId: DEAL, contactId: CONTACT, role: "superintendent" });
    const rows = (await getTeamMembers(tdb, DEAL)) as any[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.email))).toEqual(
      new Set(["sam.super@trock.com", "dana.cole@example.com"]),
    );
  });
});

describe("resolveScorecardTeamEmails", () => {
  it("resolves the superintendent (contact) and project_manager (user) emails + names", async () => {
    await addTeamMember(tdb, { dealId: DEAL, contactId: CONTACT, role: "superintendent" });
    await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "project_manager" });

    const emails = await resolveScorecardTeamEmails(tdb, DEAL);
    expect(emails.superintendentEmail).toBe("dana.cole@example.com");
    expect(emails.projectManagerEmail).toBe("sam.super@trock.com");
    expect(emails.superintendentName).toBe("Dana Cole");
    expect(emails.projectManagerName).toBe("Sam Super");
  });

  it("returns null for an unassigned role", async () => {
    await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "superintendent" });
    const emails = await resolveScorecardTeamEmails(tdb, DEAL);
    expect(emails.superintendentEmail).toBe("sam.super@trock.com");
    expect(emails.projectManagerEmail).toBeNull();
    expect(emails.projectManagerName).toBeNull();
  });

  it("takes the most-recent active row when a role is assigned more than once", async () => {
    const older = await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "superintendent" });
    // Backdate the first row so the second (contact) is unambiguously newer.
    await tdb.execute(
      sql`UPDATE deal_team_members SET created_at = now() - interval '1 day' WHERE id = ${older.id}`,
    );
    await addTeamMember(tdb, { dealId: DEAL, contactId: CONTACT, role: "superintendent" });

    const emails = await resolveScorecardTeamEmails(tdb, DEAL);
    expect(emails.superintendentEmail).toBe("dana.cole@example.com"); // the newer (contact) row wins
  });

  it("ignores soft-removed (inactive) members", async () => {
    const member = await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "project_manager" });
    await tdb.execute(sql`UPDATE deal_team_members SET is_active = false WHERE id = ${member.id}`);
    const emails = await resolveScorecardTeamEmails(tdb, DEAL);
    expect(emails.projectManagerEmail).toBeNull();
  });

  it("resolves null email when the linked contact has none on file", async () => {
    const noEmailContact = "44444444-4444-4444-4444-4444444444ff";
    await tdb.execute(sql`
      INSERT INTO contacts (id, first_name, last_name, email, category, is_active)
      VALUES (${noEmailContact}, 'No', 'Email', NULL, 'client', true)
    `);
    await addTeamMember(tdb, { dealId: DEAL, contactId: noEmailContact, role: "superintendent" });
    const emails = await resolveScorecardTeamEmails(tdb, DEAL);
    expect(emails.superintendentEmail).toBeNull();
    expect(emails.superintendentName).toBe("No Email");
  });

  it("skips a member whose staff USER was deactivated (users.is_active = false)", async () => {
    const goneUser = "33333333-3333-3333-3333-3333333333de";
    await tdb.execute(sql`
      INSERT INTO public.users (id, display_name, email, is_active)
      VALUES (${goneUser}, 'Gone User', 'gone.user@trock.com', false)
    `);
    await addTeamMember(tdb, { dealId: DEAL, userId: goneUser, role: "project_manager" });
    const emails = await resolveScorecardTeamEmails(tdb, DEAL);
    expect(emails.projectManagerEmail).toBeNull();
    expect(emails.projectManagerName).toBeNull();
  });

  it("skips a member whose directory CONTACT was archived (contacts.is_active = false)", async () => {
    const archived = "44444444-4444-4444-4444-4444444444de";
    await tdb.execute(sql`
      INSERT INTO contacts (id, first_name, last_name, email, category, is_active)
      VALUES (${archived}, 'Archived', 'Contact', 'archived.contact@example.com', 'client', false)
    `);
    await addTeamMember(tdb, { dealId: DEAL, contactId: archived, role: "superintendent" });
    const emails = await resolveScorecardTeamEmails(tdb, DEAL);
    expect(emails.superintendentEmail).toBeNull();
    expect(emails.superintendentName).toBeNull();
  });

  it("falls back to an older ACTIVE assignee when the newer row's identity is deactivated/archived", async () => {
    const archived = "44444444-4444-4444-4444-4444444444da";
    await tdb.execute(sql`
      INSERT INTO contacts (id, first_name, last_name, email, category, is_active)
      VALUES (${archived}, 'Archived', 'Super', 'archived.super@example.com', 'client', false)
    `);
    const older = await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "superintendent" });
    await tdb.execute(
      sql`UPDATE deal_team_members SET created_at = now() - interval '1 day' WHERE id = ${older.id}`,
    );
    // Newer row points at an archived contact — DISTINCT ON must skip it (it's filtered out) and land on
    // the still-active older user.
    await addTeamMember(tdb, { dealId: DEAL, contactId: archived, role: "superintendent" });
    const emails = await resolveScorecardTeamEmails(tdb, DEAL);
    expect(emails.superintendentEmail).toBe("sam.super@trock.com");
  });

  it("resolves NAMES only from active identities (resolveScorecardTeamNames)", async () => {
    const archived = "44444444-4444-4444-4444-4444444444db";
    await tdb.execute(sql`
      INSERT INTO contacts (id, first_name, last_name, email, category, is_active)
      VALUES (${archived}, 'Archived', 'Contact', 'x@example.com', 'client', false)
    `);
    await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "superintendent" });
    await addTeamMember(tdb, { dealId: DEAL, contactId: archived, role: "project_manager" });
    const names = await resolveScorecardTeamNames(tdb, DEAL);
    expect(names.superintendentName).toBe("Sam Super");
    expect(names.pmName).toBeNull();
  });
});
