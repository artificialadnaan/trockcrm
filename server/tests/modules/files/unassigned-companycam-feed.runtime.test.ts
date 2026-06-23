import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  getUnassignedCompanyCamProjects,
  getUnassignedCompanyCamPhotos,
} from "../../../src/modules/files/feed-service.js";

/**
 * REAL-SQL (PGlite) proof for the "Unassigned" CompanyCam feed:
 *  - groups unlinked (deal_id IS NULL) CompanyCam photos by their source project (from notes JSON);
 *  - the CASE-guarded ::jsonb cast does NOT choke on a non-JSON `notes` value (a plain-text note on a
 *    non-CompanyCam file), and that file is excluded;
 *  - assigned CompanyCam photos (deal_id set) are excluded;
 *  - the drill-in returns exactly one project's photos.
 */

const USER = "00000000-0000-4000-8000-000000000001";
let tdb: ReturnType<typeof drizzle>;
let pg: PGlite;

const meta = (projectId: string, name: string) =>
  JSON.stringify({ companycamProjectId: projectId, companycamProjectName: name });

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [files]));
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, deal_number text);
    INSERT INTO users (id, display_name) VALUES ('${USER}', 'Rescuer');
    INSERT INTO deals (id, name, deal_number) VALUES ('00000000-0000-4000-8000-0000000000d1','Linked Deal','D-1');
  `);

  // Fill NOT NULL columns the feature doesn't care about with placeholders.
  const base = {
    folder_path: "Photos/CompanyCam/2026-06",
    system_filename: "sys.jpg",
    original_filename: "orig.jpg",
    file_size_bytes: "1234",
    file_extension: ".jpg",
    r2_bucket: "trockcrm",
  };
  const ins = (cols: Record<string, string | null>) => {
    const merged = { ...base, system_filename: `sys-${cols.r2_key}.jpg`, ...cols };
    const keys = Object.keys(merged);
    const vals = keys.map((k) => (merged[k] === null ? "NULL" : `'${String(merged[k]).replace(/'/g, "''")}'`));
    return `INSERT INTO files (${keys.join(",")}) VALUES (${vals.join(",")});`;
  };

  await pg.exec([
    // Two unassigned CompanyCam photos in project 111 ("Alpha CC")
    ins({ category: "photo", subcategory: "CompanyCam", deal_id: null, r2_key: "u/111/a.jpg", display_name: "a", mime_type: "image/jpeg", notes: meta("111", "Alpha CC"), taken_at: "2026-06-20T10:00:00Z", uploaded_by: USER, is_active: "true" }),
    ins({ category: "photo", subcategory: "CompanyCam", deal_id: null, r2_key: "u/111/b.jpg", display_name: "b", mime_type: "image/jpeg", notes: meta("111", "Alpha CC"), taken_at: "2026-06-21T10:00:00Z", uploaded_by: USER, is_active: "true" }),
    // One unassigned CompanyCam photo in project 222 ("Bravo CC") — most recent
    ins({ category: "photo", subcategory: "CompanyCam", deal_id: null, r2_key: "u/222/c.jpg", display_name: "c", mime_type: "image/jpeg", notes: meta("222", "Bravo CC"), taken_at: "2026-06-22T10:00:00Z", uploaded_by: USER, is_active: "true" }),
    // Assigned CompanyCam photo — must be excluded
    ins({ category: "photo", subcategory: "CompanyCam", deal_id: "00000000-0000-4000-8000-0000000000d1", r2_key: "u/111/assigned.jpg", display_name: "assigned", mime_type: "image/jpeg", notes: meta("111", "Alpha CC"), taken_at: "2026-06-23T10:00:00Z", uploaded_by: USER, is_active: "true" }),
    // Non-CompanyCam file, unassigned, with PLAIN-TEXT notes — must not break the jsonb cast, excluded
    ins({ category: "photo", subcategory: "Upload", deal_id: null, r2_key: "u/plain.jpg", display_name: "plain", mime_type: "image/jpeg", notes: "just a plain text note", taken_at: "2026-06-19T10:00:00Z", uploaded_by: USER, is_active: "true" }),
    // CompanyCam file whose notes START WITH `{` but are MALFORMED JSON — the validity guard must skip
    // it (not abort the whole query with a 500).
    ins({ category: "photo", subcategory: "CompanyCam", deal_id: null, r2_key: "u/malformed.jpg", display_name: "malformed", mime_type: "image/jpeg", notes: "{needs review", taken_at: "2026-06-24T10:00:00Z", uploaded_by: USER, is_active: "true" }),
  ].join("\n"));

  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

describe("getUnassignedCompanyCamProjects", () => {
  it("groups unlinked CompanyCam photos by source project, newest first, ignoring assigned + non-JSON rows", async () => {
    const { projects } = await getUnassignedCompanyCamProjects(tdb as never);
    expect(projects.map((p) => p.companycamProjectId)).toEqual(["222", "111"]); // 222 has the newest photo
    const byId = Object.fromEntries(projects.map((p) => [p.companycamProjectId, p]));
    expect(byId["111"].photoCount).toBe(2);
    expect(byId["111"].companycamProjectName).toBe("Alpha CC");
    expect(byId["222"].photoCount).toBe(1);
    expect(byId["222"].recentPhotos.length).toBe(1);
  });
});

describe("getUnassignedCompanyCamPhotos", () => {
  it("returns only the requested project's unassigned photos, newest first", async () => {
    const { photos, pagination } = await getUnassignedCompanyCamPhotos(tdb as never, "111");
    expect(pagination).toMatchObject({ page: 1, limit: 40, total: 2, totalPages: 1 });
    // Service orders by timestamp DESC; assert the exact order (b is newer than a) rather than sorting.
    expect(photos.map((p) => p.displayName)).toEqual(["b", "a"]);
    expect(photos.every((p) => p.dealId === null)).toBe(true);
    expect(photos[0].dealName).toBe("Alpha CC"); // name surfaced from notes for display
  });

  it("clamps invalid pagination params (NaN/negative) instead of producing a bad query", async () => {
    const { photos, pagination } = await getUnassignedCompanyCamPhotos(tdb as never, "111", NaN, -5);
    expect(pagination).toMatchObject({ page: 1, limit: 40, total: 2 });
    expect(photos.length).toBe(2);
  });
});
