import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { updateFile } from "../../../src/modules/files/service.js";

/**
 * REAL-SQL (PGlite) proof that updateFile keeps folderPath DERIVED from (category, subcategory): it
 * re-derives on a change to EITHER dimension, OVERRIDES any client-supplied folderPath, DROPS a stale
 * subcategory on a category change, PRESERVES the photo YYYY-MM bucket from the row's own date, and stays
 * inert when neither dimension is sent (field tag/transcription writes).
 */

const USER = "00000000-0000-4000-8000-000000000001";
let tdb: ReturnType<typeof drizzle>;
let pg: PGlite;
let seq = 0;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [files]));
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

async function insertFile(overrides: Record<string, unknown>): Promise<string> {
  seq += 1;
  const [row] = await tdb
    .insert(files)
    .values({
      category: "other",
      displayName: `file ${seq}`,
      systemFilename: `sys-${seq}.pdf`,
      originalFilename: `orig-${seq}.pdf`,
      mimeType: "application/pdf",
      fileSizeBytes: 100,
      fileExtension: ".pdf",
      r2Key: `office_test/r2-${seq}`,
      r2Bucket: "trockcrm",
      folderPath: "Correspondence",
      uploadedBy: USER,
      ...overrides,
    } as never)
    .returning();
  return (row as any).id;
}

describe("updateFile folderPath drift guard", () => {
  it("category change (estimate -> contract) re-derives folderPath and DROPS the stale subcategory", async () => {
    const id = await insertFile({ category: "estimate", subcategory: "DD Estimate", folderPath: "Estimates/DD Estimate" });
    const updated = await updateFile(tdb as never, id, { category: "contract" });
    expect(updated.folderPath).toBe("Contracts");
    expect(updated.subcategory).toBeNull();
  });

  it("subcategory-only change on an estimate (DD -> Bid) re-derives folderPath and persists it", async () => {
    const id = await insertFile({ category: "estimate", subcategory: "DD Estimate", folderPath: "Estimates/DD Estimate" });
    const updated = await updateFile(tdb as never, id, { subcategory: "Bid Estimate" });
    expect(updated.subcategory).toBe("Bid Estimate");
    expect(updated.folderPath).toBe("Estimates/Bid Estimate");
  });

  it("OVERRIDES a client-supplied folderPath on a real change", async () => {
    const id = await insertFile({ category: "estimate", subcategory: "DD Estimate", folderPath: "Estimates/DD Estimate" });
    const updated = await updateFile(tdb as never, id, { category: "contract", folderPath: "Bogus/Client/Path" });
    expect(updated.folderPath).toBe("Contracts");
  });

  it("a photo edited to a document loses its YYYY-MM bucket", async () => {
    const id = await insertFile({
      category: "photo",
      subcategory: "Site Visits",
      folderPath: "Photos/Site Visits/2026-04",
      takenAt: new Date("2026-04-10T12:00:00Z"),
    });
    const updated = await updateFile(tdb as never, id, { category: "other" });
    expect(updated.folderPath).toBe("Correspondence");
    expect(updated.subcategory).toBeNull();
  });

  it("a mis-categorized IMAGE re-categorized TO photo keeps a Photos/<YYYY-MM> bucket from the row's own date", async () => {
    const id = await insertFile({
      category: "other",
      mimeType: "image/jpeg", // only an image can become a photo (category='photo' => image mime)
      folderPath: "Correspondence",
      takenAt: null,
      createdAt: new Date("2026-03-15T12:00:00Z"),
    });
    const updated = await updateFile(tdb as never, id, { category: "photo" });
    expect(updated.folderPath).toBe("Photos/2026-03");
    expect(updated.folderPath).not.toBe("Photos");
  });

  it("REJECTS re-categorizing a non-image file TO photo (photo => image-mime invariant)", async () => {
    const id = await insertFile({ category: "other", mimeType: "application/pdf", folderPath: "Correspondence" });
    await expect(updateFile(tdb as never, id, { category: "photo" })).rejects.toThrow(/image file type/i);
  });

  it("a no-op (same category, same subcategory) leaves folderPath untouched", async () => {
    const id = await insertFile({ category: "estimate", subcategory: "DD Estimate", folderPath: "Estimates/DD Estimate" });
    const updated = await updateFile(tdb as never, id, { category: "estimate", subcategory: "DD Estimate" });
    expect(updated.folderPath).toBe("Estimates/DD Estimate");
  });

  it("a metadata-only update with no category/subcategory (field path) leaves folderPath untouched", async () => {
    const id = await insertFile({ category: "photo", subcategory: "Site Visits", folderPath: "Photos/Site Visits/2026-04" });
    const updated = await updateFile(tdb as never, id, { description: "voice note" });
    expect(updated.folderPath).toBe("Photos/Site Visits/2026-04");
    expect(updated.subcategory).toBe("Site Visits");
    expect(updated.description).toBe("voice note");
  });
});
