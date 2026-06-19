import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  activities,
  contactDealAssociations,
  contacts,
  deals,
  emails,
  tasks,
  users,
} from "@trock-crm/shared/schema";
import { getContacts } from "../../../src/modules/contacts/service.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

/**
 * REAL-SQL (PGlite) correctness proof for the two new Contacts list filters:
 *   - hasLinkedDeals: only contacts with an EXISTS active (is_active=true) linked deal
 *   - role:           only contacts whose role enum matches
 * and that both AND-compose with the unified search and with each other.
 *
 * Also confirms the perf-fix indexes from migration 0166 create cleanly on a Drizzle-derived schema and
 * the last_touch_at-sorted query still runs with them present (the index helper omits FKs/indexes, so we
 * add the two partial indexes by hand here, mirroring the migration DDL).
 */
const U = (s: string) => {
  const hex = [...s].map((c) => (/[0-9a-f]/i.test(c) ? c : (c.charCodeAt(0) % 16).toString(16))).join("");
  return `00000000-0000-0000-0000-${hex.padStart(12, "0").slice(-12)}`;
};

const C = {
  pmActive: U("c1"), // role=project_manager, linked to an ACTIVE deal
  ownerActive: U("c2"), // role=owner_principal, linked to an ACTIVE deal
  pmInactive: U("c3"), // role=project_manager, linked only to an INACTIVE deal
  pmNoDeal: U("c4"), // role=project_manager, no deal links
};
const DEAL_ACTIVE = U("d01");
const DEAL_INACTIVE = U("d02");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [users, contacts, contactDealAssociations, deals, activities, emails, tasks]));

  // Mirror migration 0166's partial indexes (the schema helper intentionally omits indexes) so we prove
  // the indexed columns exist and the sorted query plans/executes with them present.
  await pg.exec(`
    CREATE INDEX IF NOT EXISTS emails_contact_sent_at_idx ON public.emails (contact_id, sent_at DESC) WHERE contact_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS tasks_contact_updated_at_idx ON public.tasks (contact_id, updated_at DESC) WHERE contact_id IS NOT NULL;
  `);

  await pg.exec(`
    INSERT INTO contacts (id, first_name, last_name, category, role) VALUES
      ('${C.pmActive}','Pat','Active','client','project_manager'),
      ('${C.ownerActive}','Olive','Active','client','owner_principal'),
      ('${C.pmInactive}','Pam','Inactive','client','project_manager'),
      ('${C.pmNoDeal}','Pete','NoDeal','client','project_manager');
    INSERT INTO deals (id, deal_number, name, stage_id, is_active) VALUES
      ('${DEAL_ACTIVE}','D-1','Active Deal','${U("s1")}', true),
      ('${DEAL_INACTIVE}','D-2','Inactive Deal','${U("s1")}', false);
    INSERT INTO contact_deal_associations (contact_id, deal_id) VALUES
      ('${C.pmActive}','${DEAL_ACTIVE}'),
      ('${C.ownerActive}','${DEAL_ACTIVE}'),
      ('${C.pmInactive}','${DEAL_INACTIVE}');
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

describe("contacts linked-deals + role filters (real SQL)", () => {
  it("hasLinkedDeals returns ONLY contacts with an active linked deal", async () => {
    const res = await getContacts(tdb, { hasLinkedDeals: true });
    const ids = res.contacts.map((c) => c.id).sort();
    expect(ids).toEqual([C.pmActive, C.ownerActive].sort());
    expect(res.pagination.total).toBe(2);
    // a contact whose only link is to an INACTIVE deal is excluded
    expect(ids).not.toContain(C.pmInactive);
  });

  it("role returns ONLY contacts of that role", async () => {
    const res = await getContacts(tdb, { role: "owner_principal" });
    expect(res.contacts.map((c) => c.id)).toEqual([C.ownerActive]);
  });

  it("hasLinkedDeals AND role AND-compose (intersection only)", async () => {
    const res = await getContacts(tdb, { hasLinkedDeals: true, role: "project_manager" });
    // pmActive is the only PM that ALSO has an active linked deal (pmInactive/pmNoDeal drop out)
    expect(res.contacts.map((c) => c.id)).toEqual([C.pmActive]);
    expect(res.pagination.total).toBe(1);
  });

  it("hasLinkedDeals composes with search (AND)", async () => {
    const res = await getContacts(tdb, { hasLinkedDeals: true, search: "Olive" });
    expect(res.contacts.map((c) => c.id)).toEqual([C.ownerActive]);
  });

  it("an empty contact_deal_associations table yields an empty linked-deals set (today's prod state)", async () => {
    const empty = new PGlite();
    await empty.exec(`SET TimeZone='UTC';`);
    await empty.exec(tenantSchemaSql("public", [users, contacts, contactDealAssociations, deals, activities, emails, tasks]));
    await empty.exec(`
      INSERT INTO contacts (id, first_name, last_name, category, role) VALUES
        ('${C.pmNoDeal}','Pete','NoDeal','client','project_manager');
    `);
    const edb = drizzle(empty);
    const res = await getContacts(edb, { hasLinkedDeals: true });
    expect(res.contacts).toEqual([]);
    expect(res.pagination.total).toBe(0);
    await empty.close();
  });
});
