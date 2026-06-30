import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  activities,
  companies,
  contactDealAssociations,
  contacts,
  deals,
  emails,
  tasks,
  users,
} from "@trock-crm/shared/schema";
import { getCompanyNames, getContactById, getContacts } from "../../../src/modules/contacts/service.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

/**
 * REAL-SQL (PGlite) proof for the Contacts "Company" display fix.
 *
 * The bug: a contact linked to a real company via company_id showed "Unassigned" (list) / "Unknown company"
 * (detail) whenever the DENORMALIZED free-text company_name column was null/stale — both surfaces rendered
 * company_name and never resolved the linked company's real name. getContacts/getContactById now LEFT JOIN
 * companies and return linkedCompanyName = companies.name, which the UI prefers. These tests prove the join
 * resolves the real name (incl. when company_name is null), leaves the free-text column untouched, returns
 * null when there's no link, and that the company_name SORT orders by the same resolved value the UI shows.
 */
const U = (s: string) => {
  const hex = [...s].map((c) => (/[0-9a-f]/i.test(c) ? c : (c.charCodeAt(0) % 16).toString(16))).join("");
  return `00000000-0000-0000-0000-${hex.padStart(12, "0").slice(-12)}`;
};

const AVENUE5 = U("a5");
const C = {
  linkedNullText: U("c1"), // company_id set, company_name NULL  -> linkedCompanyName = "Avenue5 Residential"
  linkedStaleText: U("c2"), // company_id set, company_name "Old Inc" -> linkedCompanyName = "Avenue5 Residential"
  freeTextOnly: U("c3"), // company_id NULL, company_name "Manual Co" -> linkedCompanyName = null
  bare: U("c4"), // company_id NULL, company_name NULL -> linkedCompanyName = null
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(
    tenantSchemaSql("public", [users, companies, contacts, contactDealAssociations, deals, activities, emails, tasks])
  );
  await pg.exec(`
    INSERT INTO companies (id, name, slug, category) VALUES
      ('${AVENUE5}','Avenue5 Residential','avenue5-residential','client');
    INSERT INTO contacts (id, first_name, last_name, category, company_id, company_name) VALUES
      ('${C.linkedNullText}','Francisco','Rodriguez','client','${AVENUE5}', NULL),
      ('${C.linkedStaleText}','Jeff','Barber','client','${AVENUE5}','Old Inc'),
      ('${C.freeTextOnly}','Manny','Manual','client', NULL,'Manual Co'),
      ('${C.bare}','Nora','None','client', NULL, NULL);
  `);
  tdb = drizzle(pg);
}, 30000); // PGlite cold-start can exceed the default 10s when runtime suites start in parallel

afterAll(async () => {
  await pg?.close?.();
});

describe("contacts — linkedCompanyName resolves the linked company's real name", () => {
  it("getContacts resolves companies.name via company_id (even when free-text company_name is null)", async () => {
    const { contacts: rows } = await getContacts(tdb, {});
    const byId = new Map(rows.map((c) => [c.id, c]));

    // Linked + null text: the exact reported bug — was "Unassigned", now resolves to the real company.
    expect(byId.get(C.linkedNullText)?.linkedCompanyName).toBe("Avenue5 Residential");
    expect(byId.get(C.linkedNullText)?.companyName).toBeNull(); // raw free-text column left untouched

    // Linked + stale text: resolved name wins for display, raw text preserved for the edit form.
    expect(byId.get(C.linkedStaleText)?.linkedCompanyName).toBe("Avenue5 Residential");
    expect(byId.get(C.linkedStaleText)?.companyName).toBe("Old Inc");

    // No company_id: nothing to resolve -> null. UI falls back to the free-text name, then "Unassigned".
    expect(byId.get(C.freeTextOnly)?.linkedCompanyName).toBeNull();
    expect(byId.get(C.freeTextOnly)?.companyName).toBe("Manual Co");
    expect(byId.get(C.bare)?.linkedCompanyName).toBeNull();
    expect(byId.get(C.bare)?.companyName).toBeNull();
  });

  it("getContactById resolves the linked company's real name for a contact with a null free-text name", async () => {
    const detail = await getContactById(tdb, C.linkedNullText);
    expect(detail?.linkedCompanyName).toBe("Avenue5 Residential");
    expect(detail?.companyName).toBeNull();
    expect(detail?.companyId).toBe(AVENUE5);

    const unlinked = await getContactById(tdb, C.freeTextOnly);
    expect(unlinked?.linkedCompanyName).toBeNull();
  });

  it("sorts by company_name on the RESOLVED name (COALESCE(companies.name, company_name)), NULLS LAST", async () => {
    const { contacts: rows } = await getContacts(tdb, { sortBy: "company_name", sortDir: "asc" });
    // Display value = linkedCompanyName ?? companyName. Ascending NULLS LAST:
    //   "Avenue5 Residential" (c1, c2) -> "Manual Co" (c3) -> null (c4).
    const displayed = rows.map((c) => c.linkedCompanyName ?? c.companyName);
    expect(displayed).toEqual(["Avenue5 Residential", "Avenue5 Residential", "Manual Co", null]);
  });

  it("search matches the LINKED company's name even when the free-text company_name is null/stale", async () => {
    // The exact reported gap: a row visibly reads "Avenue5 Residential" (resolved), so searching "Avenue5"
    // must find it — c1 (company_name NULL) AND c2 (company_name "Old Inc") both match via the companies
    // EXISTS, while c3/c4 (no Avenue5 link) do not.
    const hit = await getContacts(tdb, { search: "Avenue5" });
    expect(hit.contacts.map((c) => c.id).sort()).toEqual([C.linkedNullText, C.linkedStaleText].sort());
    // The COUNT query (no companies join) must match too — proves the EXISTS, not a join, drives both.
    expect(hit.pagination.total).toBe(2);

    // Free-text fallbacks still match their own column (no regression for unlinked / stale-text contacts).
    expect((await getContacts(tdb, { search: "Manual" })).contacts.map((c) => c.id)).toEqual([C.freeTextOnly]);
    expect((await getContacts(tdb, { search: "Old Inc" })).contacts.map((c) => c.id)).toEqual([C.linkedStaleText]);
  });

  it("the companyName FILTER matches the displayed/resolved name (linked OR free-text), in rows AND count", async () => {
    // Filtering by what the list shows: "Avenue5" returns the linked contacts even though c1's free-text is
    // null and c2's is "Old Inc" — was excluded before because the filter only hit contacts.company_name.
    const avenue5 = await getContacts(tdb, { companyName: "Avenue5" });
    expect(avenue5.contacts.map((c) => c.id).sort()).toEqual([C.linkedNullText, C.linkedStaleText].sort());
    expect(avenue5.pagination.total).toBe(2); // count/aggregate (no companies join) matches too — EXISTS works there

    // Free-text-only contacts still filter by their own value; stale free-text still matches its raw column.
    expect((await getContacts(tdb, { companyName: "Manual" })).contacts.map((c) => c.id)).toEqual([C.freeTextOnly]);
    expect((await getContacts(tdb, { companyName: "Old Inc" })).contacts.map((c) => c.id)).toEqual([C.linkedStaleText]);
  });

  it("getCompanyNames lists RESOLVED distinct names so the dropdown matches the filter + display", async () => {
    const names = await getCompanyNames(tdb);
    // Linked contacts surface their real company; the unlinked one surfaces its free-text name. "Old Inc"
    // (c2's stale free-text) is superseded by the linked "Avenue5 Residential" — it isn't a displayed name.
    expect(names).toEqual(["Avenue5 Residential", "Manual Co"]);
    expect(names).not.toContain("Old Inc");
  });
});
