import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

/**
 * REAL-SQL runtime coverage (PGlite in-memory Postgres) for the create-time
 * company duplicate-PREVENTION guard — the complement to the #538 cleanup.
 *
 * Mocks were the gap that let prior DB-logic fixes ship "looking fixed", so this
 * boots an actual Postgres, seeds the prod-shaped problem (a real company that
 * carries deals plus case/suffix/whitespace variants of its name), and runs the
 * REAL checkCompanyDuplicates / createCompany against it.
 *
 * Match model (must mirror the #538 merge tool, per .audit/company-dedup-discovery.md):
 *   NAME-ALONE via normalizeDirectoryName (case/suffix/punctuation-insensitive).
 *   The deal-bearing dups had NULL addresses, so exact-name+address MISSES them —
 *   name-alone is the rule that catches them. WARN only, never hard-block.
 */

import {
  checkCompanyDuplicates,
  createCompany,
} from "../../../src/modules/companies/service.js";

const T = "office_test";
const ACME = "00000000-0000-0000-0000-0000000000a1"; // "Acme Roofing", active, has address + 3 deals
const ACME_DUP = "00000000-0000-0000-0000-0000000000a2"; // "ACME ROOFING, LLC" — case/suffix variant, NULL address, 1 deal
const BIRCH = "00000000-0000-0000-0000-0000000000b1"; // unrelated active company
const OLD = "00000000-0000-0000-0000-0000000000c1"; // "Acme Roofing" but INACTIVE (soft-deleted)
const CO_OTHER = "00000000-0000-0000-0000-0000000000d1"; // "Acme Roofing Supply" — different normalized name

let pg: PGlite;
let tdb: never;

beforeAll(async () => {
  pg = new PGlite();
  // The real createCompany drizzle insert references EVERY companies column
  // (sending `default` for unspecified ones), so the table must carry the full
  // shape. Enum columns are modelled as text — the insert only ever sets a string
  // for category and `default` (NULL) for the rest. Defaults mirror the schema so
  // the omitted NOT NULL columns (is_active, is_test_data, source_refs, ...) fill.
  await pg.exec(`
    CREATE SCHEMA ${T};
    CREATE TABLE ${T}.companies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(500) NOT NULL,
      slug varchar(100) UNIQUE NOT NULL,
      category text NOT NULL,
      address text, city varchar(255), state varchar(2), zip varchar(10),
      phone varchar(20), website varchar(500),
      owner_id uuid,
      industry text, region text, domain text,
      last_activity_at timestamptz,
      email_count integer NOT NULL DEFAULT 0,
      last_email_at timestamptz,
      hubspot_id text, hubspot_company_id text, procore_id text,
      source_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
      notes text,
      company_verification_status text,
      company_verification_requested_at timestamptz,
      company_verification_email_sent_at timestamptz,
      company_verified_at timestamptz,
      company_verified_by uuid,
      company_verification_rejected_at timestamptz,
      company_verification_rejected_by uuid,
      assigned_approver_user_id uuid,
      is_test_data boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${T}.deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid,
      is_active boolean NOT NULL DEFAULT true
    );
    SET search_path TO ${T}, public;
  `);

  await pg.exec(`
    INSERT INTO ${T}.companies (id, name, slug, category, address, city, state, zip) VALUES
      ('${ACME}', 'Acme Roofing', 'acme-roofing', 'client', '100 Oak Street', 'Dallas', 'TX', '75201'),
      ('${ACME_DUP}', 'ACME ROOFING, LLC', 'acme-roofing-llc', 'client', NULL, NULL, NULL, NULL),
      ('${BIRCH}', 'Birchstone Residential', 'birchstone-residential', 'client', '5 Elm Ave', 'Plano', 'TX', '75024'),
      ('${OLD}', 'Acme Roofing', 'acme-roofing-old', 'client', NULL, NULL, NULL, NULL),
      ('${CO_OTHER}', 'Acme Roofing Supply', 'acme-roofing-supply', 'vendor', NULL, NULL, NULL, NULL);
    UPDATE ${T}.companies SET is_active = false WHERE id = '${OLD}';
    INSERT INTO ${T}.deals (company_id, is_active) VALUES
      ('${ACME}', true), ('${ACME}', true), ('${ACME}', true),
      ('${ACME}', false),
      ('${ACME_DUP}', true);
  `);

  tdb = drizzle(pg) as never;
});

afterAll(async () => {
  await pg?.close?.();
});

async function activeCompanyCount(): Promise<number> {
  const r = (await pg.query(`SELECT COUNT(*)::int AS n FROM ${T}.companies`)) as { rows: Array<{ n: number }> };
  return r.rows[0].n;
}

describe("checkCompanyDuplicates — name-alone match model (mirrors #538)", () => {
  it("flags an exact-name active company and reports its active deal count + address", async () => {
    const result = await checkCompanyDuplicates(tdb, { name: "Acme Roofing" });
    const exact = result.suggestions.find((s) => s.id === ACME);
    expect(exact).toBeTruthy();
    expect(exact!.matchReason).toBe("Exact name match");
    expect(exact!.address).toBe("100 Oak Street");
    expect(exact!.dealCount).toBe(3); // the inactive deal is excluded
  });

  it("catches case + suffix + punctuation variants (the dups exact-name+address misses)", async () => {
    // Creating plain "Acme Roofing" must surface the "ACME ROOFING, LLC" variant too.
    const result = await checkCompanyDuplicates(tdb, { name: "Acme Roofing" });
    const ids = result.suggestions.map((s) => s.id);
    expect(ids).toContain(ACME);
    expect(ids).toContain(ACME_DUP);
    const variant = result.suggestions.find((s) => s.id === ACME_DUP)!;
    expect(variant.matchReason).toBe("Possible duplicate (same name, ignoring case/suffix)");
    expect(variant.dealCount).toBe(1);
  });

  it("normalizes the INPUT too — whitespace/case/suffix on the typed name still match", async () => {
    const result = await checkCompanyDuplicates(tdb, { name: "  acme   roofing  inc " });
    expect(result.suggestions.map((s) => s.id)).toEqual(
      expect.arrayContaining([ACME, ACME_DUP])
    );
  });

  it("does NOT match a different normalized name (substring is not a match)", async () => {
    // "Acme Roofing Supply" normalizes to "acme roofing supply" != "acme roofing".
    const result = await checkCompanyDuplicates(tdb, { name: "Acme Roofing" });
    expect(result.suggestions.map((s) => s.id)).not.toContain(CO_OTHER);
  });

  it("excludes inactive (soft-deleted) companies — only usable companies are offered", async () => {
    const result = await checkCompanyDuplicates(tdb, { name: "Acme Roofing" });
    expect(result.suggestions.map((s) => s.id)).not.toContain(OLD);
  });

  it("returns no suggestions for a genuinely new name", async () => {
    const result = await checkCompanyDuplicates(tdb, { name: "Lone Star Exteriors" });
    expect(result.suggestions).toEqual([]);
  });

  it("returns no suggestions (no crash) for a name that normalizes to empty", async () => {
    const result = await checkCompanyDuplicates(tdb, { name: "  ,. - " });
    expect(result.suggestions).toEqual([]);
  });
});

describe("createCompany — warn, do NOT hard-block", () => {
  beforeEach(async () => {
    // Remove any rows created by the create-path tests so counts are stable.
    await pg.exec(`DELETE FROM ${T}.companies WHERE name IN ('Lone Star Exteriors', 'Acme Roofing', 'Owner Test Co');`);
    await pg.exec(`
      INSERT INTO ${T}.companies (id, name, slug, category, address, city, state, zip) VALUES
        ('${ACME}', 'Acme Roofing', 'acme-roofing', 'client', '100 Oak Street', 'Dallas', 'TX', '75201')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  it("returns a warning (company: null + dedupResult) and does NOT insert on a duplicate name", async () => {
    const before = await activeCompanyCount();
    const result = await createCompany(tdb, { name: "Acme Roofing", category: "client" });
    expect(result.company).toBeNull();
    expect(result.dedupResult).toBeTruthy();
    expect(result.dedupResult!.suggestions.map((s) => s.id)).toContain(ACME);
    expect(await activeCompanyCount()).toBe(before); // nothing inserted
  });

  it("inserts when skipDedupCheck=true (the rep chose 'Create Anyway')", async () => {
    const before = await activeCompanyCount();
    const result = await createCompany(tdb, { name: "Acme Roofing", category: "client" }, true);
    expect(result.company).toBeTruthy();
    expect(result.company!.name).toBe("Acme Roofing");
    expect(result.dedupResult).toBeUndefined();
    expect(await activeCompanyCount()).toBe(before + 1);
  });

  it("inserts a genuinely new company normally, with no dedupResult", async () => {
    const before = await activeCompanyCount();
    const result = await createCompany(tdb, { name: "Lone Star Exteriors", category: "client" });
    expect(result.company).toBeTruthy();
    expect(result.company!.name).toBe("Lone Star Exteriors");
    expect(result.dedupResult).toBeUndefined();
    expect(await activeCompanyCount()).toBe(before + 1);
  });

  it("assigns ownerId to the creating user (owner = the rep who created it)", async () => {
    const REP = "00000000-0000-0000-0000-0000000000a1";
    const result = await createCompany(
      tdb,
      { name: "Owner Test Co", category: "client", ownerUserId: REP },
      true
    );
    expect(result.company).toBeTruthy();
    expect(result.company!.ownerId).toBe(REP);
  });

  it("leaves ownerId null when no creator is supplied (back-compat for owner-less callers)", async () => {
    const result = await createCompany(tdb, { name: "Owner Test Co", category: "client" }, true);
    expect(result.company).toBeTruthy();
    expect(result.company!.ownerId).toBeNull();
  });
});
