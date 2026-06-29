import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { listFieldProjects } from "../../../src/modules/field/projects-service.js";

/**
 * REAL-SQL (PGlite) proof of the PHOTOS-FIRST ordering for the active-projects list: projects that have
 * at least one photo come back ahead of projects with none, regardless of recency — even an empty deal
 * touched LATER than every photo'd deal must sink below them. Within each group, the most recent activity
 * wins. A SQL-text assertion alone would only prove the clause is present, not that it actually sorts.
 */
const U = (s: string) => {
  const hex = [...s].map((c) => (/[0-9a-f]/i.test(c) ? c : (c.charCodeAt(0) % 16).toString(16))).join("");
  return `00000000-0000-0000-0000-${hex.padStart(12, "0").slice(-12)}`;
};
const STAGE = U("a1");
// photos-recent / photos-old have photos; empty-today / empty-old have none.
const D = { photosRecent: U("d1"), photosOld: U("d2"), emptyToday: U("d3"), emptyOld: U("d4") };
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
      id uuid PRIMARY KEY, name text NOT NULL, deal_number text, project_number text, stage_id uuid,
      property_address text, property_city text, property_state text, property_zip text,
      bid_board_stage_slug text, is_active boolean NOT NULL DEFAULT true,
      last_activity_at timestamptz, updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE field_user_starred_projects (user_id uuid NOT NULL, deal_id uuid NOT NULL, PRIMARY KEY (user_id, deal_id));
    CREATE TABLE files (id uuid PRIMARY KEY, deal_id uuid, category text, is_active boolean, deleted_at timestamptz, taken_at timestamptz, created_at timestamptz);

    INSERT INTO pipeline_stage_config (id, name, slug, is_terminal) VALUES ('${STAGE}','Estimating','estimating',false);

    -- empty-today is the MOST RECENTLY touched of all, but has no photos → it must rank below both photo'd deals.
    INSERT INTO deals (id, name, deal_number, stage_id, is_active, last_activity_at, created_at) VALUES
      ('${D.photosRecent}','Photos Recent','TR-1','${STAGE}', true, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      ('${D.photosOld}',   'Photos Old',   'TR-2','${STAGE}', true, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      ('${D.emptyToday}',  'Empty Today',  'TR-3','${STAGE}', true, '2026-06-29T00:00:00Z', '2026-06-29T00:00:00Z'),
      ('${D.emptyOld}',    'Empty Old',    'TR-4','${STAGE}', true, '2026-06-10T00:00:00Z', '2026-06-10T00:00:00Z');

    -- Photos: photos-recent's latest photo (2026-06-28) is newer than photos-old's (2026-06-20).
    INSERT INTO files (id, deal_id, category, is_active, created_at) VALUES
      ('${U("p1")}','${D.photosRecent}','photo', true, '2026-06-28T00:00:00Z'),
      ('${U("p2")}','${D.photosRecent}','photo', true, '2026-06-27T00:00:00Z'),
      ('${U("p3")}','${D.photosOld}',   'photo', true, '2026-06-20T00:00:00Z');
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("listFieldProjects photos-first ordering", () => {
  it("returns all projects with photos (recent-first) ahead of all projects with none (recent-first)", async () => {
    const { projects } = await listFieldProjects(tdb, ACCESS);
    expect(projects.map((p) => p.id)).toEqual([D.photosRecent, D.photosOld, D.emptyToday, D.emptyOld]);
  });

  it("keeps the empty-but-recently-touched deal below every photo'd deal", async () => {
    const { projects } = await listFieldProjects(tdb, ACCESS);
    const lastWithPhotos = Math.max(...projects.flatMap((p, i) => (p.photoCount > 0 ? [i] : [])));
    const firstWithout = Math.min(...projects.flatMap((p, i) => (p.photoCount === 0 ? [i] : [])));
    expect(lastWithPhotos).toBeLessThan(firstWithout);
  });
});

describe("listFieldProjects stable order under identical recency (d.id tiebreak)", () => {
  // hi-id is inserted FIRST; with the deterministic d.id tiebreak the query must still return lo before
  // hi. This is what keeps the per-office SQL order identical to mergeFieldProjects so deep pages don't
  // drop/shift tied rows.
  const T = { hi: U("e9"), lo: U("e1") };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tieDb: any;
  let tiePg: PGlite;

  beforeAll(async () => {
    tiePg = new PGlite();
    await tiePg.exec(`
      CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, name text, slug text UNIQUE, is_terminal boolean NOT NULL DEFAULT false);
      CREATE TABLE deals (
        id uuid PRIMARY KEY, name text NOT NULL, deal_number text, project_number text, stage_id uuid,
        property_address text, property_city text, property_state text, property_zip text,
        bid_board_stage_slug text, is_active boolean NOT NULL DEFAULT true,
        last_activity_at timestamptz, updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE field_user_starred_projects (user_id uuid NOT NULL, deal_id uuid NOT NULL, PRIMARY KEY (user_id, deal_id));
      CREATE TABLE files (id uuid PRIMARY KEY, deal_id uuid, category text, is_active boolean, deleted_at timestamptz, taken_at timestamptz, created_at timestamptz);

      INSERT INTO pipeline_stage_config (id, name, slug, is_terminal) VALUES ('${STAGE}','Estimating','estimating',false);

      -- Two zero-photo deals with the SAME last_activity_at (e.g. a batched HubSpot import). Insert the
      -- higher id first to prove the order comes from the id tiebreak, not insertion/physical order.
      INSERT INTO deals (id, name, deal_number, stage_id, is_active, last_activity_at, created_at) VALUES
        ('${T.hi}','Tie Hi','TR-9','${STAGE}', true, '2026-06-15T00:00:00Z', '2026-06-15T00:00:00Z'),
        ('${T.lo}','Tie Lo','TR-8','${STAGE}', true, '2026-06-15T00:00:00Z', '2026-06-15T00:00:00Z');
    `);
    tieDb = drizzle(tiePg);
  });

  afterAll(async () => {
    await tiePg?.close?.();
  });

  it("returns tied rows in ascending id order", async () => {
    const { projects } = await listFieldProjects(tieDb, ACCESS);
    expect(projects.map((p) => p.id)).toEqual([T.lo, T.hi]);
  });
});
