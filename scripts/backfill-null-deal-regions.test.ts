import fs from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertTargetRegionsPresent,
  buildNullRegionBackfillPlan,
  runBackfillForSchema,
  writeBackupSnapshot,
  type NullRegionChange,
  type NullRegionConfigRow,
  type NullRegionDeal,
  type QueryClient,
  type SchemaResult,
} from "./backfill-null-deal-regions.js";
// Cross-check fixture: the planner must derive the SAME region the deal EDIT form would auto-select.
// resolveRegionIdForState is the exact function the form's auto-select effect calls.
import { resolveRegionIdForState } from "../client/src/components/deals/deal-region-auto-select.js";

// Active region_config rows, mirroring /pipeline/regions (is_active=true, ordered by display_order) —
// the same source the form's useRegions() consumes. IDs are arbitrary stand-ins for region_config.id.
const ACTIVE_REGIONS: NullRegionConfigRow[] = [
  { id: "id-west", slug: "west_coast", name: "West Coast", isActive: true, displayOrder: 1 },
  { id: "id-central", slug: "central", name: "Central", isActive: true, displayOrder: 2 },
  { id: "id-east", slug: "east_coast", name: "East Coast", isActive: true, displayOrder: 3 },
];

// The form's Region[] shape (use-pipeline-config) — used only for the cross-check assertions.
const FORM_REGIONS = ACTIVE_REGIONS.map((r) => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  states: [] as string[],
  displayOrder: r.displayOrder,
  isActive: r.isActive,
}));

function deal(partial: Partial<NullRegionDeal>): NullRegionDeal {
  return {
    schemaName: "office_dallas",
    dealId: "d-1",
    dealNumber: "DFW-1-1",
    dealName: "Deal",
    regionId: null,
    propertyState: null,
    isActive: true,
    ...partial,
  };
}

describe("buildNullRegionBackfillPlan", () => {
  it("maps an IL null-region deal to East Coast (the Onyx case)", () => {
    const plan = buildNullRegionBackfillPlan({
      deals: [deal({ dealId: "onyx", dealNumber: "DFW-1-15426-ab", propertyState: "IL" })],
      regions: ACTIVE_REGIONS,
    });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      dealId: "onyx",
      targetRegionSlug: "east_coast",
      targetRegionId: "id-east",
      targetRegionName: "East Coast",
    });
    expect(plan.counts.willUpdate).toBe(1);
  });

  it("maps TX->Central and CA->West Coast", () => {
    const plan = buildNullRegionBackfillPlan({
      deals: [
        deal({ dealId: "tx", propertyState: "TX" }),
        deal({ dealId: "ca", propertyState: "CA" }),
      ],
      regions: ACTIVE_REGIONS,
    });
    const byId = Object.fromEntries(plan.changes.map((c) => [c.dealId, c.targetRegionId]));
    expect(byId).toEqual({ tx: "id-central", ca: "id-west" });
  });

  it("leaves a null/empty-state deal blank (no change)", () => {
    const plan = buildNullRegionBackfillPlan({
      deals: [deal({ dealId: "none", propertyState: null }), deal({ dealId: "blank", propertyState: "  " })],
      regions: ACTIVE_REGIONS,
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.counts.noState).toBe(2);
    expect(plan.counts.willUpdate).toBe(0);
  });

  it("leaves an unmapped-state deal blank and records it", () => {
    const plan = buildNullRegionBackfillPlan({
      deals: [deal({ dealId: "pr", propertyState: "PR" })],
      regions: ACTIVE_REGIONS,
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.counts.unmappedState).toBe(1);
    expect(plan.unmappedStates.map((d) => d.dealId)).toEqual(["pr"]);
  });

  it("never touches a deal that already has a region (defensive idempotency)", () => {
    const plan = buildNullRegionBackfillPlan({
      deals: [deal({ dealId: "set", propertyState: "IL", regionId: "id-east" })],
      regions: ACTIVE_REGIONS,
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.counts.alreadySet).toBe(1);
  });

  it("normalizes spelled-out and messy state values like the form does", () => {
    const plan = buildNullRegionBackfillPlan({
      deals: [
        deal({ dealId: "spelled", propertyState: "Illinois" }),
        deal({ dealId: "messy", propertyState: " il " }),
      ],
      regions: ACTIVE_REGIONS,
    });
    expect(plan.changes.map((c) => c.targetRegionId)).toEqual(["id-east", "id-east"]);
  });

  it("records a missing target region instead of emitting a change", () => {
    const plan = buildNullRegionBackfillPlan({
      deals: [deal({ dealId: "il", propertyState: "IL" })],
      regions: ACTIVE_REGIONS.filter((r) => r.slug !== "east_coast"),
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.counts.missingTargetRegion).toBe(1);
    expect(plan.missingTargetRegions[0]).toMatchObject({ dealId: "il", targetRegionSlug: "east_coast" });
  });

  it("aggregates per-schema and per-target-region census", () => {
    const plan = buildNullRegionBackfillPlan({
      deals: [
        deal({ schemaName: "office_dallas", dealId: "a", propertyState: "IL" }),
        deal({ schemaName: "office_dallas", dealId: "b", propertyState: "TX" }),
        deal({ schemaName: "office_dallas", dealId: "c", propertyState: null }),
        deal({ schemaName: "office_atlanta", dealId: "d", propertyState: "GA" }),
      ],
      regions: ACTIVE_REGIONS,
    });
    expect(plan.counts.willUpdate).toBe(3);
    expect(plan.byTargetRegion).toEqual({ "East Coast": 2, Central: 1 });
    expect(plan.bySchema.office_dallas).toMatchObject({ candidateDeals: 3, willUpdate: 2, leftBlank: 1 });
    expect(plan.bySchema.office_atlanta).toMatchObject({ candidateDeals: 1, willUpdate: 1, leftBlank: 0 });
  });

  it("counts inactive deals it would update so they are visible in the census", () => {
    const plan = buildNullRegionBackfillPlan({
      deals: [
        deal({ dealId: "active", propertyState: "IL", isActive: true }),
        deal({ dealId: "inactive", propertyState: "TX", isActive: false }),
      ],
      regions: ACTIVE_REGIONS,
    });
    expect(plan.counts.willUpdate).toBe(2);
    expect(plan.counts.inactiveDealsUpdated).toBe(1);
  });

  it("derives the exact same region the form's auto-select would for a battery of states", () => {
    const states = ["IL", "WI", "MI", "OH", "TX", "OK", "CA", "WA", "NY", "FL", "Illinois", " ca ", "PR", "", "ZZ"];
    for (const state of states) {
      const plan = buildNullRegionBackfillPlan({
        deals: [deal({ dealId: `s-${state}`, propertyState: state })],
        regions: ACTIVE_REGIONS,
      });
      const formId = resolveRegionIdForState(FORM_REGIONS, state); // "" when the form would not auto-select
      const plannedId = plan.changes[0]?.targetRegionId ?? "";
      expect(plannedId, `state="${state}"`).toBe(formId);
    }
  });
});

/** Fake pg client that routes by SQL substring, recording every query for assertions. */
function fakeClient(handlers: Array<{ match: RegExp; rows?: any[]; rowCount?: number }>): {
  client: QueryClient;
  log: string[];
} {
  const log: string[] = [];
  const client: QueryClient = {
    async query(text: string) {
      log.push(text.trim().split("\n")[0].trim());
      for (const h of handlers) {
        if (h.match.test(text)) return { rows: h.rows ?? [], rowCount: h.rowCount ?? (h.rows?.length ?? 0) };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, log };
}

const DALLAS_REGIONS: NullRegionConfigRow[] = [
  { id: "id-west", slug: "west_coast", name: "West Coast", isActive: true, displayOrder: 1 },
  { id: "id-central", slug: "central", name: "Central", isActive: true, displayOrder: 2 },
  { id: "id-east", slug: "east_coast", name: "East Coast", isActive: true, displayOrder: 3 },
];

describe("runBackfillForSchema", () => {
  it("dry-run reads but never opens a transaction or UPDATEs", async () => {
    const { client, log } = fakeClient([
      { match: /FROM deals\b/i, rows: [{ id: "d1", dealNumber: "DFW-1", dealName: "X", propertyState: "IL", isActive: true }] },
    ]);
    const result = await runBackfillForSchema(client, "office_dallas", DALLAS_REGIONS, "dry-run");

    expect(result.plan.counts.willUpdate).toBe(1);
    expect(result.appliedChanges).toHaveLength(0);
    expect(result.after).toBeUndefined();
    expect(log.some((q) => /^BEGIN/i.test(q))).toBe(false);
    expect(log.some((q) => /^UPDATE deals/i.test(q))).toBe(false);
  });

  it("commit UPDATEs each candidate with an `AND region_id IS NULL` guard inside a transaction", async () => {
    const queries: string[] = [];
    const client: QueryClient = {
      async query(text: string) {
        queries.push(text);
        if (/FROM deals\b/i.test(text) && /region_id IS NULL/i.test(text) && /ORDER BY/i.test(text)) {
          return {
            rows: [{ id: "d1", dealNumber: "DFW-1", dealName: "X", propertyState: "IL", isActive: true }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const result = await runBackfillForSchema(client, "office_dallas", DALLAS_REGIONS, "commit");

    const update = queries.find((q) => /^UPDATE deals/im.test(q.trim()));
    expect(update).toBeDefined();
    expect(update).toMatch(/region_id IS NULL/i);
    expect(queries.some((q) => /^BEGIN/i.test(q.trim()))).toBe(true);
    expect(queries.some((q) => /^COMMIT/i.test(q.trim()))).toBe(true);
    expect(result.appliedChanges.map((c) => c.dealId)).toEqual(["d1"]);
    expect(result.appliedChanges[0].targetRegionId).toBe("id-east");
  });

  it("records as applied ONLY the rows the UPDATE actually changed (rowCount>0)", async () => {
    let updateCall = 0;
    const client: QueryClient = {
      async query(text: string) {
        if (/FROM deals\b/i.test(text) && /region_id IS NULL/i.test(text) && /ORDER BY/i.test(text)) {
          return {
            rows: [
              { id: "d1", dealNumber: "DFW-1", dealName: "A", propertyState: "IL", isActive: true },
              { id: "d2", dealNumber: "DFW-2", dealName: "B", propertyState: "TX", isActive: true },
            ],
            rowCount: 2,
          };
        }
        if (/^\s*UPDATE deals/i.test(text)) {
          updateCall += 1;
          // First UPDATE no-ops (d1 was filled by a concurrent writer -> 0 rows); second applies.
          return { rows: [], rowCount: updateCall === 1 ? 0 : 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const result = await runBackfillForSchema(client, "office_dallas", DALLAS_REGIONS, "commit");
    expect(result.plan.counts.willUpdate).toBe(2);
    expect(result.appliedChanges.map((c) => c.dealId)).toEqual(["d2"]); // d1 skipped (rowCount 0)
  });
});

describe("assertTargetRegionsPresent", () => {
  it("passes when all three deal-region targets exist", () => {
    expect(() => assertTargetRegionsPresent(DALLAS_REGIONS)).not.toThrow();
  });

  it("throws when an active target region is missing", () => {
    expect(() => assertTargetRegionsPresent(DALLAS_REGIONS.filter((r) => r.slug !== "central"))).toThrow(/central/);
  });
});

describe("writeBackupSnapshot", () => {
  const baseResult = (applied: NullRegionChange[]): SchemaResult => ({
    schema: "office_dallas",
    before: {},
    plan: buildNullRegionBackfillPlan({ deals: [], regions: DALLAS_REGIONS }),
    appliedChanges: applied,
    after: {},
  });

  it("returns null when nothing was applied (no snapshot file)", () => {
    expect(writeBackupSnapshot(baseResult([]), "commit", "stamp")).toBeNull();
  });

  it("writes an owner-only revert record with from:null for applied changes", () => {
    const change: NullRegionChange = {
      schemaName: "office_dallas",
      dealId: "onyx",
      dealNumber: "DFW-1-15426-ab",
      dealName: "The Onyx",
      isActive: true,
      propertyState: "IL",
      effectiveState: "IL",
      targetRegionSlug: "east_coast",
      targetRegionId: "id-east",
      targetRegionName: "East Coast",
    };
    const file = writeBackupSnapshot(baseResult([change]), "commit", "unit-test-stamp");
    expect(file).toBeTruthy();
    const snapshot = JSON.parse(fs.readFileSync(file!, "utf8"));
    expect(snapshot.changes).toEqual([
      { id: "onyx", dealNumber: "DFW-1-15426-ab", from: null, to: "id-east", toName: "East Coast" },
    ]);
    expect((fs.statSync(file!).mode & 0o777)).toBe(0o600);
    fs.unlinkSync(file!);
  });
});
