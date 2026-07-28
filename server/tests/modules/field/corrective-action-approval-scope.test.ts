import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { fieldScorecards, fieldScorecardItems, fieldScorecardPhotos } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { assertScorecardBelongsToDeal } from "../../../src/modules/field/corrective-action-approval-routes.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
const OTHER_DEAL = "11111111-1111-1111-1111-111111111112";
const USER = "33333333-3333-3333-3333-333333333333";
const CARD = "22222222-2222-2222-2222-222222222222";

let pg: PGlite;
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE TABLE deals (id uuid PRIMARY KEY, name text, is_active boolean DEFAULT true);`);
  await pg.exec(tenantSchemaSql("public", [fieldScorecards, fieldScorecardItems, fieldScorecardPhotos]));
  await pg.exec(`
    INSERT INTO deals (id, name) VALUES ('${DEAL}', 'Maple St'), ('${OTHER_DEAL}', 'Other Deal');
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.insert(fieldScorecards).values({
    id: CARD,
    clientSubmissionId: "66666666-6666-6666-6666-000000000001",
    dealId: DEAL,
    weekOf: "2026-07-27",
    totalScore: 23,
    formVersion: 2,
    rating: "corrective_action",
    status: "corrective_action_submitted",
    submittedBy: USER,
  });
});

describe("assertScorecardBelongsToDeal", () => {
  it("accepts a scorecard that belongs to the deal in the URL", async () => {
    await expect(assertScorecardBelongsToDeal(tdb, DEAL, CARD)).resolves.toBeUndefined();
  });

  it("404s a scorecard paired with a DIFFERENT deal", async () => {
    // Without this, an approver — whose allowlist authority is GLOBAL — could act on any scorecard id by
    // pairing it with a deal they happen to have access to. The deal-access check alone does not cover it,
    // because it only validates the deal in the URL.
    await expect(assertScorecardBelongsToDeal(tdb, OTHER_DEAL, CARD)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("404s a soft-deleted scorecard", async () => {
    await tdb.execute(sql`UPDATE field_scorecards SET is_active = false WHERE id = ${CARD}`);
    await expect(assertScorecardBelongsToDeal(tdb, DEAL, CARD)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("404s an unknown scorecard id", async () => {
    await expect(
      assertScorecardBelongsToDeal(tdb, DEAL, "44444444-4444-4444-4444-444444444444"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
