import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { listNearbyFieldProjects } from "../../../src/modules/field/projects-service.js";

/**
 * REAL-SQL (PGlite) proof of the "nearest active projects" query: the haversine distance is computed in
 * SQL, results come back ordered nearest-first with a plausible `distanceMiles`, projects with NULL
 * coordinates are excluded (can't rank them), and the active-project predicate still applies (a Lost deal
 * with coordinates never surfaces). A text-typed shortcut would hide the NUMERIC lat/lng arithmetic, so
 * this uses real numeric columns.
 */
const U = (s: string) => {
  const hex = [...s].map((c) => (/[0-9a-f]/i.test(c) ? c : (c.charCodeAt(0) % 16).toString(16))).join("");
  return `00000000-0000-0000-0000-${hex.padStart(12, "0").slice(-12)}`;
};
const ST = { opp: U("a1"), lost: U("a3") };
const D = { near: U("d1"), mid: U("d2"), far: U("d3"), noCoords: U("d4"), lost: U("d5") };
const FIELD_USER = U("f1");
const ACCESS = { userId: FIELD_USER, userRole: "field_contractor" as const };

// Requester at downtown Dallas.
const ORIGIN = { lat: 32.7767, lng: -96.797 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, name text, slug text UNIQUE, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, name text NOT NULL, deal_number text, project_number text, stage_id uuid,
      property_address text, property_city text, property_state text, property_zip text,
      property_lat numeric(10,7), property_lng numeric(10,7),
      bid_board_stage_slug text, is_active boolean NOT NULL DEFAULT true,
      last_activity_at timestamptz, updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE field_user_starred_projects (user_id uuid NOT NULL, deal_id uuid NOT NULL, PRIMARY KEY (user_id, deal_id));
    CREATE TABLE files (id uuid PRIMARY KEY, deal_id uuid, category text, is_active boolean, deleted_at timestamptz, taken_at timestamptz, created_at timestamptz);

    INSERT INTO pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${ST.opp}','Opportunity','opportunity',false),
      ('${ST.lost}','Lost','lost',true);

    -- near (~a mile or two), mid (~50mi), far (~400mi), one with NULL coords, and a Lost deal at the
    -- requester's exact spot (would be distance 0 but must be excluded by the active predicate).
    INSERT INTO deals (id, name, deal_number, stage_id, property_lat, property_lng, is_active, created_at) VALUES
      ('${D.near}','Near Job','TR-1','${ST.opp}', 32.7900, -96.8000, true,  '2026-05-01T00:00:00Z'),
      ('${D.mid}', 'Mid Job', 'TR-2','${ST.opp}', 33.2000, -96.8000, true,  '2026-05-02T00:00:00Z'),
      ('${D.far}', 'Far Job', 'TR-3','${ST.opp}', 29.7600, -95.3700, true,  '2026-05-03T00:00:00Z'),
      ('${D.noCoords}','No Coords','TR-4','${ST.opp}', NULL, NULL,    true,  '2026-05-04T00:00:00Z'),
      ('${D.lost}','Lost Here','TR-5','${ST.lost}', 32.7767, -96.7970, true, '2026-05-05T00:00:00Z');
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("listNearbyFieldProjects", () => {
  it("orders active projects nearest-first and excludes NULL-coordinate + Lost deals", async () => {
    const { projects } = await listNearbyFieldProjects(tdb, ACCESS, ORIGIN);
    expect(projects.map((p) => p.id)).toEqual([D.near, D.mid, D.far]);
    expect(projects.map((p) => p.id)).not.toContain(D.noCoords);
    expect(projects.map((p) => p.id)).not.toContain(D.lost);
  });

  it("sets distanceMiles as an ascending real number", async () => {
    const { projects } = await listNearbyFieldProjects(tdb, ACCESS, ORIGIN);
    const miles = projects.map((p) => p.distanceMiles!);
    miles.forEach((m) => expect(Number.isFinite(m)).toBe(true));
    expect(miles[0]).toBeLessThan(miles[1]);
    expect(miles[1]).toBeLessThan(miles[2]);
    // Near job is ~1–2 mi from downtown Dallas; far job (Houston) is a few hundred.
    expect(miles[0]).toBeLessThan(5);
    expect(miles[2]).toBeGreaterThan(200);
  });

  it("respects the candidate limit", async () => {
    const { projects } = await listNearbyFieldProjects(tdb, ACCESS, { ...ORIGIN, limit: 2 });
    expect(projects.map((p) => p.id)).toEqual([D.near, D.mid]);
  });

  it("rejects out-of-range coordinates with a 400", async () => {
    await expect(listNearbyFieldProjects(tdb, ACCESS, { lat: 999, lng: 0 })).rejects.toThrow(/coordinate/i);
    await expect(listNearbyFieldProjects(tdb, ACCESS, { lat: 0, lng: NaN })).rejects.toThrow(/coordinate/i);
  });
});
