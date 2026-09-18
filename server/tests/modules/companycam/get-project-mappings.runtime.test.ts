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

import { formatDealDisplayName } from "@trock-crm/shared/types";
import * as client from "../../../src/modules/companycam/client.js";
import { getProjectMappings, linkProjectToDeal, unlinkProject } from "../../../src/modules/companycam/service.js";

/**
 * REAL-SQL proof for the 1:many auto-match (B-3): a deal that ALREADY owns one CompanyCam project must stay a
 * candidate for OTHER same-named projects. The fuzzy-match name index is built from ALL active deals, not just
 * deals with no link yet — otherwise a deal's 2nd/3rd project could never auto-link.
 */

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const FOO = U("f00"); // owns project "cc-1" already; name shared with unlinked project "cc-2"
const BAR = U("ba2"); // no link yet — sanity check the normal auto path still works
// Two ACTIVE deals sharing a normalized name ("Dup Site") — an ambiguous collision that must NOT auto-link.
const DUP_A = U("d0a");
const DUP_B = U("d0b");
// Change-order display relabel fixtures. The two FALSE rows are the discriminating cases: a name a HUMAN
// typed that merely LOOKS like a generated change-order child.
const CO_LINKED_FALSE = U("c01"); // is_change_order = FALSE, reached via the 'linked' branch
const CO_AUTO_FALSE = U("c02"); // is_change_order = FALSE, reached via the 'auto' branch
const CO_AUTO_TRUE = U("c03"); // is_change_order = TRUE  — the positive control

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
      id uuid PRIMARY KEY, sales_source_user_id uuid, name text, deal_number text, is_active boolean NOT NULL DEFAULT true,
      -- Spelled as migration 0156 creates it. getProjectMappings selects it so the admin page can relabel a
      -- change-order child by the FLAG rather than by guessing from the name.
      is_change_order boolean NOT NULL DEFAULT false,
      -- Legacy scalar mirror: link/unlink keep it in sync for un-migrated readers (#830 drops it).
      companycam_project_id varchar(50)
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
      ('${BAR}', 'Bar Plaza', 'D-2', true),
      -- Two ACTIVE deals share the same normalized name -> ambiguous, must stay manual.
      ('${DUP_A}', 'Dup Site', 'D-3', true),
      ('${DUP_B}', 'Dup Site', 'D-4', true);
    -- Change-order relabel fixtures: two human-typed names that LOOK generated (is_change_order false) and
    -- one real generated child (true). All three normalize to distinct names, so none is ambiguous.
    INSERT INTO deals (id, name, deal_number, is_active, is_change_order) VALUES
      ('${CO_LINKED_FALSE}', 'Lobby — Change Order 1', 'D-5', true, false),
      ('${CO_AUTO_FALSE}', 'Atrium — Change Order 2', 'D-6', true, false),
      ('${CO_AUTO_TRUE}', 'Tides Park Lane — Change Order 1', 'D-7', true, true);
    -- FOO already owns CompanyCam project "cc-1".
    INSERT INTO deal_companycam_projects (deal_id, companycam_project_id) VALUES ('${FOO}', 'cc-1');
    -- ...and CO_LINKED_FALSE owns "cc-6", so the 'linked' branch is exercised too.
    INSERT INTO deal_companycam_projects (deal_id, companycam_project_id) VALUES ('${CO_LINKED_FALSE}', 'cc-6');
  `);
  tdb = drizzle(pg);

  (client.getAllProjects as Mock).mockResolvedValue([
    ccProject("cc-1", "Foo Tower", 5), // already linked to FOO -> matchType 'linked'
    ccProject("cc-2", "Foo Tower", 3), // SAME name as FOO, unlinked -> must auto-match FOO (B-3)
    ccProject("cc-3", "Bar Plaza", 2), // unlinked, matches BAR -> normal auto path
    ccProject("cc-4", "Bar Plaza", 1), // ANOTHER unlinked same-named project -> must ALSO auto-match BAR (1:many)
    ccProject("cc-5", "Dup Site", 4), // name shared by TWO active deals -> ambiguous -> 'unmatched' (manual)
    ccProject("cc-6", "Lobby — Change Order 1", 6), // linked to CO_LINKED_FALSE -> 'linked'
    ccProject("cc-7", "Atrium — Change Order 2", 7), // unlinked -> auto-matches CO_AUTO_FALSE
    ccProject("cc-8", "Tides Park Lane — Change Order 1", 8), // unlinked -> auto-matches CO_AUTO_TRUE
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
    // autoLinkProjects can link all of a deal's projects in one run.
    expect(byId.get("cc-4")).toMatchObject({ matchType: "auto", dealId: BAR });

    // FINDING A: a normalized name held by TWO active deals (DUP_A + DUP_B) is ambiguous. The project
    // must fall through to 'unmatched' (manual review) — NOT auto-link to whichever deal Postgres
    // happened to return last. Assert it links to NEITHER candidate.
    expect(byId.get("cc-5")).toMatchObject({ matchType: "unmatched", dealId: null });
    expect(byId.get("cc-5")?.dealId).not.toBe(DUP_A);
    expect(byId.get("cc-5")?.dealId).not.toBe(DUP_B);
  });
});

// `deals.is_change_order` is the AUTHORITY for the change-order display relabel on the CompanyCam admin page.
// It has to survive the drizzle projection -> both mapping branches -> the ProjectMapping type -> the client
// type -> the call site. Break any link and the field arrives `undefined`, formatDealDisplayName falls back to
// parsing the NAME, and a deal a human named "Lobby — Change Order 1" is rendered "Change Order 1 — Lobby".
//
// The is_change_order = FALSE rows are the DISCRIMINATING cases: with the flag missing entirely, the TRUE row
// still renders correctly by coincidence, so a `true`-only assertion proves nothing about the wiring.
describe("getProjectMappings — deals.is_change_order reaches the admin page", () => {
  it("carries the flag on both matched branches, so a human-named change-order name is NOT relabelled", async () => {
    const mappings = await getProjectMappings(tdb as never);
    const byId = new Map(mappings.map((m) => [m.ccProjectId, m]));

    const linked = byId.get("cc-6");
    const autoFalse = byId.get("cc-7");
    const autoTrue = byId.get("cc-8");

    // Sanity: the fixtures land on the branches this test is about.
    expect(linked).toMatchObject({ matchType: "linked", dealId: CO_LINKED_FALSE });
    expect(autoFalse).toMatchObject({ matchType: "auto", dealId: CO_AUTO_FALSE });
    expect(autoTrue).toMatchObject({ matchType: "auto", dealId: CO_AUTO_TRUE });

    // What the admin page actually renders from each mapping (companycam-page.tsx).
    expect(formatDealDisplayName(linked!.dealName, linked!.dealIsChangeOrder)).toBe("Lobby — Change Order 1");
    expect(formatDealDisplayName(autoFalse!.dealName, autoFalse!.dealIsChangeOrder)).toBe("Atrium — Change Order 2");
    expect(formatDealDisplayName(autoTrue!.dealName, autoTrue!.dealIsChangeOrder)).toBe(
      "Change Order 1 — Tides Park Lane",
    );

    // And the stored value itself reached the payload — not `undefined`, not coerced to false.
    expect(linked!.dealIsChangeOrder).toBe(false);
    expect(autoFalse!.dealIsChangeOrder).toBe(false);
    expect(autoTrue!.dealIsChangeOrder).toBe(true);

    // An unmatched project has no deal at all, so there is nothing to claim about the flag.
    expect(byId.get("cc-5")?.dealIsChangeOrder).toBeUndefined();
  });
});

// B-4: linkProjectToDeal takes a project-scoped advisory lock (pg_advisory_xact_lock(hashtext(ccProjectId)))
// then delete-then-inserts so the LAST writer wins. A real cross-connection race isn't reproducible on a
// single PGlite connection, but this exercises the new lock statement against real SQL and proves the
// relink/steal semantics survive: the project moves to the target deal and stays exactly one (UNIQUE) row.
async function scalarFor(dealId: string): Promise<string | null> {
  const { rows } = (await pg.query(
    `SELECT companycam_project_id FROM deals WHERE id = $1`,
    [dealId],
  )) as { rows: Array<{ companycam_project_id: string | null }> };
  return rows[0]?.companycam_project_id ?? null;
}

describe("linkProjectToDeal — relink under advisory lock (B-4)", () => {
  it("moves an already-linked project to the target deal (last writer wins) leaving one row", async () => {
    // cc-1 currently belongs to FOO (seeded above). Stamp FOO's legacy scalar mirror too, so we can prove the
    // relink CLEARS the prior owner's scalar (not just stamps the new owner's).
    await pg.query(`UPDATE deals SET companycam_project_id = 'cc-1' WHERE id = $1`, [FOO]);
    expect(await scalarFor(FOO)).toBe("cc-1");

    await linkProjectToDeal(tdb as never, "cc-1", BAR);

    const { rows } = (await pg.query(
      `SELECT deal_id::text AS deal_id FROM deal_companycam_projects WHERE companycam_project_id = 'cc-1'`,
    )) as { rows: Array<{ deal_id: string }> };
    expect(rows).toHaveLength(1); // UNIQUE(companycam_project_id) holds — not split across deals
    expect(rows[0].deal_id).toBe(BAR); // last writer won

    // The legacy scalar mirror is stamped on the target deal so un-migrated readers still see the link.
    expect(await scalarFor(BAR)).toBe("cc-1");
    // ...and the PRIOR owner's scalar is cleared — no stale phantom link left pointing at cc-1 on FOO.
    expect(await scalarFor(FOO)).toBeNull();
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

  it("unlink clears the stale scalar mirror alongside deleting the join row", async () => {
    // Self-contained setup (so this passes under `vitest -t`, independent of the relink test above): seed
    // cc-1 -> BAR in the join table and stamp BAR's scalar mirror directly, clearing the project off any
    // other deal first.
    await pg.query(`DELETE FROM deal_companycam_projects WHERE companycam_project_id = 'cc-1'`);
    await pg.query(`INSERT INTO deal_companycam_projects (deal_id, companycam_project_id) VALUES ($1, 'cc-1')`, [BAR]);
    await pg.query(`UPDATE deals SET companycam_project_id = NULL WHERE companycam_project_id = 'cc-1'`);
    await pg.query(`UPDATE deals SET companycam_project_id = 'cc-1' WHERE id = $1`, [BAR]);
    expect(await scalarFor(BAR)).toBe("cc-1");

    await unlinkProject(tdb as never, "cc-1");

    // Join row is gone...
    const { rows } = (await pg.query(
      `SELECT 1 FROM deal_companycam_projects WHERE companycam_project_id = 'cc-1'`,
    )) as { rows: unknown[] };
    expect(rows).toHaveLength(0);
    // ...and the legacy scalar mirror on BAR is cleared, so legacy readers don't see a phantom link.
    expect(await scalarFor(BAR)).toBeNull();
  });
});
