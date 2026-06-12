import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  listFieldProjects,
  listStarredFieldProjects,
  assertActiveFieldProject,
} from "../../../src/modules/field/projects-service.js";

/**
 * REAL-SQL (PGlite) proof that WON-family deals are browsable / openable on the field surface while LOST
 * stays excluded and archived (is_active=false) Won stays hidden. Locks the intent-explicit predicate
 * ("active pipeline OR Won-family, never Lost-family"), so a future widening to all terminal (which would
 * flood the list with dead Lost jobs) regresses a test.
 */
const U = (s: string) => {
  const hex = [...s].map((c) => (/[0-9a-f]/i.test(c) ? c : (c.charCodeAt(0) % 16).toString(16))).join("");
  return `00000000-0000-0000-0000-${hex.padStart(12, "0").slice(-12)}`;
};
const ST = { opp: U("a1"), won: U("a2"), lost: U("a3") };
const D = { opp: U("d1"), won: U("d2"), lost: U("d3"), wonArchived: U("d4") };
const FIELD_USER = U("f1");
const ACCESS = { userId: FIELD_USER, userRole: "field_contractor" as const };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, name text, slug text UNIQUE, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text NOT NULL, deal_number text, stage_id uuid,
      property_address text, property_city text, property_state text, property_zip text,
      bid_board_stage_slug text, is_active boolean NOT NULL DEFAULT true,
      last_activity_at timestamptz, updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE field_user_starred_projects (user_id uuid NOT NULL, deal_id uuid NOT NULL, PRIMARY KEY (user_id, deal_id));
    CREATE TABLE files (id uuid PRIMARY KEY, deal_id uuid, category text, is_active boolean, deleted_at timestamptz, taken_at timestamptz, created_at timestamptz);

    INSERT INTO pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${ST.opp}','Opportunity','opportunity',false),
      ('${ST.won}','Won','won',true),
      ('${ST.lost}','Lost','lost',true);

    INSERT INTO deals (id, name, deal_number, stage_id, is_active, created_at) VALUES
      ('${D.opp}','Active Opp','TR-1','${ST.opp}',true,  '2026-05-01T00:00:00Z'),
      ('${D.won}','Won Job','TR-2','${ST.won}',true,     '2026-05-02T00:00:00Z'),
      ('${D.lost}','Lost Job','TR-3','${ST.lost}',true,  '2026-05-03T00:00:00Z'),
      ('${D.wonArchived}','Won Archived','TR-4','${ST.won}',false,'2026-05-04T00:00:00Z');

    -- star ALL four directly (bypassing the gate) so the starred list's own filter is what's under test
    INSERT INTO field_user_starred_projects (user_id, deal_id) VALUES
      ('${FIELD_USER}','${D.opp}'),('${FIELD_USER}','${D.won}'),('${FIELD_USER}','${D.lost}'),('${FIELD_USER}','${D.wonArchived}');
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("field surface — WON browsable, LOST excluded", () => {
  it("browse list shows active-pipeline AND Won, but NOT Lost or archived Won", async () => {
    const { projects, total } = await listFieldProjects(tdb, ACCESS, {});
    const ids = projects.map((p) => p.id).sort();
    expect(ids).toEqual([D.opp, D.won].sort());
    expect(total).toBe(2);
    expect(ids).not.toContain(D.lost);
    expect(ids).not.toContain(D.wonArchived);
  });

  it("search also surfaces a Won deal", async () => {
    const { projects } = await listFieldProjects(tdb, ACCESS, { search: "Won Job" });
    expect(projects.map((p) => p.id)).toEqual([D.won]);
  });

  it("starred list applies the same filter — Won stays, Lost/archived drop", async () => {
    const { projects } = await listStarredFieldProjects(tdb, ACCESS);
    expect(projects.map((p) => p.id).sort()).toEqual([D.opp, D.won].sort());
  });

  it("open-by-id: a Won deal opens (no 404); Lost and archived Won 404", async () => {
    await expect(assertActiveFieldProject(tdb, ACCESS, D.won)).resolves.toMatchObject({ id: D.won });
    await expect(assertActiveFieldProject(tdb, ACCESS, D.opp)).resolves.toMatchObject({ id: D.opp });
    await expect(assertActiveFieldProject(tdb, ACCESS, D.lost)).rejects.toThrow(/not found/i);
    await expect(assertActiveFieldProject(tdb, ACCESS, D.wonArchived)).rejects.toThrow(/not found/i);
  });
});
