import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { searchContacts } from "../../../src/modules/search/service.js";

/**
 * REAL-SQL (PGlite) proof that GLOBAL search resolves the linked company for a contact result — both the
 * displayed label and the relevance rank. buildContactSearchCondition now matches companies.name, so a
 * contact whose free-text company_name is null/stale can be returned for a linked-company query; searchContacts
 * must (a) show that company as the result's tertiary label and (b) rank the hit on the resolved name (not
 * relevance 1), or it would surface with no company label and be buried in the cross-office merge.
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
  // Minimal columns searchContacts + buildContactSearchCondition touch (owner EXISTS reads public.users;
  // the linked-company match + join read companies).
  await pg.exec(`
    CREATE TABLE companies (id uuid PRIMARY KEY, name text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE contacts (
      id uuid PRIMARY KEY, first_name text, last_name text, email text, phone text, mobile text,
      job_title text, city text, company_name text, company_id uuid, owner_id uuid,
      is_active boolean NOT NULL DEFAULT true, updated_at timestamptz DEFAULT now()
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

describe("global search — linked company resolved in contact results", () => {
  it("returns linked contacts for a company-name query and labels them with the resolved company", async () => {
    const results = await searchContacts(tdb, "Avenue5", 25);
    const byId = new Map(results.map((r) => [r.id, r]));

    // Both linked contacts are returned (null AND stale free-text), labeled with the real company.
    expect(byId.get(C.linkedNullText)?.tertiaryLabel).toBe("Avenue5 Residential");
    expect(byId.get(C.linkedStaleText)?.tertiaryLabel).toBe("Avenue5 Residential");
    // The unlinked "Manual Co" contact does not match "Avenue5".
    expect(byId.has(C.freeTextOnly)).toBe(false);

    // Rank is driven by the RESOLVED name: "Avenue5 Residential" ILIKE "Avenue5%" => prefix match (2),
    // NOT the generic ELSE rank (1) a linked-only hit would have gotten before the fix.
    expect(byId.get(C.linkedNullText)?.rank).toBe(2);
  });

  it("still labels + matches an unlinked contact by its free-text company name", async () => {
    const results = await searchContacts(tdb, "Manual", 25);
    expect(results.map((r) => r.id)).toEqual([C.freeTextOnly]);
    expect(results[0]?.tertiaryLabel).toBe("Manual Co");
  });
});
