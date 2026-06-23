import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { listFieldProjects, listStarredFieldProjects } from "../../../src/modules/field/projects-service.js";

/**
 * REAL-SQL (PGlite) proof that the field project LIST orders by proximity when a lat/lng is supplied
 * (closest first, NULL-coordinate deals LAST), and falls back to recency order when no coordinates are
 * given. Real NUMERIC lat/lng + a real DATE/timestamptz recency column so a text-typed shortcut can't hide
 * a numeric/date mismatch.
 */
const U = (s: string) => {
  const hex = [...s].map((c) => (/[0-9a-f]/i.test(c) ? c : (c.charCodeAt(0) % 16).toString(16))).join("");
  return `00000000-0000-0000-0000-${hex.padStart(12, "0").slice(-12)}`;
};
const ST = U("a1");
const D = { near: U("d1"), mid: U("d2"), far: U("d3"), noCoords: U("d4") };
const FIELD_USER = U("f1");
const ACCESS = { userId: FIELD_USER, userRole: "field_contractor" as const };
const ORIGIN = { lat: 32.7767, lng: -96.797 }; // downtown Dallas

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
      property_lat numeric(10,7), property_lng numeric(10,7),
      bid_board_stage_slug text, is_active boolean NOT NULL DEFAULT true,
      last_activity_at timestamptz, updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE field_user_starred_projects (user_id uuid NOT NULL, deal_id uuid NOT NULL, PRIMARY KEY (user_id, deal_id));
    CREATE TABLE files (id uuid PRIMARY KEY, deal_id uuid, category text, is_active boolean, deleted_at timestamptz, taken_at timestamptz, created_at timestamptz);

    INSERT INTO pipeline_stage_config (id, name, slug, is_terminal) VALUES ('${ST}','Opportunity','opportunity',false);

    -- near (~1mi), mid (~30mi), far (Houston ~240mi), and one with NULL coords. created_at descending in
    -- the OPPOSITE order of distance so the two sorts are clearly distinguishable: noCoords is newest.
    INSERT INTO deals (id, name, deal_number, stage_id, property_lat, property_lng, is_active, created_at) VALUES
      ('${D.near}','Near','TR-1','${ST}', 32.7900, -96.8000, true, '2026-05-01T00:00:00Z'),
      ('${D.mid}', 'Mid', 'TR-2','${ST}', 33.2000, -96.8000, true, '2026-05-02T00:00:00Z'),
      ('${D.far}', 'Far', 'TR-3','${ST}', 29.7600, -95.3700, true, '2026-05-03T00:00:00Z'),
      ('${D.noCoords}','NoCoords','TR-4','${ST}', NULL, NULL,  true, '2026-05-04T00:00:00Z');
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("listFieldProjects proximity sort", () => {
  it("orders by distance (closest first), NULL-coordinate deals LAST, when lat/lng given", async () => {
    const { projects } = await listFieldProjects(tdb, ACCESS, ORIGIN);
    expect(projects.map((p) => p.id)).toEqual([D.near, D.mid, D.far, D.noCoords]);
  });

  it("sets distanceMiles on geocoded rows and leaves it null for NULL-coordinate deals", async () => {
    const { projects } = await listFieldProjects(tdb, ACCESS, ORIGIN);
    const byId = Object.fromEntries(projects.map((p) => [p.id, p.distanceMiles]));
    expect(byId[D.near]).toBeGreaterThan(0);
    expect(byId[D.near]).toBeLessThan(byId[D.mid]!);
    expect(byId[D.mid]).toBeLessThan(byId[D.far]!);
    expect(byId[D.noCoords] ?? null).toBeNull();
  });

  it("falls back to recency order (newest first) when no coordinates are given", async () => {
    const { projects } = await listFieldProjects(tdb, ACCESS, {});
    expect(projects.map((p) => p.id)).toEqual([D.noCoords, D.far, D.mid, D.near]);
    // No distance column selected → no distanceMiles attached.
    expect(projects.every((p) => p.distanceMiles == null)).toBe(true);
  });
});

describe("listStarredFieldProjects proximity sort", () => {
  beforeAll(async () => {
    // Star the near + far deals so the starred set has two geocoded entries to order.
    await pg.exec(`INSERT INTO field_user_starred_projects (user_id, deal_id) VALUES
      ('${FIELD_USER}','${D.far}'),('${FIELD_USER}','${D.near}');`);
  });

  it("carries distanceMiles and orders starred nearest-first when given a fix", async () => {
    const { projects } = await listStarredFieldProjects(tdb, ACCESS, ORIGIN);
    expect(projects.map((p) => p.id)).toEqual([D.near, D.far]); // near before far
    expect(projects[0].distanceMiles).toBeGreaterThan(0);
    expect(projects[0].distanceMiles).toBeLessThan(projects[1].distanceMiles!);
  });

  it("omits distanceMiles (recency order) when no fix is given", async () => {
    const { projects } = await listStarredFieldProjects(tdb, ACCESS, {});
    expect(projects.every((p) => p.distanceMiles == null)).toBe(true);
  });
});
