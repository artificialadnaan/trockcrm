import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { requestUploadUrl, uploadNewVersion } from "../../../src/modules/files/service.js";

/**
 * REAL-SQL (PGlite) proof of the displayName SEED rule, keyed on the SYNTHETIC-PHOTO sentinel
 * (category='photo' AND originalFilename ~ ^(field-photo-<ts>|companycam_)):
 *   - a genuine web/desktop PHOTO keeps its REAL filename (spec §5.1) — NOT the deal-number scheme;
 *   - a field/TRCAM capture (field-photo-<ts>) keeps the deal-number system scheme;
 *   - a CompanyCam name (companycam_) keeps the system scheme (defensive branch);
 *   - a document keeps its real filename;
 *   - an explicit override wins (trimmed, capped);
 *   - a NON-photo shaped like field-photo-2024.pdf keeps its real name (the photo branch is gated on
 *     category='photo');
 *   - a new VERSION re-seeds from its OWN filename (doc -> real; synthetic photo -> system scheme).
 */

const USER = "00000000-0000-4000-8000-000000000001";
const DEAL = "00000000-0000-4000-8000-0000000000d1";
const DEAL_NUMBER = "TR-2026-0142";

let tdb: ReturnType<typeof drizzle>;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [files]));
  await pg.exec(`
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, deal_number text);
    INSERT INTO deals (id, name, deal_number) VALUES ('${DEAL}', 'Seed Deal', '${DEAL_NUMBER}');
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

async function seed(input: Partial<Parameters<typeof requestUploadUrl>[3]> & {
  originalFilename: string;
  mimeType: string;
  category: any;
}) {
  return requestUploadUrl(tdb as never, "test", USER, {
    fileSizeBytes: 1234,
    dealId: DEAL,
    ...input,
  } as never);
}

describe("displayName seed (synthetic-photo sentinel)", () => {
  it("(i) a web/desktop PHOTO keeps its real filename, NOT the deal-number scheme", async () => {
    const r = await seed({ originalFilename: "Kitchen Damage.jpg", mimeType: "image/jpeg", category: "photo" });
    expect(r.displayName).toBe("Kitchen Damage");
    expect(r.displayName).not.toContain(DEAL_NUMBER);
  });

  it("(ii) a field/TRCAM synthetic name keeps the deal-number system scheme", async () => {
    const r = await seed({ originalFilename: "field-photo-1699999999.jpg", mimeType: "image/jpeg", category: "photo" });
    expect(r.displayName).not.toBe("field-photo-1699999999");
    expect(r.displayName).toContain(DEAL_NUMBER);
    expect(r.displayName).toContain("Photo");
  });

  it("(iii) a CompanyCam synthetic name keeps the system scheme (defensive branch)", async () => {
    const r = await seed({ originalFilename: "companycam_abc123.jpg", mimeType: "image/jpeg", category: "photo" });
    expect(r.displayName).not.toBe("companycam_abc123");
    expect(r.displayName).toContain(DEAL_NUMBER);
  });

  it("(iv) a document keeps its real filename", async () => {
    const r = await seed({ originalFilename: "Foundation Warranty.pdf", mimeType: "application/pdf", category: "other" });
    expect(r.displayName).toBe("Foundation Warranty");
  });

  it("an explicit displayName override wins (trimmed, capped to 500)", async () => {
    const r = await seed({
      originalFilename: "Kitchen Damage.jpg",
      mimeType: "image/jpeg",
      category: "photo",
      displayName: "   Custom Name   ",
    });
    expect(r.displayName).toBe("Custom Name");

    const long = "x".repeat(600);
    const r2 = await seed({
      originalFilename: "Foundation Warranty.pdf",
      mimeType: "application/pdf",
      category: "other",
      displayName: long,
    });
    expect(r2.displayName.length).toBe(500);
  });

  it("a NON-photo shaped like field-photo-2024.pdf keeps its real name", async () => {
    const r = await seed({ originalFilename: "field-photo-2024.pdf", mimeType: "application/pdf", category: "other" });
    expect(r.displayName).toBe("field-photo-2024");
  });

  it("a document VERSION re-seeds from its own real filename; a synthetic-photo version keeps the system scheme", async () => {
    // Seed a parent doc directly.
    const [parentDoc] = await tdb
      .insert(files)
      .values({
        category: "other",
        displayName: `${DEAL_NUMBER} Other 2026-01-01 001 aa11bb22`,
        systemFilename: `${DEAL_NUMBER}_Other_2026-01-01_001_aa11bb22.pdf`,
        originalFilename: "Original Contract.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 10,
        fileExtension: ".pdf",
        r2Key: "office_test/deals/doc-parent.pdf",
        r2Bucket: "trockcrm",
        dealId: DEAL,
        folderPath: "Other",
        uploadedBy: USER,
      } as never)
      .returning();

    const docVersion = await uploadNewVersion(tdb as never, "test", USER, (parentDoc as any).id, {
      originalFilename: "Revised Contract.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 20,
      category: "other",
    } as never);
    expect(docVersion.displayName).toBe("Revised Contract");

    // Seed a parent synthetic photo.
    const [parentPhoto] = await tdb
      .insert(files)
      .values({
        category: "photo",
        displayName: `${DEAL_NUMBER} Photo 2026-01-01 001 cc33dd44`,
        systemFilename: `${DEAL_NUMBER}_Photo_2026-01-01_001_cc33dd44.jpg`,
        originalFilename: "field-photo-1600000000000.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: 10,
        fileExtension: ".jpg",
        r2Key: "office_test/deals/photo-parent.jpg",
        r2Bucket: "trockcrm",
        dealId: DEAL,
        folderPath: "Photos/2026-01",
        uploadedBy: USER,
      } as never)
      .returning();

    const photoVersion = await uploadNewVersion(tdb as never, "test", USER, (parentPhoto as any).id, {
      originalFilename: "field-photo-1700000000001.jpg",
      mimeType: "image/jpeg",
      fileSizeBytes: 20,
      category: "photo",
    } as never);
    expect(photoVersion.displayName).not.toBe("field-photo-1700000000001");
    expect(photoVersion.displayName).toContain(DEAL_NUMBER);
  });
});
