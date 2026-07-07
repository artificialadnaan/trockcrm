import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deals, files } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { getDealFolderTree } from "../../../src/modules/files/service.js";

// getDealFolderTree touches both `files` (folder counts) and `deals` (lineage lead lookup); with no rows
// seeded the counts are all 0 and every FolderNode.category comes straight from DEAL_FOLDER_TEMPLATE —
// which is exactly the contract under test.
const DEAL_ID = "00000000-0000-4000-8000-000000000d01";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(tenantSchemaSql("public", [files, deals]));
  tdb = drizzle(pg);
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe("getDealFolderTree category contract (DEAL_FOLDER_TEMPLATE → FolderNode.category)", () => {
  it("pins the two lossy folders to their single canonical category", async () => {
    const tree = await getDealFolderTree(tdb, DEAL_ID);
    const byName = new Map(tree.map((f) => [f.name, f]));
    // 13 categories collapse to 8 folders; these two folders are the lossy ones the picker depends on.
    expect(byName.get("Permits & Inspections")?.category).toBe("permit");
    expect(byName.get("Correspondence")?.category).toBe("correspondence");
  });

  it("pins Photos/Estimates/Contracts to their categories with the expected subfolders", async () => {
    const tree = await getDealFolderTree(tdb, DEAL_ID);
    const byName = new Map(tree.map((f) => [f.name, f]));
    expect(byName.get("Photos")?.category).toBe("photo");
    expect(byName.get("Photos")?.subfolders.map((s) => s.name)).toEqual([
      "Site Visits", "Progress", "Final Walkthrough", "Damage",
    ]);
    expect(byName.get("Estimates")?.category).toBe("estimate");
    expect(byName.get("Estimates")?.subfolders.map((s) => s.name)).toEqual([
      "DD Estimate", "Bid Estimate", "Revisions",
    ]);
    expect(byName.get("Contracts")?.category).toBe("contract");
  });

  it("exposes exactly the 8 template folders in order (guards accidental add/remove/reorder)", async () => {
    const tree = await getDealFolderTree(tdb, DEAL_ID);
    expect(tree.map((f) => f.name)).toEqual([
      "Photos", "Estimates", "Contracts", "RFPs", "Change Orders",
      "Permits & Inspections", "Correspondence", "Closeout",
    ]);
  });
});
