import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deals, files, users } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { getDealPhotoTimeline } from "../../../src/modules/files/service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("d001");
const UPLOADER = U("0a01");

// category='photo' records where the file was FILED, not what it contains. The CRM uploader will put a PDF
// in the Photos category, and confirmUpload then rasterizes page 1 into thumbnail_r2_key — so the row shows
// a real JPEG tile in the grid while its full-size URL is a PDF that no image view can decode. Because the
// URL is non-null the viewer can't even fall back to "Image unavailable": it renders a black frame.
let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

async function seed(id: string, mimeType: string, ext: string) {
  await pg.exec(
    `INSERT INTO public.files
       (id, category, display_name, system_filename, original_filename, mime_type,
        file_size_bytes, file_extension, r2_key, r2_bucket, uploaded_by, deal_id, taken_at, created_at)
     VALUES ('${id}', 'photo', 'Doc ${id}', 'sys_${id}', 'orig_${id}${ext}', '${mimeType}',
        1000, '${ext}', 'office_dallas/${id}', 'bucket', '${UPLOADER}', '${DEAL}',
        '2026-07-29T16:01:00Z', '2026-07-29T16:01:00Z')`,
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(tenantSchemaSql("public", [files, deals, users]));
  tdb = drizzle(pg);
  await pg.exec(
    `INSERT INTO public.deals (id, deal_number, name, stage_id)
     VALUES ('${DEAL}', 'DFW-1-14126', 'District at Boynton', '${U("50a1")}')`,
  );

  await seed(U("f001"), "image/jpeg", ".jpg");
  await seed(U("f002"), "image/heic", ".heic");
  await seed(U("f003"), "image/png", ".png");
  await seed(U("f004"), "application/pdf", ".pdf"); // the offender
  await seed(U("f005"), "video/quicktime", ".mov"); // also undecodable in an image view
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe("getDealPhotoTimeline only returns things an image view can actually render", () => {
  it("drops a PDF filed under the Photos category, and keeps every real image", async () => {
    const result = await getDealPhotoTimeline(tdb, DEAL, 1, 50);
    const ids = result.photos.map((p) => p.id);

    expect(ids).toContain(U("f001"));
    expect(ids).toContain(U("f002")); // HEIC is a first-class field upload
    expect(ids).toContain(U("f003"));
    expect(ids).not.toContain(U("f004"));
    expect(ids).not.toContain(U("f005"));
  });

  it("counts the same set it returns, so pagination can't promise a photo it will never serve", async () => {
    const result = await getDealPhotoTimeline(tdb, DEAL, 1, 50);
    // A guard applied to the rows but not the count would leave total=5 against 3 rows — and the client
    // marks the gallery partial on exactly that shortfall, which would disable Report/Share forever.
    expect(result.pagination.total).toBe(3);
    expect(result.photos).toHaveLength(3);
  });
});
