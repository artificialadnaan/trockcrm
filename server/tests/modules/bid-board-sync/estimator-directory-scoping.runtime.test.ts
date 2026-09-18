// ★ THE ACCEPTANCE TEST for who the `estimates_jobs` flag may resolve to.
//
// This predicate decides who can be written onto a deal as its estimator — and once that deal signs,
// who earns an additive commission on it. The curated env map is a human naming specific user ids, so
// it carries implicit office intent. This directory is AUTOMATIC and `public.users` is global, so the
// scoping has to be in the query itself; nothing downstream re-checks it (unlike setDealEstimator, the
// ingest performs no office-access check at all).
//
// So this runs ESTIMATOR_DIRECTORY_SQL against a real in-memory Postgres rather than asserting on the
// SQL string. A test that grepped the query text for "office_id" would pass against a predicate that
// mentions the column and still matches every office — which is exactly the defect being guarded.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import {
  buildEstimatorDirectory,
  ESTIMATOR_DIRECTORY_SQL,
  officeSlugFromSchema,
  resolveEstimatorUserId,
} from "../../../src/modules/bid-board-sync/estimator-map.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

const DALLAS = U("0ff1");
const ATLANTA = U("0ff2");

const HOME = U("a1"); // flagged, primary office Dallas — the ordinary case
const FOREIGN = U("a2"); // flagged, Atlanta only
const GRANTED = U("a3"); // flagged, Atlanta primary + an explicit Dallas grant
const TEST_ACCOUNT = U("a4"); // flagged, Dallas, but is_test_data
const INACTIVE = U("a5"); // flagged, Dallas, but deactivated
const TWIN_A = U("b1"); // two Dallas people who share a display name
const TWIN_B = U("b2");

let pg: PGlite;

/** Load the directory exactly the way the ingest and both backfills do. */
async function directoryFor(officeSlug: string) {
  const result = await pg.query(ESTIMATOR_DIRECTORY_SQL, [officeSlug] as never);
  return buildEstimatorDirectory(
    (result.rows as Array<{ id: string; display_name: string | null }>).map((r) => ({
      id: r.id,
      displayName: r.display_name,
    }))
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.offices (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE public.users (
      id uuid PRIMARY KEY,
      display_name text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      is_test_data boolean NOT NULL DEFAULT false,
      estimates_jobs boolean NOT NULL DEFAULT false,
      office_id uuid
    );
    CREATE TABLE public.user_office_access (user_id uuid NOT NULL, office_id uuid NOT NULL);
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM public.user_office_access; DELETE FROM public.users; DELETE FROM public.offices;`);
  await pg.query(`INSERT INTO public.offices (id, slug) VALUES ($1,'dallas'), ($2,'atlanta')`, [
    DALLAS,
    ATLANTA,
  ] as never);
});

async function addUser(
  id: string,
  displayName: string,
  officeId: string | null,
  extra: { active?: boolean; test?: boolean; flagged?: boolean } = {}
) {
  await pg.query(
    `INSERT INTO public.users (id, display_name, is_active, is_test_data, estimates_jobs, office_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, displayName, extra.active ?? true, extra.test ?? false, extra.flagged ?? true, officeId] as never
  );
}

describe("ESTIMATOR_DIRECTORY_SQL — who the estimates_jobs flag may resolve to", () => {
  it("resolves a flagged user whose primary office is the one being synced", async () => {
    await addUser(HOME, "Kason Reeder", DALLAS);
    const directory = await directoryFor("dallas");
    expect(resolveEstimatorUserId("Kason Reeder", directory)).toBe(HOME);
  });

  it("does NOT resolve a flagged user who belongs only to ANOTHER office", async () => {
    // The P1. Without the office clause a coincidentally-matching Atlanta estimator would be written
    // onto a Dallas deal and, once it signed, paid on it — with nothing downstream to catch it.
    await addUser(FOREIGN, "Kason Reeder", ATLANTA);
    const directory = await directoryFor("dallas");
    expect(resolveEstimatorUserId("Kason Reeder", directory)).toBeNull();
    // ...and the very same person DOES resolve for their own office, so this is scoping, not a blanket
    // exclusion that would pass just as well if the query returned nothing at all.
    expect(resolveEstimatorUserId("Kason Reeder", await directoryFor("atlanta"))).toBe(FOREIGN);
  });

  it("DOES resolve a foreign-office user holding an explicit grant to this office", async () => {
    // A multi-office estimator's PRIMARY office is often not the one being synced. Scoping on office_id
    // alone would silently drop them.
    await addUser(GRANTED, "Casey Grant", ATLANTA);
    await pg.query(`INSERT INTO public.user_office_access (user_id, office_id) VALUES ($1,$2)`, [
      GRANTED,
      DALLAS,
    ] as never);
    expect(resolveEstimatorUserId("Casey Grant", await directoryFor("dallas"))).toBe(GRANTED);
  });

  it("excludes test accounts, matching the canonical roster", async () => {
    await addUser(TEST_ACCOUNT, "Smoke Test", DALLAS, { test: true });
    expect(resolveEstimatorUserId("Smoke Test", await directoryFor("dallas"))).toBeNull();
  });

  it("excludes deactivated users", async () => {
    await addUser(INACTIVE, "Gone Away", DALLAS, { active: false });
    expect(resolveEstimatorUserId("Gone Away", await directoryFor("dallas"))).toBeNull();
  });

  it("excludes users who are not flagged at all", async () => {
    await addUser(HOME, "Never Flagged", DALLAS, { flagged: false });
    expect(resolveEstimatorUserId("Never Flagged", await directoryFor("dallas"))).toBeNull();
  });

  it("refuses to guess between two flagged users in this office who share a name", async () => {
    await addUser(TWIN_A, "Chris Smith", DALLAS);
    await addUser(TWIN_B, "chris  SMITH", DALLAS);
    const directory = await directoryFor("dallas");
    expect(resolveEstimatorUserId("Chris Smith", directory)).toBeNull();
    expect(directory.ambiguous.has("chris smith")).toBe(true);
  });

  it("does NOT let a foreign-office namesake make the local estimator ambiguous", async () => {
    // The subtle one, and the reason the office filter belongs in SQL rather than in a later pass over a
    // global list: a same-named Atlanta user must never be able to BLOCK the Dallas estimator who should
    // have resolved. Filtering after building the index would have exactly that effect.
    await addUser(HOME, "Kason Reeder", DALLAS);
    await addUser(FOREIGN, "Kason Reeder", ATLANTA);
    const directory = await directoryFor("dallas");
    expect(resolveEstimatorUserId("Kason Reeder", directory)).toBe(HOME);
    expect(directory.ambiguous.size).toBe(0);
  });

  it("returns nobody for an office slug that does not exist, rather than everybody", async () => {
    // A misconfigured slug must fail CLOSED. Worth locking because the alternative — every flagged user
    // in the company becoming resolvable for an unrecognised office — is silent and cross-tenant.
    //
    // Honest about what this does NOT prove: I mutated the inner JOIN to a LEFT JOIN and all ten tests
    // still passed. That is not a hole in the suite, it is how NULL works — with no matching office row
    // `o.id` is NULL, so `u.office_id = o.id` is NULL and the EXISTS finds nothing, so the office clause
    // rejects every row anyway. The clause is what scopes this query; the JOIN type is not load-bearing
    // and no test here should be read as guarding it.
    await addUser(HOME, "Kason Reeder", DALLAS);
    expect((await directoryFor("no-such-office")).byName.size).toBe(0);
  });
});

describe("officeSlugFromSchema", () => {
  it("recovers the office the backfills scope by", () => {
    // The backfills only carry the schema name; getting this wrong scopes the whole run to the wrong
    // office, which the SQL above would then faithfully enforce.
    expect(officeSlugFromSchema("office_dallas")).toBe("dallas");
    expect(officeSlugFromSchema("office_pwauditoffice")).toBe("pwauditoffice");
  });
});
