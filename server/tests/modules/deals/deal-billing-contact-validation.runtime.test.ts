import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { validateDealBillingContact } from "../../../src/modules/deals/service.js";

/**
 * updateDeal must not accept a stale/archived billing contact. deleteContact only soft-deletes (is_active =
 * false) and the FK permits it, so a billingContactId from a search result that was deleted/merged between
 * select and save would otherwise persist. This proves the active-contact guard against real PGlite rows.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ACTIVE = U("a01");
const INACTIVE = U("b01");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE contacts (id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
    INSERT INTO contacts (id, is_active) VALUES ('${ACTIVE}', true), ('${INACTIVE}', false);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("validateDealBillingContact", () => {
  it("resolves when there is no billing contact to validate (null / undefined)", async () => {
    await expect(validateDealBillingContact(tdb, null)).resolves.toBeUndefined();
    await expect(validateDealBillingContact(tdb, undefined)).resolves.toBeUndefined();
  });

  it("resolves for an ACTIVE contact", async () => {
    await expect(validateDealBillingContact(tdb, ACTIVE)).resolves.toBeUndefined();
  });

  it("REJECTS an inactive / soft-deleted contact (the stale-id guard, Codex P2)", async () => {
    await expect(validateDealBillingContact(tdb, INACTIVE)).rejects.toThrow(/not found or is inactive/i);
  });

  it("REJECTS a non-existent contact id", async () => {
    await expect(validateDealBillingContact(tdb, U("f99"))).rejects.toThrow(/not found or is inactive/i);
  });
});
