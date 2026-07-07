import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { getFiles, resolveFileThumbnailUrl } from "../../../src/modules/files/service.js";

/**
 * The Files list must presign thumbnail URLs in ONE batched pass (no per-row /files/:id/download N+1,
 * mirroring the photo timeline). Rows resolve to:
 *   - a generated thumbnail (image OR PDF first page) → presign that thumb (inline)          (f1)
 *   - a non-previewable doc (PDF w/o thumb, Office, …) → null (client shows a type badge)     (f2)
 *   - an image WITHOUT a generated thumbnail → presign the ORIGINAL (inline)                  (f3)
 *   - an external-only image import (CompanyCam, no r2Key) → its CDN thumbnail/original       (f4, direct)
 * R2 is unconfigured under test, so the mock URL embeds the key + disposition, letting us assert WHICH
 * object each URL points at. The `!r2Key` external branch is asserted by a DIRECT resolveFileThumbnailUrl
 * call because `files.r2_key` is `.notNull()` in the schema (a DB-inserted row cannot reach that branch) —
 * mirroring resolvePhotoDisplayUrls's own external test, which is also a direct resolver call.
 */

const USER = "00000000-0000-4000-8000-000000000001";
const DEAL = "00000000-0000-4000-8000-0000000000d1";
let tdb: ReturnType<typeof drizzle>;
let pg: PGlite;

function keyOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/[?&]key=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function dispositionOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/[?&]disposition=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// `category` is the pgEnum `file_category` (photo/contract/rfp/estimate/change_order/proposal/permit/
// inspection/correspondence/insurance/warranty/closeout/other) — an invalid literal like "document" makes
// tenantSchemaSql's typed INSERT throw. Use real members.
async function insert(
  id: string,
  opts: { r2Key: string; thumbKey: string | null; mime: string; ext: string; category: string },
) {
  const row: Record<string, string | null> = {
    id,
    category: opts.category,
    folder_path: "Contracts",
    system_filename: "sys.bin",
    original_filename: "orig.bin",
    file_size_bytes: "10",
    file_extension: opts.ext,
    mime_type: opts.mime,
    r2_bucket: "trockcrm",
    r2_key: opts.r2Key,
    thumbnail_r2_key: opts.thumbKey,
    deal_id: DEAL,
    display_name: id,
    uploaded_by: USER,
    is_active: "true",
  };
  const keys = Object.keys(row);
  const vals = keys.map((k) => (row[k] === null ? "NULL" : `'${String(row[k]).replace(/'/g, "''")}'`));
  await pg.exec(`INSERT INTO files (${keys.join(",")}) VALUES (${vals.join(",")});`);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [files]));
  // getFiles({dealId}) -> buildDealFileScopeCondition -> getDealLineageLeadId runs
  // `SELECT source_lead_id FROM deals`, so the hand-rolled deals table MUST carry that column. Leaving it
  // NULL makes getDealLineageLeadId return null → the scope collapses to files.deal_id = DEAL.
  await pg.exec(`CREATE TABLE deals (id uuid PRIMARY KEY, name text, deal_number text, source_lead_id uuid);
    INSERT INTO deals (id, name, deal_number) VALUES ('${DEAL}', 'Deal', 'D-1');`);
  tdb = drizzle(pg, { schema: { files } });
  // f1: PDF WITH a generated thumbnail → thumbnailUrl presigns the small thumb.
  await insert("00000000-0000-4000-8000-0000000000f1", {
    r2Key: "office_x/deals/D-1/docs/a.pdf",
    thumbKey: "office_x/deals/D-1/docs/thumbs/a.jpg",
    mime: "application/pdf",
    ext: ".pdf",
    category: "contract",
  });
  // f2: PDF WITHOUT a thumbnail → non-previewable doc → null (badge).
  await insert("00000000-0000-4000-8000-0000000000f2", {
    r2Key: "office_x/deals/D-1/docs/b.pdf",
    thumbKey: null,
    mime: "application/pdf",
    ext: ".pdf",
    category: "contract",
  });
  // f3: image WITHOUT a generated thumbnail → falls back to presigning the ORIGINAL inline.
  await insert("00000000-0000-4000-8000-0000000000f3", {
    r2Key: "office_x/deals/D-1/photos/c.png",
    thumbKey: null,
    mime: "image/png",
    ext: ".png",
    category: "photo",
  });
});

afterAll(async () => {
  await pg.close();
});

describe("getFiles thumbnail-URL batching", () => {
  it("attaches thumbnailUrl: thumb for generated, original for image-without-thumb, null for doc", async () => {
    const { files: rows } = await getFiles(tdb as never, { dealId: DEAL, sortBy: "display_name", sortDir: "asc" });
    const byName = Object.fromEntries(rows.map((r) => [r.displayName, r as typeof r & { thumbnailUrl?: string | null }]));

    // PDF with a generated thumbnail → the small thumb, inline.
    expect(keyOf(byName["00000000-0000-4000-8000-0000000000f1"].thumbnailUrl)).toBe("office_x/deals/D-1/docs/thumbs/a.jpg");
    expect(dispositionOf(byName["00000000-0000-4000-8000-0000000000f1"].thumbnailUrl)).toBe("inline");

    // PDF without a thumbnail → null (client badge).
    expect(byName["00000000-0000-4000-8000-0000000000f2"].thumbnailUrl).toBeNull();

    // Image without a thumbnail → the ORIGINAL, inline (previews everywhere, pre-backfill).
    expect(keyOf(byName["00000000-0000-4000-8000-0000000000f3"].thumbnailUrl)).toBe("office_x/deals/D-1/photos/c.png");
    expect(dispositionOf(byName["00000000-0000-4000-8000-0000000000f3"].thumbnailUrl)).toBe("inline");
  });
});

describe("resolveFileThumbnailUrl external-only (CompanyCam) branch", () => {
  it("returns the external thumbnail URL for an image with no r2Key (f4)", async () => {
    const url = await resolveFileThumbnailUrl({
      r2Key: null,
      thumbnailR2Key: null,
      mimeType: "image/jpeg",
      externalThumbnailUrl: "https://cdn.example/thumb.jpg",
      externalUrl: "https://cdn.example/orig.jpg",
      displayName: "companycam",
    });
    expect(url).toBe("https://cdn.example/thumb.jpg");
  });

  it("falls back to externalUrl when only the original is present", async () => {
    const url = await resolveFileThumbnailUrl({
      r2Key: null,
      thumbnailR2Key: null,
      mimeType: "image/jpeg",
      externalThumbnailUrl: null,
      externalUrl: "https://cdn.example/orig.jpg",
      displayName: "companycam",
    });
    expect(url).toBe("https://cdn.example/orig.jpg");
  });
});
