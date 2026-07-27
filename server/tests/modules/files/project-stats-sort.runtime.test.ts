import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as sqlTag } from "drizzle-orm";
import { files } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  getPhotoFeed,
  getPhotoFeedFacets,
  getProjectPhotoStats,
} from "../../../src/modules/files/feed-service.js";

/**
 * REAL-SQL (PGlite) proof for the photo feed's Projects tab.
 *
 * The load-bearing case is SORT-BEFORE-LIMIT. The tab pages, so a client-side sort would only reorder
 * the page the server already chose: "most photos" would silently mean "the most-photographed of the N
 * most RECENT projects". These tests seed MORE projects than one page holds and put the extreme values
 * outside the default ordering, so a client-side implementation cannot pass them.
 *
 * Also covers the filter/count parity rule: the Projects aggregate and the Photos list must be filtered
 * by the SAME predicate, or a project row reports "900 photos" beside a Photos tab showing 12.
 */

const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000a2";
const REP = "00000000-0000-4000-8000-0000000000a3";
const OTHER_REP = "00000000-0000-4000-8000-0000000000a4";

// One project with a LARGE gallery, so the aggregate/strip path is exercised at a realistic size rather
// than the 3-photo toy case (production's biggest project holds 2,911 photos).
const BIG_PROJECT_PHOTOS = 1200;

let tdb: ReturnType<typeof drizzle>;
let pg: PGlite;

const dealId = (n: number) => `00000000-0000-4000-8000-0000000${String(n).padStart(5, "0")}`;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [files]));
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, avatar_url text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, deal_number text, assigned_rep_id uuid,
      property_city text, property_state text, source_lead_id uuid
    );
    INSERT INTO users (id, display_name) VALUES
      ('${USER_A}', 'Alice Uploader'), ('${USER_B}', 'Bob Uploader');
  `);

  // 8 projects — more than the page size used below (3), so paging is genuinely exercised.
  // Photo counts and recency are deliberately ANTI-CORRELATED: the project with the most photos has the
  // OLDEST photos, and the most recent project has the fewest. A sort applied after a recency-ordered
  // truncation therefore cannot produce the right answer.
  const projects = [
    { n: 1, photos: 5, day: 10 },
    { n: 2, photos: 40, day: 8 },
    { n: 3, photos: 2, day: 20 }, // fewest photos, MOST recent
    { n: 4, photos: 12, day: 6 },
    { n: 5, photos: 7, day: 15 },
    { n: 6, photos: 30, day: 4 },
    { n: 7, photos: 18, day: 12 },
    { n: 8, photos: BIG_PROJECT_PHOTOS, day: 1 }, // most photos, OLDEST
    { n: 9, photos: 12, day: 2 }, // TIES project 4's count — the tiebreaker case
  ];

  const dealRows = projects
    .map((p) => `('${dealId(p.n)}', 'Project ${p.n}', 'TR-${p.n}', '${p.n === 9 ? OTHER_REP : REP}', 'Dallas', 'TX', NULL)`)
    .join(",\n");
  await pg.exec(`INSERT INTO deals (id, name, deal_number, assigned_rep_id, property_city, property_state, source_lead_id) VALUES ${dealRows};`);

  const values: string[] = [];
  for (const project of projects) {
    for (let i = 0; i < project.photos; i++) {
      // Alternate uploader + source so the filter/parity assertions have something to bite on.
      const uploader = i % 2 === 0 ? USER_A : USER_B;
      const subcategory = i % 3 === 0 ? "'CompanyCam'" : "NULL";
      const photoCategory = i % 5 === 0 ? "'construction'" : "NULL";
      const takenAt = `2026-06-${String(project.day).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`;
      values.push(
        `('${dealId(project.n)}', 'photo', ${subcategory}, ${photoCategory}, 'p/${project.n}/${i}.jpg', 'sys-${project.n}-${i}.jpg', 'orig.jpg', 'photo-${project.n}-${i}', 'image/jpeg', '.jpg', 1234, 'trockcrm', 'Photos', '${uploader}', '${takenAt}', true, 1)`,
      );
    }
  }
  // Chunked so PGlite isn't handed one enormous statement.
  for (let i = 0; i < values.length; i += 500) {
    await pg.exec(`
      INSERT INTO files (deal_id, category, subcategory, photo_category, r2_key, system_filename, original_filename, display_name, mime_type, file_extension, file_size_bytes, r2_bucket, folder_path, uploaded_by, taken_at, is_active, version)
      VALUES ${values.slice(i, i + 500).join(",")};
    `);
  }

  tdb = drizzle(pg);
}, 120000);

afterAll(async () => {
  await pg?.close?.();
});

describe("getProjectPhotoStats sorting", () => {
  it("orders by photo count across ALL projects, not just the first page (sort before limit)", async () => {
    const { projects, pagination } = await getProjectPhotoStats(tdb as never, { sort: "most_photos", limit: 3 });

    expect(projects.map((p) => p.dealName)).toEqual(["Project 8", "Project 2", "Project 6"]);
    expect(projects[0].photoCount).toBe(BIG_PROJECT_PHOTOS);
    // Project 8 holds the most photos but the OLDEST ones. A client-side sort over a recency-ordered
    // page would have ranked Project 3 (newest, 2 photos) first and never seen Project 8 at all.
    expect(pagination.total).toBe(9);
    // Keyset, not page numbers: a full page hands back a position to resume from.
    expect(pagination.nextCursor).toBeTypeOf("string");
  });

  it("orders by fewest photos across all projects", async () => {
    const { projects } = await getProjectPhotoStats(tdb as never, { sort: "least_photos", limit: 3 });
    expect(projects.map((p) => p.dealName)).toEqual(["Project 3", "Project 1", "Project 5"]);
    expect(projects[0].photoCount).toBe(2);
  });

  it("defaults to most-recent-photo order", async () => {
    const { projects } = await getProjectPhotoStats(tdb as never, { limit: 3 });
    expect(projects.map((p) => p.dealName)).toEqual(["Project 3", "Project 5", "Project 7"]);
  });

  it("falls back to the recency default for an unknown sort value (bookmarked/stale URL)", async () => {
    const { projects } = await getProjectPhotoStats(tdb as never, { sort: "photo_count; DROP TABLE files" as never, limit: 1 });
    expect(projects.map((p) => p.dealName)).toEqual(["Project 3"]);
  });

  it("walks the whole set by cursor when projects TIE on the sort key", async () => {
    // Projects 4 and 9 both hold 12 photos, so `ORDER BY count(*) DESC` alone leaves their relative
    // order up to Postgres. The deal_id tiebreak is what gives the cursor a unique boundary to resume
    // from — without it the keyset predicate cannot express "strictly after this row".
    const tied = await getProjectPhotoStats(tdb as never, { sort: "most_photos", limit: 100 });
    expect(tied.projects.map((p) => p.photoCount).filter((count) => count === 12).length).toBe(2);
    expect(tied.pagination.nextCursor).toBeNull(); // short page == the end

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const { projects, pagination } = await getProjectPhotoStats(tdb as never, {
        sort: "most_photos",
        limit: 3,
        cursor,
      });
      seen.push(...projects.map((p) => p.dealId));
      if (!pagination.nextCursor) break;
      cursor = pagination.nextCursor;
    }
    expect(seen.length).toBe(9);
    expect(new Set(seen).size).toBe(9);
  });

  it("restarts the list for a malformed or stale cursor instead of erroring", async () => {
    const validUuid = "00000000-0000-4000-8000-000000000005";
    for (const bad of [
      "not-base64!!",
      "",
      // Bad uuid half.
      Buffer.from("12\u0000not-a-uuid").toString("base64url"),
      // Bad SORT-VALUE half with a perfectly good uuid. This is cast to bigint (count sorts) or
      // timestamptz (recency), so validating only the uuid left it reaching Postgres as a bad cast — a
      // 500 where the documented behaviour is "restart the list".
      Buffer.from(`not-a-number\u0000${validUuid}`).toString("base64url"),
      Buffer.from(`2026-02-30 00:00:00+00\u0000${validUuid}`).toString("base64url"),
      Buffer.from(`99999999999999999999999\u0000${validUuid}`).toString("base64url"),
    ]) {
      const { projects } = await getProjectPhotoStats(tdb as never, { sort: "most_photos", limit: 3, cursor: bad });
      expect(projects.length).toBe(3);
      expect(projects[0].dealName).toBe("Project 8");
    }
  });
});

describe("getProjectPhotoStats page payload", () => {
  it("returns the recent-photo strip and uploaders for the returned page only", async () => {
    const { projects } = await getProjectPhotoStats(tdb as never, { sort: "most_photos", limit: 1 });
    const big = projects[0];

    // Strip is capped regardless of how many photos the project holds — the per-photo work is bounded
    // by the page, not by the gallery size. 1200 photos still yield exactly 5 thumbnails.
    expect(big.recentPhotos.length).toBe(5);
    expect(big.recentPhotoIds.length).toBe(5);
    expect(big.recentPhotos[0].r2Key).toContain("p/8/");
    // Uploaders are drawn from the project's 10 most recent photos (not all 1200), so which names
    // appear depends on who took those — assert the bound, not a fixed roster.
    expect(big.recentUploaders.length).toBeGreaterThan(0);
    expect(big.recentUploaders.every((name) => ["Alice Uploader", "Bob Uploader"].includes(name))).toBe(true);
  });

  it("collects every contributor when a project's whole gallery fits inside the uploader window", async () => {
    // Project 1 holds 5 photos, all within the 10-photo uploader window, and alternates uploaders.
    const { projects } = await getProjectPhotoStats(tdb as never, { dealId: dealId(1) });
    expect(projects[0].recentUploaders.slice().sort()).toEqual(["Alice Uploader", "Bob Uploader"]);
  });

  it("returns assignedRepId so the 'My Projects' pill has something to filter on", async () => {
    const { projects } = await getProjectPhotoStats(tdb as never, { limit: 1 });
    expect(projects[0].assignedRepId).toBe(REP);
  });
});

describe("filter parity between the Projects aggregate and the Photos list", () => {
  it("applies the uploader filter to project counts, matching the photo feed's total", async () => {
    const filters = { uploadedBy: USER_A };
    const { projects } = await getProjectPhotoStats(tdb as never, { ...filters, sort: "most_photos", limit: 1 });
    const feed = await getPhotoFeed(tdb as never, "admin", REP, { ...filters, dealId: dealId(8), limit: 1 });

    // Project 8 alternates uploaders, so exactly half its photos belong to Alice. If the filter reached
    // the photo list but not the aggregate, the project row would still claim all 1200.
    expect(projects[0].photoCount).toBe(BIG_PROJECT_PHOTOS / 2);
    expect(feed.pagination.total).toBe(BIG_PROJECT_PHOTOS / 2);
  });

  it("applies the source filter, treating a NULL subcategory as T-Rock capture", async () => {
    const companycam = await getProjectPhotoStats(tdb as never, { source: "companycam", sort: "most_photos", limit: 1 });
    const trock = await getProjectPhotoStats(tdb as never, { source: "trock", sort: "most_photos", limit: 1 });

    // `subcategory` is NULL on every non-CompanyCam photo, so a plain `<> 'CompanyCam'` would evaluate
    // to NULL and drop every row — the T-Rock arm must use IS DISTINCT FROM.
    expect(trock.projects[0].photoCount).toBeGreaterThan(0);
    expect(companycam.projects[0].photoCount + trock.projects[0].photoCount).toBe(BIG_PROJECT_PHOTOS);
  });

  it("applies the phase filter, including the uncategorized bucket", async () => {
    const construction = await getProjectPhotoStats(tdb as never, { photoCategory: "construction", sort: "most_photos", limit: 1 });
    const uncategorized = await getProjectPhotoStats(tdb as never, { photoCategory: "uncategorized", sort: "most_photos", limit: 1 });

    expect(construction.projects[0].photoCount).toBe(BIG_PROJECT_PHOTOS / 5);
    expect(uncategorized.projects[0].photoCount).toBe(BIG_PROJECT_PHOTOS - BIG_PROJECT_PHOTOS / 5);
  });

  it("filters to nothing (rather than erroring) on an unknown phase value", async () => {
    // The column is cast to text instead of casting the VALUE to the enum, so a stale bookmarked
    // ?photoCategory=… can't abort the query with a 22P02 invalid-enum error.
    const { projects, pagination } = await getProjectPhotoStats(tdb as never, { photoCategory: "not_a_real_phase" });
    expect(projects).toEqual([]);
    expect(pagination.total).toBe(0);
  });
});

describe("server-side ownership and search", () => {
  it("filters to one rep's projects in SQL, so the count matches the rows", async () => {
    const { projects, pagination } = await getProjectPhotoStats(tdb as never, {
      assignedRepId: OTHER_REP,
      sort: "most_photos",
    });
    // Only project 9 belongs to the other rep. Narrowing this in the browser would have meant "the
    // rep's projects among the page the server already chose", with a header counting a different set.
    expect(projects.map((p) => p.dealName)).toEqual(["Project 9"]);
    expect(pagination.total).toBe(1);
  });

  it("matches search against deal name, number and city", async () => {
    const byName = await getProjectPhotoStats(tdb as never, { search: "Project 3" });
    expect(byName.projects.map((p) => p.dealName)).toEqual(["Project 3"]);

    const byNumber = await getProjectPhotoStats(tdb as never, { search: "TR-5" });
    expect(byNumber.projects.map((p) => p.dealName)).toEqual(["Project 5"]);

    const byCity = await getProjectPhotoStats(tdb as never, { search: "dall" });
    expect(byCity.pagination.total).toBe(9);
  });

  it("treats a LIKE wildcard typed into the search box as a literal", async () => {
    // Unescaped, "%" would match every project instead of none — a search that silently does nothing.
    const { pagination } = await getProjectPhotoStats(tdb as never, { search: "%" });
    expect(pagination.total).toBe(0);
  });
});

describe("superseded versions", () => {
  it("excludes a photo that a newer active version replaced", async () => {
    const before = await getProjectPhotoStats(tdb as never, { dealId: dealId(1) });
    expect(before.projects[0].photoCount).toBe(5);

    // uploadNewVersion stores the new version pointing at the ROOT it replaces.
    const [root] = (await tdb.execute(
      sqlTag`SELECT id::text AS id FROM files WHERE deal_id = ${dealId(1)}::uuid ORDER BY r2_key LIMIT 1`,
    ) as unknown as { rows: Array<{ id: string }> }).rows;
    await pg.exec(`
      INSERT INTO files (deal_id, category, r2_key, system_filename, original_filename, display_name, mime_type, file_extension, file_size_bytes, r2_bucket, folder_path, uploaded_by, taken_at, is_active, version, parent_file_id)
      VALUES ('${dealId(1)}', 'photo', 'p/1/0-v2.jpg', 'sys-1-0-v2.jpg', 'orig.jpg', 'photo-1-0-v2', 'image/jpeg', '.jpg', 1234, 'trockcrm', 'Photos', '${USER_A}', '2026-06-10T23:00:00Z', true, 2, '${root.id}');
    `);

    // The replacement is counted, the superseded original is not — so the count is unchanged, not 6.
    const after = await getProjectPhotoStats(tdb as never, { dealId: dealId(1) });
    expect(after.projects[0].photoCount).toBe(5);
  });
});

describe("getPhotoFeedFacets", () => {
  it("returns every uploader and phase in the library, independent of any filter", async () => {
    const facets = await getPhotoFeedFacets(tdb as never);
    expect(facets.uploaders.map((u) => u.name)).toEqual(["Alice Uploader", "Bob Uploader"]);
    expect(facets.photoCategories).toEqual(["construction"]);
    // The project picker comes from the full library so a selection can't vanish from its own dropdown.
    expect(facets.projects.length).toBe(9);
  });
});

/**
 * The reason this is keyset and not OFFSET, stated as the property that actually distinguishes them.
 *
 * Under OFFSET, "page 2" means "skip the first N rows" — so anything inserted BEFORE the boundary
 * shifts the window and the next page repeats a row while another is never delivered. Under a cursor,
 * "next" means "strictly after this exact (sortValue, dealId)", which does not depend on how many rows
 * precede it. These aggregate ordering keys (`count(*)`, `max(taken_at)`) change on every upload, so
 * that difference is the normal case here, not an edge one.
 *
 * Honest scope of the guarantee: a project whose OWN sort value moves across the cursor can still be
 * missed (it is no longer "after" the boundary) or repeated. Keyset removes the shifting-window class,
 * not every consequence of a mutable ordering — the residual is why the client still de-dupes on
 * `dealId`. What it does remove is the case where an unrelated write silently drops a row.
 *
 * Last in the file and self-cleaning: the only test here that mutates the shared fixture.
 */
describe("getProjectPhotoStats keyset paging under concurrent writes", () => {
  const DRIFT_KEY_PREFIX = "drift/";
  const NEW_DEAL = "00000000-0000-4000-8000-000000099999";

  afterAll(async () => {
    await pg.exec(`DELETE FROM files WHERE r2_key LIKE '${DRIFT_KEY_PREFIX}%';`);
    await pg.exec(`DELETE FROM deals WHERE id = '${NEW_DEAL}';`);
  });

  it("returns the same rows after a cursor no matter what is inserted BEFORE it", async () => {
    const firstPage = await getProjectPhotoStats(tdb as never, { sort: "recent", limit: 3 });
    const cursor = firstPage.pagination.nextCursor!;
    expect(cursor).toBeTypeOf("string");

    const before = await getProjectPhotoStats(tdb as never, { sort: "recent", limit: 3, cursor });
    expect(before.projects.length).toBe(3);

    // A deal that had no photos gets its first ones, newer than everything else — so it enters the
    // ordering AHEAD of the cursor. This is the write that makes an OFFSET window slide.
    await pg.exec(`
      INSERT INTO deals (id, name, deal_number, assigned_rep_id, property_city, property_state, source_lead_id)
      VALUES ('${NEW_DEAL}', 'Project New', 'TR-NEW', '${REP}', 'Dallas', 'TX', NULL);
    `);
    const rows: string[] = [];
    for (let i = 0; i < 25; i++) {
      rows.push(
        `('${NEW_DEAL}', 'photo', NULL, NULL, '${DRIFT_KEY_PREFIX}${i}.jpg', 'drift-${i}.jpg', 'orig.jpg', 'drift-${i}', 'image/jpeg', '.jpg', 10, 'trockcrm', 'Photos', '${USER_A}', '2026-07-01T0${i % 10}:00:00Z', true, 1)`,
      );
    }
    await pg.exec(`
      INSERT INTO files (deal_id, category, subcategory, photo_category, r2_key, system_filename, original_filename, display_name, mime_type, file_extension, file_size_bytes, r2_bucket, folder_path, uploaded_by, taken_at, is_active, version)
      VALUES ${rows.join(",")};
    `);

    // The new project genuinely sorts first now...
    const restarted = await getProjectPhotoStats(tdb as never, { sort: "recent", limit: 1 });
    expect(restarted.projects[0].dealName).toBe("Project New");

    // ...and the page after the ORIGINAL cursor is byte-for-byte unchanged. With OFFSET this window
    // would have slid by one, repeating a delivered project and dropping an undelivered one.
    const after = await getProjectPhotoStats(tdb as never, { sort: "recent", limit: 3, cursor });
    expect(after.projects.map((p) => p.dealId)).toEqual(before.projects.map((p) => p.dealId));
  });
});

/**
 * PHASE lives in two columns. `files.photo_category` is the typed one, but the CRM web capture flow
 * writes the phase the user picked into `files.subcategory` — its own source comments say so, and the
 * deal photo timeline already reads both. Comparing only `photo_category` would drop those photos from
 * their own phase AND miscount them as Uncategorized: the same value meaning two different things on
 * two surfaces, which is the class of bug this feed work exists to remove.
 *
 * Production holds zero phase-valued subcategories today, so this seeds the case the WRITE PATH can
 * already produce. Self-cleaning; last in the file.
 */
describe("getProjectPhotoStats phase normalization across photo_category and subcategory", () => {
  const PHASE_KEY_PREFIX = "phase/";
  const PHASE_DEAL = "00000000-0000-4000-8000-000000088888";

  beforeAll(async () => {
    await pg.exec(`
      INSERT INTO deals (id, name, deal_number, assigned_rep_id, property_city, property_state, source_lead_id)
      VALUES ('${PHASE_DEAL}', 'Project Phase', 'TR-PHASE', '${REP}', 'Austin', 'TX', NULL);
    `);
    // Phase carried on SUBCATEGORY, the way the CRM web capture page writes it.
    const rows = [0, 1, 2].map(
      (i) =>
        `('${PHASE_DEAL}', 'photo', 'preconstruction', NULL, '${PHASE_KEY_PREFIX}${i}.jpg', 'phase-${i}.jpg', 'orig.jpg', 'phase-${i}', 'image/jpeg', '.jpg', 10, 'trockcrm', 'Photos', '${USER_A}', '2026-05-0${i + 1}T00:00:00Z', true, 1)`,
    );
    await pg.exec(`
      INSERT INTO files (deal_id, category, subcategory, photo_category, r2_key, system_filename, original_filename, display_name, mime_type, file_extension, file_size_bytes, r2_bucket, folder_path, uploaded_by, taken_at, is_active, version)
      VALUES ${rows.join(",")};
    `);
  });

  afterAll(async () => {
    await pg.exec(`DELETE FROM files WHERE r2_key LIKE '${PHASE_KEY_PREFIX}%';`);
    await pg.exec(`DELETE FROM deals WHERE id = '${PHASE_DEAL}';`);
  });

  it("finds a subcategory-carried phase when filtering by that phase", async () => {
    const { projects } = await getProjectPhotoStats(tdb as never, { photoCategory: "preconstruction" });
    expect(projects.map((p) => p.dealName)).toContain("Project Phase");
    expect(projects.find((p) => p.dealName === "Project Phase")!.photoCount).toBe(3);
  });

  it("does NOT count a subcategory-carried phase as Uncategorized", async () => {
    const { projects } = await getProjectPhotoStats(tdb as never, { photoCategory: "uncategorized" });
    expect(projects.map((p) => p.dealName)).not.toContain("Project Phase");
  });

  it("still treats the CompanyCam subcategory as a SOURCE flag, not a phase", async () => {
    // CompanyCam photos carry no phase, so they belong to Uncategorized — the fixture's CompanyCam rows
    // have a null photo_category.
    const { projects } = await getProjectPhotoStats(tdb as never, { photoCategory: "uncategorized" });
    expect(projects.length).toBeGreaterThan(0);
    const { projects: asPhase } = await getProjectPhotoStats(tdb as never, { photoCategory: "companycam" });
    expect(asPhase.length).toBe(0);
  });

  it("offers the subcategory-carried phase in the facet dropdown", async () => {
    const facets = await getPhotoFeedFacets(tdb as never);
    expect(facets.photoCategories).toContain("preconstruction");
    // ...and never offers the source flag as though it were a phase.
    expect(facets.photoCategories).not.toContain("companycam");
  });
});
