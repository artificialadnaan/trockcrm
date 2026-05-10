import { describe, expect, it } from "vitest";
import {
  buildTenantBackfillPlan,
  executePlan,
  isCanonicalProjectNumber,
  parseBackfillArgs,
} from "../../../scripts/backfill-project-numbers.ts";

describe("backfill-project-numbers", () => {
  it("validates only canonical DFW/ATL project numbers", () => {
    expect(isCanonicalProjectNumber("DFW-1-12826-aa")).toBe(true);
    expect(isCanonicalProjectNumber("ATL-3-12526-ab")).toBe(true);
    expect(isCanonicalProjectNumber("DFW-12-00126-zz")).toBe(true);

    expect(isCanonicalProjectNumber("TMPWADDEXT")).toBe(false);
    expect(isCanonicalProjectNumber("KMHDRAIN")).toBe(false);
    expect(isCanonicalProjectNumber("1-ELC.1-061625")).toBe(false);
    expect(isCanonicalProjectNumber("dfw-1-12826-aa")).toBe(false);
    expect(isCanonicalProjectNumber("DFW-1-12826-a")).toBe(false);
    expect(isCanonicalProjectNumber("DFW-1-1282026-aa")).toBe(false);
    expect(isCanonicalProjectNumber("HOU-1-12826-aa")).toBe(false);
    expect(isCanonicalProjectNumber(null)).toBe(false);
  });

  it("detects existing-value and duplicate-candidate collisions before update planning", () => {
    const plan = buildTenantBackfillPlan({
      tenant: "office_dallas",
      candidates: [
        {
          id: "deal-1",
          hubspotDealId: "hs-1",
          preservedProjectNumber: "DFW-1-12826-aa",
        },
        {
          id: "deal-2",
          hubspotDealId: "hs-2",
          preservedProjectNumber: "DFW-1-12826-ab",
        },
        {
          id: "deal-3",
          hubspotDealId: "hs-3",
          preservedProjectNumber: "DFW-1-12826-aa",
        },
      ],
      existingProjectNumbers: [
        {
          dealId: "existing-1",
          hubspotDealId: "hs-existing",
          projectNumber: "DFW-1-12826-ab",
        },
      ],
    });

    expect(plan.updates).toEqual([
      expect.objectContaining({
        dealId: "deal-1",
        action: "UPDATE",
        newValue: "DFW-1-12826-aa",
      }),
    ]);
    expect(plan.collisions).toEqual([
      expect.objectContaining({
        dealId: "deal-2",
        action: "COLLISION",
        reason: "existing project_number collision",
        newValue: "DFW-1-12826-ab",
        collisionDealId: "existing-1",
      }),
      expect.objectContaining({
        dealId: "deal-3",
        action: "COLLISION",
        reason: "duplicate candidate project_number",
        newValue: "DFW-1-12826-aa",
        collisionDealId: "deal-1",
      }),
    ]);
  });

  it("plans a dry-run fixture without mutating and reports skip reasons", () => {
    const args = parseBackfillArgs(["backfill-project-numbers", "--tenant=office_dallas", "--dry-run", "--limit=10"]);
    const plan = buildTenantBackfillPlan({
      tenant: args.tenants[0],
      candidates: [
        {
          id: "canonical-1",
          hubspotDealId: "hs-canonical",
          preservedProjectNumber: "ATL-3-12526-ab",
        },
        {
          id: "legacy-1",
          hubspotDealId: "hs-legacy",
          preservedProjectNumber: "TMPWADDEXT",
        },
        {
          id: "missing-1",
          hubspotDealId: "hs-missing",
          preservedProjectNumber: null,
        },
      ],
      existingProjectNumbers: [],
    });

    expect(args.dryRun).toBe(true);
    expect(args.execute).toBe(false);
    expect(args.limit).toBe(10);
    expect(plan.examined).toBe(3);
    expect(plan.updates).toHaveLength(1);
    expect(plan.skips).toEqual([
      expect.objectContaining({ dealId: "legacy-1", action: "SKIP", reason: "legacy format" }),
      expect.objectContaining({ dealId: "missing-1", action: "SKIP", reason: "no preserved value" }),
    ]);
    expect(plan.reasonBreakdown).toEqual({
      "legacy format": 1,
      "no preserved value": 1,
    });
  });

  it("refuses to parse without an explicit tenant choice", () => {
    expect(() => parseBackfillArgs(["backfill-project-numbers", "--dry-run"])).toThrow(
      "--tenant=<office_dallas|office_atlanta|all> is required"
    );
  });

  it("does not count rows from a failed batch that rolls back", async () => {
    const plan = buildTenantBackfillPlan({
      tenant: "office_dallas",
      candidates: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          hubspotDealId: "hs-1",
          preservedProjectNumber: "DFW-1-12826-aa",
        },
        {
          id: "00000000-0000-0000-0000-000000000002",
          hubspotDealId: "hs-2",
          preservedProjectNumber: "DFW-1-12826-ab",
        },
      ],
      existingProjectNumbers: [],
    });
    const queries: string[] = [];
    let updateCount = 0;
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith("UPDATE")) {
          updateCount += 1;
          if (updateCount === 2) {
            throw new Error("simulated batch failure");
          }
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      },
    };

    const result = await executePlan(client as never, plan);

    expect(result).toEqual({ updated: 0, failedBatches: 1 });
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });
});
