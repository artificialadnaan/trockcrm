import { afterEach, describe, expect, it } from "vitest";

import {
  assertSafeOfficeSchema,
  buildEstimatorBackfillUpdateSql,
  planEstimatorBackfill,
} from "../../../scripts/backfill-estimator-user-id.js";
import {
  BID_BOARD_ESTIMATOR_USER_MAP_ENV,
  buildEstimatorDirectory,
} from "../../src/modules/bid-board-sync/estimator-map.js";

const ALEX = "636fd7e9-2575-4826-b11d-2869b24a12cf";
const SIDNEY = "829fad98-af4c-4acf-ad53-6625e9c0bd32";
const KASON = "4d0a9d11-bb6c-4e51-896e-d3e62dee3a1d";

afterEach(() => {
  delete process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV];
});

describe("estimator backfill", () => {
  it("plans only mapped, non-null, de-duplicated estimators", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({
      "Alex Koch": ALEX,
      "Sidney Gibson": SIDNEY,
    });
    const plan = planEstimatorBackfill([
      "Alex Koch",
      "Colby Burling",
      null,
      "Sidney Gibson",
      "Alex Koch",
      "Not Assigned",
    ]);
    expect(plan).toEqual([
      { estimator: "Alex Koch", userId: ALEX },
      { estimator: "Sidney Gibson", userId: SIDNEY },
    ]);
  });

  it("plans a flagged estimator from the directory with the env map unset — the history half", () => {
    // The flag alone only fixes deals a FUTURE sync touches, and the ingest is UPDATE-only against the
    // active export: a job that has dropped off the sheet is never revisited. Without the directory
    // reaching this planner, a newly-flagged estimator's existing rows stay "Missing estimator" until
    // somebody hand-writes an env-map entry — which is the chore this change removes.
    const directory = buildEstimatorDirectory([{ id: KASON, displayName: "Kason Reeder" }]);
    expect(planEstimatorBackfill(["Kason Reeder"], directory)).toEqual([
      { estimator: "Kason Reeder", userId: KASON },
    ]);
    // and without it, nothing — so the directory is what carries this, not a leftover env value
    expect(planEstimatorBackfill(["Kason Reeder"])).toEqual([]);
  });

  it("keeps the map's precedence when a curated alias and a flagged name collide", () => {
    process.env[BID_BOARD_ESTIMATOR_USER_MAP_ENV] = JSON.stringify({ "Kason Reeder": ALEX });
    const directory = buildEstimatorDirectory([{ id: KASON, displayName: "Kason Reeder" }]);
    expect(planEstimatorBackfill(["Kason Reeder"], directory)).toEqual([
      { estimator: "Kason Reeder", userId: ALEX },
    ]);
  });

  it("plans nothing when the env map is unset (feature inert)", () => {
    expect(planEstimatorBackfill(["Alex Koch", "Sidney Gibson"])).toEqual([]);
  });

  it("builds an idempotent per-tenant UPDATE that only fills NULLs and rejects a sales-source collision", () => {
    const sql = buildEstimatorBackfillUpdateSql("office_dallas").toLowerCase();
    expect(sql).toContain("update office_dallas.deals");
    expect(sql).toContain("set estimator_user_id = $1");
    expect(sql).toContain("bid_board_estimator = $2");
    expect(sql).toContain("estimator_user_id is null"); // idempotent: never overwrites
    // Mirrors the sync's NULLIF($16, sales_source_user_id): never set estimator == the deal's sales source.
    expect(sql).toContain("sales_source_user_id is null or sales_source_user_id <> $1");
  });

  it("validates the office schema identifier before raw interpolation", () => {
    expect(assertSafeOfficeSchema("office_dallas")).toBe("office_dallas");
    expect(() => assertSafeOfficeSchema("office_x; drop table deals")).toThrow();
    expect(() => assertSafeOfficeSchema('office_"weird"')).toThrow();
    expect(() => assertSafeOfficeSchema("public")).toThrow();
    // the UPDATE builder also rejects an unsafe schema
    expect(() => buildEstimatorBackfillUpdateSql("office_x; drop table deals")).toThrow();
  });
});
