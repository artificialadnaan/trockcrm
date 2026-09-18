import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deals, files, users } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { getDealPhotoTimeline } from "../../../src/modules/files/service.js";

/**
 * A DAY is not an instant, and the gap between those two facts was a real defect.
 *
 * `taken_at`/`created_at` are timestamptz and the production session is Etc/UTC, so `'2026-09-01'::date`
 * means 2026-09-01T00:00Z. A client that computed "September" from its own calendar and sent
 * 09-01..09-30 was therefore asking, in Dallas, for Aug 31 19:00 → Sep 30 19:00 local: a September
 * report that contained the end of August and omitted the last evening of September. Crews shoot until
 * dusk, so both ends of that error are real photos, and neither is visible in the result.
 *
 * These run against real Postgres because the bug is entirely in how Postgres compares a timestamptz to
 * a bare date — a mocked query builder would have agreed with the broken version.
 */
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("d001");
const UPLOADER = U("0a01");
const CHICAGO = "America/Chicago";

// Sep 1 00:30 CDT = Sep 1 05:30Z. Inside September locally; inside September in UTC too.
const EARLY_SEPT_LOCAL = "2026-09-01T05:30:00Z";
// Aug 31 20:00 CDT = Sep 1 01:00Z. AUGUST locally, September in UTC — the false inclusion.
const LATE_AUG_LOCAL = "2026-09-01T01:00:00Z";
// Sep 30 21:00 CDT = Oct 1 02:00Z. SEPTEMBER locally, October in UTC — the false omission.
const LATE_SEPT_LOCAL = "2026-10-01T02:00:00Z";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  // PIN THE SESSION ZONE. PGlite defaults to the host's zone (measured: Etc/GMT+6 on this machine),
  // while production runs Etc/UTC — and the whole subject of this file is how a bare date resolves
  // against a timestamptz, which is decided by exactly that setting. Left unpinned, the no-zone
  // characterization below asserts the host's behaviour rather than production's, and it did: it failed
  // here for a reason that had nothing to do with the code.
  await pg.exec("SET timezone = 'UTC'");
  await pg.exec(tenantSchemaSql("public", [files, deals, users]));
  tdb = drizzle(pg);
  await pg.exec(
    `INSERT INTO public.deals (id, deal_number, name, stage_id)
     VALUES ('${DEAL}', 'DFW-1-14126', 'District at Boynton', '${U("50a1")}')`,
  );
  const rows: Array<[string, string]> = [
    [U("f001"), EARLY_SEPT_LOCAL],
    [U("f002"), LATE_AUG_LOCAL],
    [U("f003"), LATE_SEPT_LOCAL],
  ];
  for (const [id, takenAt] of rows) {
    await pg.exec(
      `INSERT INTO public.files
         (id, category, display_name, system_filename, original_filename, mime_type,
          file_size_bytes, file_extension, r2_key, r2_bucket, uploaded_by, deal_id, taken_at, created_at)
       VALUES ('${id}', 'photo', 'Photo ${id}', 'sys_${id}', 'orig_${id}.jpg', 'image/jpeg',
          1000, '.jpg', 'office_dallas/${id}', 'bucket', '${UPLOADER}', '${DEAL}',
          '${takenAt}', '${takenAt}')`,
    );
  }
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

async function septemberIds(timeZone?: string): Promise<string[]> {
  const result = await getDealPhotoTimeline(tdb, DEAL, 1, 100, {
    from: "2026-09-01",
    to: "2026-09-30",
    timeZone,
  });
  return result.photos.map((p) => p.id).sort();
}

describe("photo timeline date window, by zone", () => {
  it("buckets by the CALLER'S zone when one is given", async () => {
    const ids = await septemberIds(CHICAGO);
    expect(ids).toContain(U("f001")); // Sep 1 00:30 local
    expect(ids).toContain(U("f003")); // Sep 30 21:00 local — the evening UTC would have dropped
    expect(ids).not.toContain(U("f002")); // Aug 31 20:00 local — August, and it stays out
  });

  it("is actually running in UTC, or the characterization below proves nothing", async () => {
    const result = await tdb.execute("show timezone");
    const rows = (result as { rows?: Array<Record<string, string>> }).rows ?? result;
    expect(Object.values(rows[0])[0]).toBe("UTC");
  });

  it("without a zone, keeps the historical UTC-session behaviour exactly", async () => {
    // Not an endorsement — a characterization. Every existing caller relies on this, so the new
    // parameter must be purely additive. These are also the two rows the Chicago window disagrees on,
    // so this asserts the fix actually CHANGES something rather than being decorative.
    const ids = await septemberIds(undefined);
    expect(ids).toContain(U("f002")); // late August local, but September in UTC
    expect(ids).not.toContain(U("f003")); // late September local, but October in UTC
  });

  it("a zone ahead of UTC moves the boundary the other way", async () => {
    // Tokyo is UTC+9, so Sep 1 05:30Z is Sep 1 14:30 local (in), and Oct 1 02:00Z is Oct 1 11:00
    // local (out). Proves the parameter is applied as a real zone, not a fixed western offset.
    const ids = await septemberIds("Asia/Tokyo");
    expect(ids).toContain(U("f001"));
    expect(ids).not.toContain(U("f003"));
  });

  it("returns every photo when no window is set at all", async () => {
    const result = await getDealPhotoTimeline(tdb, DEAL, 1, 100, { timeZone: CHICAGO });
    expect(result.photos).toHaveLength(3);
  });
});
