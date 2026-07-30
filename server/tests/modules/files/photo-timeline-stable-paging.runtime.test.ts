import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deals, files, users } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { getDealPhotoTimeline } from "../../../src/modules/files/service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("d001");
const UPLOADER = U("0a01");

// Every row shares ONE taken_at. That is not a contrived case: a CompanyCam bulk import stamps
// captured_at per second, and rows with a null taken_at all collapse onto the same created_at. The
// timeline sorts on COALESCE(taken_at, created_at), so these all tie — and LIMIT/OFFSET over a tie with
// no unique tiebreak is free to return a row on two pages and another on none. A client that walks 18
// pages and concatenates them then holds duplicate ids, which collides the viewer's FlatList keyExtractor.
const TIED_AT = "2026-07-29T16:01:00Z";
const TOTAL = 40;

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  // The timeline resolves the deal's source lead and left-joins the uploader, so those tables must exist.
  await pg.exec(tenantSchemaSql("public", [files, deals, users]));
  tdb = drizzle(pg);
  await pg.exec(
    `INSERT INTO public.deals (id, deal_number, name, stage_id)
     VALUES ('${DEAL}', 'DFW-1-14126', 'District at Boynton', '${U("50a1")}')`,
  );

  for (let i = 0; i < TOTAL; i += 1) {
    const id = U(`f${String(i).padStart(3, "0")}`);
    await pg.exec(
      `INSERT INTO public.files
         (id, category, display_name, system_filename, original_filename, mime_type,
          file_size_bytes, file_extension, r2_key, r2_bucket, uploaded_by, deal_id, taken_at, created_at)
       VALUES ('${id}', 'photo', 'Photo ${i}', 'sys_${id}', 'orig_${id}.jpg', 'image/jpeg',
          1000, '.jpg', 'office_dallas/${id}', 'bucket', '${UPLOADER}', '${DEAL}',
          '${TIED_AT}', '${TIED_AT}')`,
    );
  }
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe("getDealPhotoTimeline paging is stable across pages", () => {
  it("walks every photo exactly once when the whole gallery ties on the sort key", async () => {
    const perPage = 7; // deliberately not a divisor of TOTAL, so the last page is partial
    const seen: string[] = [];
    let totalPages = 1;

    for (let page = 1; page <= totalPages; page += 1) {
      const result = await getDealPhotoTimeline(tdb, DEAL, page, perPage);
      totalPages = result.pagination.totalPages;
      seen.push(...result.photos.map((p) => p.id));
    }

    expect(seen).toHaveLength(TOTAL);
    // The property that matters to the client: no id appears twice, and none went missing.
    expect(new Set(seen).size).toBe(TOTAL);
  });

  it("returns the same page contents when the same page is fetched twice", async () => {
    const first = await getDealPhotoTimeline(tdb, DEAL, 3, 7);
    const second = await getDealPhotoTimeline(tdb, DEAL, 3, 7);
    expect(second.photos.map((p) => p.id)).toEqual(first.photos.map((p) => p.id));
  });
});
