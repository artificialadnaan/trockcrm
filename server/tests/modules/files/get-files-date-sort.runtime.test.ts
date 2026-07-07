import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { files } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { getFiles } from "../../../src/modules/files/service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const UPLOADER = U("0a01");

async function seedInto(
  pg: PGlite,
  opts: {
    id: string;
    displayName: string;
    category: string;
    mimeType: string;
    ext: string;
    sizeBytes: number;
    createdAt: string;
  },
) {
  await pg.exec(
    `INSERT INTO public.files
       (id, category, display_name, system_filename, original_filename, mime_type,
        file_size_bytes, file_extension, r2_key, r2_bucket, uploaded_by, created_at)
     VALUES ('${opts.id}', '${opts.category}', '${opts.displayName}', 'sys_${opts.id}',
        'orig_${opts.id}${opts.ext}', '${opts.mimeType}', ${opts.sizeBytes}, '${opts.ext}',
        'office_dallas/${opts.id}', 'bucket', '${UPLOADER}', '${opts.createdAt}')`,
  );
}

// ── Main instance: 3 deterministic rows shared by the date-range + sort suites ────────────────────
// Session pinned to a deliberately NON-UTC, NON-business tz (Asia/Tokyo). Because getFiles buckets in
// America/Chicago EXPLICITLY, every assertion below must hold regardless of this session GUC — that is
// the point: it proves the boundary does not depend on the (un-pinned, in prod) session TimeZone.
let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='Asia/Tokyo';`);
  await pg.exec(tenantSchemaSql("public", [files]));
  tdb = drizzle(pg);

  // All three are mid-morning UTC (= early-morning CDT the SAME calendar day), so their CT bucket == their
  // UTC date; the near-boundary cases live in the isolated suite below.
  await seedInto(pg, { id: U("f01"), displayName: "Alpha",   category: "contract", mimeType: "application/pdf",         ext: ".pdf", sizeBytes: 300, createdAt: "2026-07-01T10:00:00Z" });
  await seedInto(pg, { id: U("f02"), displayName: "Bravo",   category: "estimate", mimeType: "application/vnd.ms-excel", ext: ".xls", sizeBytes: 100, createdAt: "2026-07-05T10:00:00Z" });
  await seedInto(pg, { id: U("f03"), displayName: "Charlie", category: "rfp",      mimeType: "image/jpeg",             ext: ".jpg", sizeBytes: 200, createdAt: "2026-07-10T10:00:00Z" });
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe("getFiles date-range filter (createdAt, business-tz bucketed)", () => {
  it("returns only files uploaded within [dateFrom, dateTo]", async () => {
    const { files: rows } = await getFiles(tdb, { dateFrom: "2026-07-03", dateTo: "2026-07-08" });
    expect(rows.map((r) => r.displayName)).toEqual(["Bravo"]);
  });

  it("treats dateTo as inclusive of the whole selected day (date-only boundary)", async () => {
    // The 2026-07-10 row (CT date 2026-07-10) must be included when dateTo is the date-only "2026-07-10".
    const { files: rows } = await getFiles(tdb, { dateFrom: "2026-07-05", dateTo: "2026-07-10" });
    expect(new Set(rows.map((r) => r.displayName))).toEqual(new Set(["Bravo", "Charlie"]));
  });

  it("dateFrom alone keeps files on/after the boundary", async () => {
    const { files: rows } = await getFiles(tdb, { dateFrom: "2026-07-05" });
    expect(new Set(rows.map((r) => r.displayName))).toEqual(new Set(["Bravo", "Charlie"]));
  });
});

// ── Isolated instance: proves the CT-day boundary is BOTH whole-day inclusive AND session-independent ──
// Session is Asia/Tokyo; both seed rows sit on a UTC/session day DIFFERENT from their Central day, so a
// naive session-relative or UTC bucket would answer differently. The assertions below only pass if the
// bucket is Central (America/Chicago).
describe("getFiles dateTo boundary (business-tz, non-UTC session)", () => {
  let pg2: PGlite;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tdb2: any;

  beforeAll(async () => {
    pg2 = new PGlite();
    await pg2.exec(`SET TimeZone='Asia/Tokyo';`);
    await pg2.exec(tenantSchemaSql("public", [files]));
    tdb2 = drizzle(pg2);
    // 8:00pm CDT on 2026-07-05 == 01:00 UTC 2026-07-06 (Tokyo: 10:00 2026-07-06). CT day = 2026-07-05.
    await seedInto(pg2, { id: U("fa5e"), displayName: "EveningCT", category: "contract", mimeType: "application/pdf", ext: ".pdf", sizeBytes: 10, createdAt: "2026-07-06T01:00:00Z" });
    // 10:00pm CDT on 2026-07-10 == 03:00 UTC 2026-07-11 (Tokyo: 12:00 2026-07-11). CT day = 2026-07-10.
    await seedInto(pg2, { id: U("fa7e"), displayName: "LateNight", category: "contract", mimeType: "application/pdf", ext: ".pdf", sizeBytes: 10, createdAt: "2026-07-11T03:00:00Z" });
  }, 30_000);

  afterAll(async () => {
    await pg2?.close();
  });

  it("buckets a late-CT-evening upload into its Central day, not the session/UTC day", async () => {
    // A session/UTC bucket would call the 01:00-UTC row 2026-07-06 and return nothing for this filter.
    const { files: rows } = await getFiles(tdb2, { dateFrom: "2026-07-05", dateTo: "2026-07-05" });
    expect(rows.map((r) => r.displayName)).toEqual(["EveningCT"]);
  });

  it("includes a 22:00 CT (03:00 UTC next-day) upload when dateTo is that Central day", async () => {
    const { files: rows } = await getFiles(tdb2, { dateTo: "2026-07-10" });
    expect(new Set(rows.map((r) => r.displayName))).toEqual(new Set(["EveningCT", "LateNight"]));
  });

  it("excludes the 22:00 CT upload when dateTo is the prior Central day", async () => {
    const { files: rows } = await getFiles(tdb2, { dateTo: "2026-07-09" });
    expect(rows.map((r) => r.displayName)).toEqual(["EveningCT"]);
  });
});

describe("getFiles sort whitelist (file_type / category / extension)", () => {
  it("sorts by extension ascending", async () => {
    const { files: rows } = await getFiles(tdb, { sortBy: "extension", sortDir: "asc" });
    expect(rows.map((r) => r.fileExtension)).toEqual([".jpg", ".pdf", ".xls"]);
  });

  it("sorts by category ascending (alphabetical, not enum-declaration order)", async () => {
    const { files: rows } = await getFiles(tdb, { sortBy: "category", sortDir: "asc" });
    expect(rows.map((r) => r.category)).toEqual(["contract", "estimate", "rfp"]);
  });

  it("sorts by file_type (mime) ascending", async () => {
    const { files: rows } = await getFiles(tdb, { sortBy: "file_type", sortDir: "asc" });
    expect(rows.map((r) => r.mimeType)).toEqual([
      "application/pdf",
      "application/vnd.ms-excel",
      "image/jpeg",
    ]);
  });

  it("falls back to createdAt for an unknown sort key", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { files: rows } = await getFiles(tdb, { sortBy: "bogus" as any, sortDir: "asc" });
    expect(rows.map((r) => r.displayName)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });
});

// Isolated instance: >limit rows that TIE on every new low-cardinality sort key AND on createdAt, so only
// the id tiebreak can order them deterministically across OFFSET pages. Locks the guarantee that a paged
// Type/category/extension sort never duplicates or skips a row.
describe("getFiles pagination determinism on low-cardinality sort ties", () => {
  let pg3: PGlite;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tdb3: any;

  beforeAll(async () => {
    pg3 = new PGlite();
    await pg3.exec(tenantSchemaSql("public", [files]));
    tdb3 = drizzle(pg3);
    for (let i = 0; i < 5; i++) {
      await seedInto(pg3, {
        id: U(`d0${i}`),
        displayName: `Tie${i}`,
        category: "contract",
        mimeType: "application/pdf",
        ext: ".pdf",
        sizeBytes: 100,
        createdAt: "2026-08-01T10:00:00Z",
      });
    }
  }, 30_000);

  afterAll(async () => {
    await pg3?.close();
  });

  it("returns every id exactly once across paged OFFSET windows when the sort column fully ties", async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const { files: rows } = await getFiles(tdb3, { sortBy: "file_type", sortDir: "asc", page, limit: 2 });
      seen.push(...rows.map((r) => r.id));
    }
    expect(seen.length).toBe(5);         // 2 + 2 + 1 across three pages
    expect(new Set(seen).size).toBe(5);  // no id duplicated on one page and skipped on another
  });
});
