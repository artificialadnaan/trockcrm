import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { searchContacts } from "../../../src/modules/contacts/search-service.js";

/**
 * REAL-SQL (PGlite) proof that the fast contact-picker autocomplete (/api/contacts/search, used by the email
 * manual-assignment dialog) resolves the linked company: a contact linked via company_id is FINDABLE by the
 * linked company's name and LABELED with it, even when the denormalized free-text company_name is null/stale.
 * Previously this service filtered + selected only contacts.company_name, so an "Avenue5"-displayed contact
 * was unfindable/unlabeled in the picker.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const AVENUE5 = U("a5");
const C = {
  linkedNullText: U("c1"), // linked to Avenue5, company_name NULL
  linkedStaleText: U("c2"), // linked to Avenue5, company_name "Old Inc"
  freeTextOnly: U("c3"), // no link, company_name "Manual Co"
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE TABLE companies (id uuid PRIMARY KEY, name text);
    CREATE TABLE contacts (
      id uuid PRIMARY KEY, first_name text, last_name text, email text, phone text, mobile text,
      company_name text, company_id uuid, category text NOT NULL DEFAULT 'client',
      is_active boolean NOT NULL DEFAULT true
    );

    INSERT INTO companies (id, name) VALUES ('${AVENUE5}','Avenue5 Residential');
    INSERT INTO contacts (id, first_name, last_name, company_id, company_name) VALUES
      ('${C.linkedNullText}','Francisco','Rodriguez','${AVENUE5}', NULL),
      ('${C.linkedStaleText}','Jeff','Barber','${AVENUE5}','Old Inc'),
      ('${C.freeTextOnly}','Manny','Manual', NULL,'Manual Co');
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

describe("contact autocomplete — linked company is findable + labeled", () => {
  it("finds linked contacts by the linked company name and returns the resolved company label", async () => {
    const rows = await searchContacts(tdb, "Avenue5", 10);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(C.linkedNullText)?.companyName).toBe("Avenue5 Residential");
    expect(byId.get(C.linkedStaleText)?.companyName).toBe("Avenue5 Residential");
    // The unlinked "Manual Co" contact is not an Avenue5 match.
    expect(byId.has(C.freeTextOnly)).toBe(false);
  });

  it("still finds + labels an unlinked contact by its free-text company name", async () => {
    const rows = await searchContacts(tdb, "Manual", 10);
    expect(rows.map((r) => r.id)).toEqual([C.freeTextOnly]);
    expect(rows[0]?.companyName).toBe("Manual Co");
  });
});
