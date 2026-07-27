import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { files } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

// Presigning is a local HMAC op that needs R2 config; stub it so this test is about SQL ordering only.
vi.mock("../../../src/lib/r2-client.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/lib/r2-client.js")>()),
  getPresignedDownloadUrl: vi.fn(async () => "https://r2.test/signed.jpg"),
  isR2Configured: () => false,
}));

const { getDealPhotoIdsInScope, getDealPhotoTimeline } = await import("../../../src/modules/files/service.js");

/**
 * REAL-SQL (PGlite) proof that the deal photo timeline can be paged DEEPLY without losing or repeating
 * photos.
 *
 * This became load-bearing with the public share viewer: it used to fetch one 500-row page and stop, so
 * ordering ties never mattered. It now walks a gallery of up to 3000 photos page by page, and bulk
 * imports (a CompanyCam sync, a single day's field upload) land with IDENTICAL timestamps. Ordering on
 * the timestamp ALONE lets Postgres arrange tied rows differently for each OFFSET, which shows up as a
 * photo appearing on two pages while another never appears at all — a share that silently under-delivers,
 * which is exactly the failure this whole change set exists to remove.
 */

const DEAL = "00000000-0000-4000-8000-0000000000d1";
const USER = "00000000-0000-4000-8000-000000000001";

// Large enough to page many times, and every photo shares ONE timestamp so the tiebreaker is the only
// thing imposing an order.
const PHOTO_COUNT = 750;
const PAGE_SIZE = 50;

let tdb: ReturnType<typeof drizzle>;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [files]));
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, avatar_url text);
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, deal_number text, source_lead_id uuid);
    INSERT INTO users (id, display_name) VALUES ('${USER}', 'Bulk Importer');
    INSERT INTO deals (id, name, deal_number, source_lead_id) VALUES ('${DEAL}', 'Big Gallery', 'TR-9', NULL);
  `);

  const values: string[] = [];
  for (let i = 0; i < PHOTO_COUNT; i++) {
    values.push(
      `('${DEAL}', 'photo', 'cc/${i}.jpg', 'sys-${i}.jpg', 'orig.jpg', 'photo-${i}', 'image/jpeg', '.jpg', 1234, 'trockcrm', 'Photos', '${USER}', '2026-06-01T12:00:00Z', true, 1)`,
    );
  }
  for (let i = 0; i < values.length; i += 250) {
    await pg.exec(`
      INSERT INTO files (deal_id, category, r2_key, system_filename, original_filename, display_name, mime_type, file_extension, file_size_bytes, r2_bucket, folder_path, uploaded_by, taken_at, is_active, version)
      VALUES ${values.slice(i, i + 250).join(",")};
    `);
  }

  tdb = drizzle(pg);
}, 120000);

afterAll(async () => {
  await pg?.close?.();
});

describe("deep paging over a large gallery with tied timestamps", () => {
  it("returns every photo exactly once across all pages", async () => {
    const first = await getDealPhotoTimeline(tdb as never, DEAL, 1, PAGE_SIZE);
    expect(first.pagination.total).toBe(PHOTO_COUNT);

    const seen: string[] = [];
    for (let page = 1; page <= first.pagination.totalPages; page++) {
      const result = await getDealPhotoTimeline(tdb as never, DEAL, page, PAGE_SIZE);
      seen.push(...result.photos.map((photo) => photo.id));
    }

    // No duplicates and no gaps: the union of the pages is the whole gallery.
    expect(seen.length).toBe(PHOTO_COUNT);
    expect(new Set(seen).size).toBe(PHOTO_COUNT);
  });

  it("is stable — refetching the same page returns the same photos in the same order", async () => {
    const a = await getDealPhotoTimeline(tdb as never, DEAL, 8, PAGE_SIZE);
    const b = await getDealPhotoTimeline(tdb as never, DEAL, 8, PAGE_SIZE);
    expect(a.photos.map((p) => p.id)).toEqual(b.photos.map((p) => p.id));
  });

  it("does not truncate a gallery larger than the old hard-coded 500-photo viewer ceiling", async () => {
    const all = await getDealPhotoTimeline(tdb as never, DEAL, 1, 1000);
    expect(all.photos.length).toBe(PHOTO_COUNT);
    expect(PHOTO_COUNT).toBeGreaterThan(500);
  });
});

describe("getDealPhotoIdsInScope", () => {
  it("validates a whole large selection in one pass and returns ids only", async () => {
    const { photos } = await getDealPhotoTimeline(tdb as never, DEAL, 1, PHOTO_COUNT);
    const ids = photos.map((photo) => photo.id);

    const found = await getDealPhotoIdsInScope(tdb as never, DEAL, ids);

    expect(new Set(found)).toEqual(new Set(ids));
    // Ids only — no display URLs, no 49-column rows. This is the one step whose cost tracks the share
    // cap rather than a page size.
    expect(found.every((id) => typeof id === "string")).toBe(true);
  });

  it("excludes ids that are not part of the deal, so a foreign selection can't be shared", async () => {
    const foreign = "00000000-0000-4000-8000-0000000000ff";
    const found = await getDealPhotoIdsInScope(tdb as never, DEAL, [foreign]);
    expect(found).toEqual([]);
  });

  it("short-circuits an empty selection without querying", async () => {
    expect(await getDealPhotoIdsInScope(tdb as never, DEAL, [])).toEqual([]);
  });
});
