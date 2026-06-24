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
const OTHER_DEAL = "00000000-0000-4000-8000-0000000000d3";
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
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, deal_number text, is_active boolean NOT NULL DEFAULT true, companycam_project_id varchar(50));
    INSERT INTO users (id, display_name) VALUES ('${USER}', 'Rescuer');
    INSERT INTO deals (id, name, deal_number, is_active) VALUES
      ('${DEAL}','Target Deal','D-1', true),
      ('${INACTIVE_DEAL}','Archived Deal','D-2', false),
      ('${OTHER_DEAL}','Other Deal','D-3', true);
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
  it("rejects a malformed, unknown, or inactive deal (no photos are moved)", async () => {
    // Malformed id must fail the 400 contract here, not fall through to Postgres as a 500.
    await expect(
      assignUnassignedCompanyCamProjectToDeal(tdb as never, "111", "not-a-uuid"),
    ).rejects.toThrow();
    // Well-formed but non-existent / inactive deal -> 404.
    await expect(
      assignUnassignedCompanyCamProjectToDeal(tdb as never, "111", "00000000-0000-4000-8000-00000000dead"),
    ).rejects.toThrow();
    await expect(
      assignUnassignedCompanyCamProjectToDeal(tdb as never, "111", INACTIVE_DEAL),
    ).rejects.toThrow();
    expect(await dealIdFor("u/111/a.jpg")).toBeNull();
  });

  it("assigns EXACTLY the project's unassigned photos, then is idempotent on re-assign", async () => {
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
    // The CompanyCam project -> deal mapping is persisted on the deal (so future photos auto-link here).
    const { rows: dealRows } = (await pg.query(
      `SELECT companycam_project_id FROM deals WHERE id = $1`,
      [DEAL],
    )) as { rows: Array<{ companycam_project_id: string | null }> };
    expect(dealRows[0]?.companycam_project_id).toBe("111");
    // Project 111 is gone from the Unassigned tab; 222 remains.
    const { projects } = await getUnassignedCompanyCamProjects(tdb as never);
    expect(projects.map((p) => p.companycamProjectId)).toEqual(["222"]);

    // Idempotent: a second assign in this same test finds no still-unassigned rows, so it moves nothing
    // (self-contained — does not rely on a prior test having mutated the shared DB).
    const again = await assignUnassignedCompanyCamProjectToDeal(tdb as never, "111", DEAL);
    expect(again.assignedCount).toBe(0);

    // Race-safe: assigning the now-claimed project to a DIFFERENT deal moves 0 rows and must NOT hijack the
    // project -> deal mapping — the link stays with the deal that actually holds the photos (Codex).
    const hijack = await assignUnassignedCompanyCamProjectToDeal(tdb as never, "111", OTHER_DEAL);
    expect(hijack.assignedCount).toBe(0);
    const { rows: links } = (await pg.query(
      `SELECT id, companycam_project_id FROM deals WHERE id IN ($1, $2)`,
      [DEAL, OTHER_DEAL],
    )) as { rows: Array<{ id: string; companycam_project_id: string | null }> };
    const byId = Object.fromEntries(links.map((r) => [r.id, r.companycam_project_id]));
    expect(byId[DEAL]).toBe("111"); // still linked to the deal that holds the photos
    expect(byId[OTHER_DEAL]).toBeNull(); // not hijacked
  });
});
