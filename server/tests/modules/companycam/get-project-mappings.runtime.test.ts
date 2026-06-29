import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "vitest";

// Mock the CompanyCam HTTP client so getProjectMappings reads a fixed project list (no network). getAllProjects
// is the only client call getProjectMappings makes; getProjectPhotos is mocked too because service.ts imports
// it at module load.
vi.mock("../../../src/modules/companycam/client.js", () => ({
  getAllProjects: vi.fn(),
  getProjectPhotos: vi.fn(),
}));

import * as client from "../../../src/modules/companycam/client.js";
import { getProjectMappings, linkProjectToDeal } from "../../../src/modules/companycam/service.js";

/**
 * REAL-SQL proof for the 1:many auto-match (B-3): a deal that ALREADY owns one CompanyCam project must stay a
 * candidate for OTHER same-named projects. The fuzzy-match name index is built from ALL active deals, not just
 * deals with no link yet — otherwise a deal's 2nd/3rd project could never auto-link.
 */

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const FOO = U("f00"); // owns project "cc-1" already; name shared with unlinked project "cc-2"
const BAR = U("ba2"); // no link yet — sanity check the normal auto path still works

let pg: PGlite;
let tdb: ReturnType<typeof drizzle>;

const ccProject = (id: string, name: string, photoCount: number) => ({
  id,
  name,
  status: "active",
  archived: false,
  photo_count: photoCount,
  address: { street_address_1: null, street_address_2: null, city: "Dallas", state: "TX", postal_code: null, country: "US" },
  coordinates: { lat: 0, lon: 0 },
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  project_url: `https://companycam.test/${id}`,
  integrations: [],
});

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, deal_number text, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE deal_companycam_projects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL,
      companycam_project_id varchar(50) NOT NULL UNIQUE,
      project_name text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by_user_id uuid
    );
    INSERT INTO deals (id, name, deal_number, is_active) VALUES
      ('${FOO}', 'Foo Tower', 'D-1', true),
      ('${BAR}', 'Bar Plaza', 'D-2', true);
    -- FOO already owns CompanyCam project "cc-1".
    INSERT INTO deal_companycam_projects (deal_id, companycam_project_id) VALUES ('${FOO}', 'cc-1');
  `);
  tdb = drizzle(pg);

  (client.getAllProjects as Mock).mockResolvedValue([
    ccProject("cc-1", "Foo Tower", 5), // already linked to FOO -> matchType 'linked'
    ccProject("cc-2", "Foo Tower", 3), // SAME name as FOO, unlinked -> must auto-match FOO (B-3)
    ccProject("cc-3", "Bar Plaza", 2), // unlinked, matches BAR -> normal auto path
    ccProject("cc-4", "Bar Plaza", 1), // ANOTHER unlinked same-named project -> must ALSO auto-match BAR (1:many)
  ]);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("getProjectMappings — 1:many auto-match (B-3)", () => {
  it("auto-matches a 2nd same-named project to a deal that already owns one", async () => {
    const mappings = await getProjectMappings(tdb as never);
    const byId = new Map(mappings.map((m) => [m.ccProjectId, m]));

    // The already-linked project surfaces as 'linked' (unchanged behavior, via the join table).
    expect(byId.get("cc-1")).toMatchObject({ matchType: "linked", dealId: FOO });

    // B-3: the 2nd same-named project auto-matches the SAME deal even though that deal already owns cc-1.
    // (Before the fix the deal was excluded from the candidate index, leaving cc-2 'unmatched'.)
    expect(byId.get("cc-2")).toMatchObject({ matchType: "auto", dealId: FOO, dealName: "Foo Tower" });

    // Sanity: a normal unlinked deal still auto-matches its same-named project.
    expect(byId.get("cc-3")).toMatchObject({ matchType: "auto", dealId: BAR });

    // A SECOND unlinked project with the same name ALSO auto-matches the same deal in this single
    // snapshot — the deal is no longer dropped from the index after its first match (1:many), so
    // autoLinkAndSync can link all of a deal's projects in one run.
    expect(byId.get("cc-4")).toMatchObject({ matchType: "auto", dealId: BAR });
  });
});

// B-4: linkProjectToDeal takes a project-scoped advisory lock (pg_advisory_xact_lock(hashtext(ccProjectId)))
// then delete-then-inserts so the LAST writer wins. A real cross-connection race isn't reproducible on a
// single PGlite connection, but this exercises the new lock statement against real SQL and proves the
// relink/steal semantics survive: the project moves to the target deal and stays exactly one (UNIQUE) row.
describe("linkProjectToDeal — relink under advisory lock (B-4)", () => {
  it("moves an already-linked project to the target deal (last writer wins) leaving one row", async () => {
    // cc-1 currently belongs to FOO (seeded above). Relink it to BAR.
    await linkProjectToDeal(tdb as never, "cc-1", BAR);

    const { rows } = (await pg.query(
      `SELECT deal_id::text AS deal_id FROM deal_companycam_projects WHERE companycam_project_id = 'cc-1'`,
    )) as { rows: Array<{ deal_id: string }> };
    expect(rows).toHaveLength(1); // UNIQUE(companycam_project_id) holds — not split across deals
    expect(rows[0].deal_id).toBe(BAR); // last writer won
  });

  it("rejects a link to a non-existent deal with 404 (not a raw FK 500)", async () => {
    const GHOST = U("9999"); // valid UUID, no such deal row
    await expect(
      linkProjectToDeal(tdb as never, "cc-ghost", GHOST),
    ).rejects.toMatchObject({ statusCode: 404 });
    // And nothing was linked for that project.
    const { rows } = (await pg.query(
      `SELECT 1 FROM deal_companycam_projects WHERE companycam_project_id = 'cc-ghost'`,
    )) as { rows: unknown[] };
    expect(rows).toHaveLength(0);
  });
});
