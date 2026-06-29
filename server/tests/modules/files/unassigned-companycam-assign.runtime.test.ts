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
 * and rejects an unknown/inactive deal.
 *
 * A deal now owns MANY CompanyCam projects via `deal_companycam_projects` (a project is 1:1 to a deal). So a
 * 2nd/3rd DIFFERENT project assigned to a deal ADDS a join row instead of a 409; the only project-link 409
 * left is when the project is already linked to ANOTHER deal.
 */

const USER = "00000000-0000-4000-8000-000000000001";
const DEAL = "00000000-0000-4000-8000-0000000000d1";
const INACTIVE_DEAL = "00000000-0000-4000-8000-0000000000d2";
const OTHER_DEAL = "00000000-0000-4000-8000-0000000000d3";
const LINKED_DEAL = "00000000-0000-4000-8000-0000000000d4"; // owns CC project "999" already (in the join table)
const TEST_DEAL = "00000000-0000-4000-8000-0000000000d5"; // active but is_test_data (hidden from the picker)
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
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, deal_number text, is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, companycam_project_id varchar(50));
    -- Join table: source of truth for deal <-> CompanyCam-project links (a deal owns many; a project is 1:1).
    CREATE TABLE deal_companycam_projects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL,
      companycam_project_id varchar(50) NOT NULL UNIQUE,
      project_name text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by_user_id uuid
    );
    INSERT INTO users (id, display_name) VALUES ('${USER}', 'Rescuer');
    INSERT INTO deals (id, name, deal_number, is_active, is_test_data, companycam_project_id) VALUES
      ('${DEAL}','Target Deal','D-1', true, false, NULL),
      ('${INACTIVE_DEAL}','Archived Deal','D-2', false, false, NULL),
      ('${OTHER_DEAL}','Other Deal','D-3', true, false, NULL),
      ('${LINKED_DEAL}','Linked Deal','D-4', true, false, NULL),
      ('${TEST_DEAL}','Test Deal','D-5', true, true, NULL);
    -- LINKED_DEAL already owns CompanyCam project "999".
    INSERT INTO deal_companycam_projects (deal_id, companycam_project_id) VALUES ('${LINKED_DEAL}', '999');
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
    // Project 222 — a different project's unassigned photo
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

async function linkedProjects(dealId: string): Promise<string[]> {
  const { rows } = (await pg.query(
    `SELECT companycam_project_id FROM deal_companycam_projects WHERE deal_id = $1 ORDER BY companycam_project_id`,
    [dealId],
  )) as { rows: Array<{ companycam_project_id: string }> };
  return rows.map((r) => r.companycam_project_id);
}

describe("assignUnassignedCompanyCamProjectToDeal", () => {
  it("rejects with the right status: malformed (400), unknown (404), inactive (404), project-linked-elsewhere (409)", async () => {
    const expectStatus = async (dealId: string, status: number) => {
      try {
        await assignUnassignedCompanyCamProjectToDeal(tdb as never, "111", dealId);
        throw new Error(`expected a rejection with status ${status}`);
      } catch (err) {
        // Assert the AppError contract status, not just that SOMETHING threw, so a generic Postgres 500
        // can't masquerade as the intended 400/404/409.
        expect((err as { statusCode?: number }).statusCode).toBe(status);
      }
    };
    await expectStatus("not-a-uuid", 400); // malformed id never reaches Postgres
    await expectStatus("00000000-0000-4000-8000-00000000dead", 404); // well-formed but unknown
    await expectStatus(INACTIVE_DEAL, 404); // inactive
    await expectStatus(TEST_DEAL, 404); // active but test-data — hidden from the picker, must not be a target

    // Project "999" is already linked to LINKED_DEAL — assigning it to DEAL would split the project across
    // deals, so it's rejected (a project stays 1:1 to a deal) and the existing link is left untouched.
    await expect(
      assignUnassignedCompanyCamProjectToDeal(tdb as never, "999", DEAL),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await linkedProjects(LINKED_DEAL)).toEqual(["999"]); // not stolen
    expect(await linkedProjects(DEAL)).toEqual([]); // nothing added to DEAL

    // No photos moved by any rejection.
    expect(await dealIdFor("u/111/a.jpg")).toBeNull();
  });

  it("assigns a project's unassigned photos, ADDS a 2nd different project to the same deal, then is idempotent", async () => {
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
    // The project -> deal link is persisted in the join table (so future photos auto-link here).
    expect(await linkedProjects(DEAL)).toEqual(["111"]);
    // Project 111 is gone from the Unassigned tab; 222 remains.
    {
      const { projects } = await getUnassignedCompanyCamProjects(tdb as never);
      expect(projects.map((p) => p.companycamProjectId)).toEqual(["222"]);
    }

    // 1:MANY — a 2nd DIFFERENT project assigned to the SAME deal ADDS a link (no 409) and moves its photo.
    const second = await assignUnassignedCompanyCamProjectToDeal(tdb as never, "222", DEAL);
    expect(second.assignedCount).toBe(1);
    expect(await dealIdFor("u/222/c.jpg")).toBe(DEAL);
    expect(await linkedProjects(DEAL)).toEqual(["111", "222"]); // deal now owns BOTH projects
    {
      const { projects } = await getUnassignedCompanyCamProjects(tdb as never);
      expect(projects.map((p) => p.companycamProjectId)).toEqual([]); // backlog cleared
    }

    // Idempotent: re-assigning 111 finds no still-unassigned rows, so it moves nothing and adds no row.
    const again = await assignUnassignedCompanyCamProjectToDeal(tdb as never, "111", DEAL);
    expect(again.assignedCount).toBe(0);
    expect(await linkedProjects(DEAL)).toEqual(["111", "222"]);

    // A project stays 1:1 with a deal: now that 111 is linked to DEAL, assigning it to a DIFFERENT deal is
    // rejected (409) rather than silently splitting it across deals — and the original link is untouched.
    await expect(
      assignUnassignedCompanyCamProjectToDeal(tdb as never, "111", OTHER_DEAL),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await linkedProjects(DEAL)).toEqual(["111", "222"]); // still owns both
    expect(await linkedProjects(OTHER_DEAL)).toEqual([]); // not hijacked
  });
});
