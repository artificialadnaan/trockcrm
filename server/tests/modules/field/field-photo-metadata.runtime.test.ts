import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { files, photoAuditLog } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { updateFieldPhotoMetadata } from "../../../src/modules/field/photo-metadata-service.js";

/**
 * REAL-SQL (PGlite) proof of the field-auth photo metadata edit: it persists displayName/description for a
 * rep-OWNED photo, writes a caption_changed audit row ONLY when the description actually changes, and 404s
 * a photo the field user can't access / a non-photo row.
 */

const OWNER = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const ACCESS = { userId: OWNER, userRole: "rep" as const };

let tdb: ReturnType<typeof drizzle>;
let pg: PGlite;
let seq = 0;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [files, photoAuditLog]));
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM photo_audit_log; DELETE FROM files;");
});

async function insertFile(overrides: Record<string, unknown>): Promise<string> {
  seq += 1;
  const [row] = await tdb
    .insert(files)
    .values({
      category: "photo",
      displayName: `photo ${seq}`,
      systemFilename: `sys-${seq}.jpg`,
      originalFilename: `field-photo-${seq}.jpg`,
      mimeType: "image/jpeg",
      fileSizeBytes: 100,
      fileExtension: ".jpg",
      r2Key: `office_test/r2-${seq}`,
      r2Bucket: "trockcrm",
      folderPath: "Photos/2026-01",
      uploadedBy: OWNER,
      ...overrides,
    } as never)
    .returning();
  return (row as any).id;
}

async function auditCount(): Promise<number> {
  const r = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM photo_audit_log WHERE event_type = 'caption_changed'`);
  return Number(r.rows[0].n);
}

describe("updateFieldPhotoMetadata", () => {
  it("persists displayName + description and logs caption_changed on a description change", async () => {
    const id = await insertFile({ displayName: "old", description: null });
    const { photo } = await updateFieldPhotoMetadata(tdb as never, ACCESS, {
      photoId: id,
      displayName: "Front Elevation",
      description: "Cracked lintel over the door",
    });
    expect(photo.displayName).toBe("Front Elevation");
    expect(photo.description).toBe("Cracked lintel over the door");
    expect(await auditCount()).toBe(1);
  });

  it("does NOT log caption_changed for a displayName-only edit", async () => {
    const id = await insertFile({ displayName: "old", description: "keep" });
    await updateFieldPhotoMetadata(tdb as never, ACCESS, { photoId: id, displayName: "Renamed" });
    expect(await auditCount()).toBe(0);
  });

  it("rejects an empty display name", async () => {
    const id = await insertFile({});
    await expect(
      updateFieldPhotoMetadata(tdb as never, ACCESS, { photoId: id, displayName: "   " }),
    ).rejects.toThrow(/empty/i);
  });

  it("404s a photo owned by a different field user (rep-owned scoping)", async () => {
    const id = await insertFile({ uploadedBy: OTHER });
    await expect(
      updateFieldPhotoMetadata(tdb as never, ACCESS, { photoId: id, description: "x" }),
    ).rejects.toThrow(/not found/i);
  });

  it("404s a non-photo row", async () => {
    const id = await insertFile({ category: "other", originalFilename: "doc.pdf" });
    await expect(
      updateFieldPhotoMetadata(tdb as never, ACCESS, { photoId: id, description: "x" }),
    ).rejects.toThrow(/not found/i);
  });
});
