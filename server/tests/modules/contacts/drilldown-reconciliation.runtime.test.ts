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
 * REAL-SQL (PGlite) reconciliation proof for the Contacts drillable summary cards.
 *
 * The "Primary contacts" and "Untouched 30d+" cards used to count only the visible 50-row page. They now
 * read SERVER aggregates (pagination.primaryCount / untouchedCount) computed over the FULL filtered set,
 * and the ?card= drills (isPrimary / untouched) reuse the SAME predicates. So the number on the card a
 * user clicks === the total of the list it drills to, by construction. These tests prove that on real SQL
 * AND prove the counts are full-set (survive a limit=1 page) — the actual bug being fixed.
 *
 * lastTouchAt = GREATEST(last_contacted_at, MAX activity/email/task). We seed only last_contacted_at
 * (relative to NOW()) so the touched/untouched split is deterministic without activity/email/task rows.
 */
const U = (s: string) => {
  const hex = [...s].map((c) => (/[0-9a-f]/i.test(c) ? c : (c.charCodeAt(0) % 16).toString(16))).join("");
  return `00000000-0000-0000-0000-${hex.padStart(12, "0").slice(-12)}`;
};

const C = {
  primaryTouched: U("c1"), // primary, touched 5d ago
  primaryUntouched: U("c2"), // primary, never touched (NULL)
  plainStale: U("c3"), // not primary, touched 60d ago → untouched
  plainTouched: U("c4"), // not primary, touched 10d ago
};
const DEAL = U("d01");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  // activities/emails/tasks/deals exist (the lastTouch + linked-deals subqueries reference them) but stay
  // empty — last_contacted_at alone drives lastTouchAt here.
  await pg.exec(tenantSchemaSql("public", [users, contacts, contactDealAssociations, deals, activities, emails, tasks]));
  await pg.exec(`
    INSERT INTO contacts (id, first_name, last_name, category, last_contacted_at) VALUES
      ('${C.primaryTouched}','Pat','Primary','client', NOW() - interval '5 days'),
      ('${C.primaryUntouched}','Uma','Primary','client', NULL),
      ('${C.plainStale}','Stan','Stale','client', NOW() - interval '60 days'),
      ('${C.plainTouched}','Tom','Touched','client', NOW() - interval '10 days');
    INSERT INTO contact_deal_associations (contact_id, deal_id, is_primary) VALUES
      ('${C.primaryTouched}','${DEAL}', true),
      ('${C.primaryUntouched}','${DEAL}', true);
  `);
  tdb = drizzle(pg);
}, 30000); // PGlite cold-start can exceed the default 10s when runtime suites start in parallel

afterAll(async () => {
  await pg?.close?.();
});

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const isUntouchedRow = (lastTouchAt: string | null | undefined) =>
  lastTouchAt == null || Date.now() - new Date(lastTouchAt).getTime() > THIRTY_DAYS;

describe("contacts drilldown — card count === drilled-list count (reconcile by construction)", () => {
  it("Primary / Untouched card aggregates equal the total of the list each drills to", async () => {
    const all = await getContacts(tdb, {});
    expect(all.pagination.total).toBe(4);
    expect(all.pagination.primaryCount).toBe(2); // c1, c2
    expect(all.pagination.untouchedCount).toBe(2); // c2 (never), c3 (60d)

    const primaryDrill = await getContacts(tdb, { isPrimary: true });
    expect(primaryDrill.pagination.total).toBe(all.pagination.primaryCount);
    expect(primaryDrill.contacts.every((c) => c.isPrimary === true)).toBe(true);

    const untouchedDrill = await getContacts(tdb, { untouched: true });
    expect(untouchedDrill.pagination.total).toBe(all.pagination.untouchedCount);
    expect(untouchedDrill.contacts.every((c) => isUntouchedRow(c.lastTouchAt))).toBe(true);
  });

  it("aggregates are FULL-SET, not page-only (the bug): counts hold even when limit=1 returns one row", async () => {
    const page = await getContacts(tdb, { limit: 1 });
    expect(page.contacts.length).toBe(1); // only one row on the page
    expect(page.pagination.total).toBe(4);
    expect(page.pagination.primaryCount).toBe(2); // NOT 0 or 1 — the whole set
    expect(page.pagination.untouchedCount).toBe(2);
  });

  it("card drills compose with each other (isPrimary AND untouched = the single overlap)", async () => {
    const both = await getContacts(tdb, { isPrimary: true, untouched: true });
    expect(both.pagination.total).toBe(1); // only c2 is primary AND untouched
  });
});
