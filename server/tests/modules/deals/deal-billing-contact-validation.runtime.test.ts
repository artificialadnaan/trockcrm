import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { validateDealBillingContact } from "../../../src/modules/deals/service.js";

/**
 * updateDeal must not accept (a) a stale/archived billing contact, or (b) a billing contact without a
 * complete mailing address — a billing contact is useless for invoicing without one. deleteContact only
 * soft-deletes (is_active = false) and the FK permits it, so a billingContactId from a search result that
 * was deleted/merged between select and save would otherwise persist. This proves both guards against real
 * PGlite rows. The address guard is forward-only: it only runs when someone assigns a billing contact.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ACTIVE = U("a01");        // active + complete address
const INACTIVE = U("b01");      // inactive, but complete address
const NO_ADDRESS = U("c01");    // active, no address at all
const PARTIAL = U("d01");       // active, street+city but no state/zip

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE contacts (
      id uuid PRIMARY KEY,
      is_active boolean NOT NULL DEFAULT true,
      address text, city varchar(255), state varchar(2), zip varchar(10)
    );
    INSERT INTO contacts (id, is_active, address, city, state, zip) VALUES
      ('${ACTIVE}',     true,  '100 Main St', 'Dallas', 'TX', '75201'),
      ('${INACTIVE}',   false, '100 Main St', 'Dallas', 'TX', '75201'),
      ('${NO_ADDRESS}', true,  NULL, NULL, NULL, NULL),
      ('${PARTIAL}',    true,  '100 Main St', 'Dallas', NULL, NULL);
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

  it("resolves for an ACTIVE contact with a complete address", async () => {
    await expect(validateDealBillingContact(tdb, ACTIVE)).resolves.toBeUndefined();
  });

  it("REJECTS an inactive / soft-deleted contact (the stale-id guard, Codex P2)", async () => {
    await expect(validateDealBillingContact(tdb, INACTIVE)).rejects.toThrow(/not found or is inactive/i);
  });

  it("REJECTS a non-existent contact id", async () => {
    await expect(validateDealBillingContact(tdb, U("f99"))).rejects.toThrow(/not found or is inactive/i);
  });

  it("REJECTS an active contact with NO address (needs a billing address)", async () => {
    await expect(validateDealBillingContact(tdb, NO_ADDRESS)).rejects.toThrow(/complete.*address/i);
  });

  it("REJECTS an active contact with a PARTIAL address (missing state/ZIP)", async () => {
    await expect(validateDealBillingContact(tdb, PARTIAL)).rejects.toThrow(/complete.*address/i);
  });

  it("skips the address requirement when requireCompleteAddress is false (forward-only: unchanged contact)", async () => {
    // updateDeal passes false when a PATCH echoes the deal's existing billing contact, so a legacy address-less
    // billing contact isn't retroactively forced to be cleaned up.
    await expect(validateDealBillingContact(tdb, NO_ADDRESS, { requireCompleteAddress: false })).resolves.toBeUndefined();
    // ...but the active-contact guard still runs even when the address isn't required.
    await expect(validateDealBillingContact(tdb, INACTIVE, { requireCompleteAddress: false })).rejects.toThrow(/not found or is inactive/i);
  });
});
