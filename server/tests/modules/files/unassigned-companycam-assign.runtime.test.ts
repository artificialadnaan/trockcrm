import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  assignUnassignedCompanyCamProjectToDeal,
  getUnassignedCompanyCamProjects,
} from "../../../src/modules/files/feed-service.js";

/**
 * REAL-SQL (PGlite) proof for the "Assign to deal" action on the Unassigned tab: it sets deal_id on EXACTLY
 * the unassigned CompanyCam photos of one source project (the same five-predicate set the feed lists),
 * leaving other projects, already-assigned photos, and non-CompanyCam/non-JSON rows untouched. Idempotent,
 * and rejects an unknown/ inactive deal.
 */

const USER = "00000000-0000-4000-8000-000000000001";
const DEAL = "00000000-0000-4000-8000-0000000000d1";
const INACTIVE_DEAL = "00000000-0000-4000-8000-0000000000d2";
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
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, deal_number text, is_active boolean NOT NULL DEFAULT true);
    INSERT INTO users (id, display_name) VALUES ('${USER}', 'Rescuer');
    INSERT INTO deals (id, name, deal_number, is_active) VALUES
      ('${DEAL}','Target Deal','D-1', true),
      ('${INACTIVE_DEAL}','Archived Deal','D-2', false);
  `);

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
    // Project 111 — two UNASSIGNED CompanyCam photos (the ones that should move)
    ins({ category: "photo", subcategory: "CompanyCam", deal_id: null, r2_key: "u/111/a.jpg", display_name: "a", mime_type: "image/jpeg", notes: meta("111", "Alpha CC"), taken_at: "2026-06-20T10:00:00Z", uploaded_by: USER, is_active: "true" }),
    ins({ category: "photo", subcategory: "CompanyCam", deal_id: null, r2_key: "u/111/b.jpg", display_name: "b", mime_type: "image/jpeg", notes: meta("111", "Alpha CC"), taken_at: "2026-06-21T10:00:00Z", uploaded_by: USER, is_active: "true" }),
    // Project 111 — an ALREADY-ASSIGNED photo (to another deal): must stay put
    ins({ category: "photo", subcategory: "CompanyCam", deal_id: INACTIVE_DEAL, r2_key: "u/111/done.jpg", display_name: "done", mime_type: "image/jpeg", notes: meta("111", "Alpha CC"), taken_at: "2026-06-19T10:00:00Z", uploaded_by: USER, is_active: "true" }),
    // Project 222 — a different project's unassigned photo: must NOT move
    ins({ category: "photo", subcategory: "CompanyCam", deal_id: null, r2_key: "u/222/c.jpg", display_name: "c", mime_type: "image/jpeg", notes: meta("222", "Bravo CC"), taken_at: "2026-06-22T10:00:00Z", uploaded_by: USER, is_active: "true" }),
    // Non-CompanyCam unassigned file with plain-text notes: must NOT move
    ins({ category: "photo", subcategory: "Upload", deal_id: null, r2_key: "u/plain.jpg", display_name: "plain", mime_type: "image/jpeg", notes: "plain text", taken_at: "2026-06-18T10:00:00Z", uploaded_by: USER, is_active: "true" }),
  ].join("\n"));

  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

async function dealIdFor(r2Key: string): Promise<string | null> {
  const { rows } = (await pg.query(`SELECT deal_id FROM files WHERE r2_key = $1`, [r2Key])) as {
    rows: Array<{ deal_id: string | null }>;
  };
  return rows[0]?.deal_id ?? null;
}

describe("assignUnassignedCompanyCamProjectToDeal", () => {
  it("rejects an unknown or inactive deal (no photos are moved)", async () => {
    await expect(
      assignUnassignedCompanyCamProjectToDeal(tdb as never, "111", "00000000-0000-4000-8000-00000000dead"),
    ).rejects.toThrow();
    await expect(
      assignUnassignedCompanyCamProjectToDeal(tdb as never, "111", INACTIVE_DEAL),
    ).rejects.toThrow();
    expect(await dealIdFor("u/111/a.jpg")).toBeNull();
  });

  it("assigns EXACTLY the project's unassigned CompanyCam photos to the deal", async () => {
    const result = await assignUnassignedCompanyCamProjectToDeal(tdb as never, "111", DEAL);
    expect(result.assignedCount).toBe(2);
    expect(result.dealId).toBe(DEAL);
    // The two unassigned 111 photos now point at the deal.
    expect(await dealIdFor("u/111/a.jpg")).toBe(DEAL);
    expect(await dealIdFor("u/111/b.jpg")).toBe(DEAL);
    // The already-assigned 111 photo, the other project, and the non-CompanyCam file are untouched.
    expect(await dealIdFor("u/111/done.jpg")).toBe(INACTIVE_DEAL);
    expect(await dealIdFor("u/222/c.jpg")).toBeNull();
    expect(await dealIdFor("u/plain.jpg")).toBeNull();
    // Project 111 is gone from the Unassigned tab; 222 remains.
    const { projects } = await getUnassignedCompanyCamProjects(tdb as never);
    expect(projects.map((p) => p.companycamProjectId)).toEqual(["222"]);
  });

  it("is idempotent — re-assigning moves nothing (no still-unassigned rows remain)", async () => {
    const result = await assignUnassignedCompanyCamProjectToDeal(tdb as never, "111", DEAL);
    expect(result.assignedCount).toBe(0);
  });
});
