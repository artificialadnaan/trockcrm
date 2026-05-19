import { describe, expect, it, vi } from "vitest";

const {
  parseRecomputeEmailStatsArgs,
  runRecomputeEmailStats,
} = await import("../../../scripts/recompute-email-stats.ts");

function makeDeps() {
  return {
    createConnections: vi.fn(async () => ({
      publicDb: {},
      tenantDb: {},
      close: async () => undefined,
    })),
    validateOffice: vi.fn(async () => ({ schemaName: "office_dallas", officeSlug: "dallas", officeId: "office-1" })),
    listEntityIds: vi.fn(async (_db: unknown, entityType: string) => {
      if (entityType === "deal") return ["deal-1", "deal-2"];
      if (entityType === "company") return ["company-1"];
      if (entityType === "contact") return ["contact-1"];
      return ["lead-1"];
    }),
    entityExists: vi.fn(async (_db: unknown, _entityType: string, entityId: string) => entityId !== "missing"),
    refreshEntityEmailStats: vi.fn(async () => undefined),
  };
}

describe("recompute-email-stats script", () => {
  it("parses single-entity mode", () => {
    expect(
      parseRecomputeEmailStatsArgs([
        "node",
        "script",
        "--office=office_dallas",
        "--entity-type=deal",
        "--entity-id=deal-1",
      ])
    ).toEqual({
      office: "office_dallas",
      entityType: "deal",
      entityId: "deal-1",
      all: false,
    });
  });

  it("rejects incomplete argument combinations", () => {
    expect(() =>
      parseRecomputeEmailStatsArgs(["node", "script", "--office=office_dallas", "--entity-type=deal"])
    ).toThrow("Provide either --all or both --entity-type and --entity-id");
  });

  it("recomputes a single entity on demand", async () => {
    const deps = makeDeps();

    const report = await runRecomputeEmailStats(
      {
        office: "office_dallas",
        entityType: "deal",
        entityId: "deal-1",
        all: false,
      },
      deps as any
    );

    expect(deps.refreshEntityEmailStats).toHaveBeenCalledWith({}, "deal", "deal-1");
    expect(report).toEqual({
      office: "office_dallas",
      entityType: "deal",
      processedEntities: 1,
    });
  });

  it("fails single-entity mode when the target id does not exist", async () => {
    const deps = makeDeps();

    await expect(
      runRecomputeEmailStats(
        {
          office: "office_dallas",
          entityType: "deal",
          entityId: "missing",
          all: false,
        },
        deps as any
      )
    ).rejects.toThrow("deal missing was not found in office_dallas");

    expect(deps.refreshEntityEmailStats).not.toHaveBeenCalled();
  });

  it("recomputes all supported entity tables in --all mode", async () => {
    const deps = makeDeps();

    const report = await runRecomputeEmailStats(
      {
        office: "office_dallas",
        entityType: null,
        entityId: null,
        all: true,
      },
      deps as any
    );

    expect(deps.listEntityIds).toHaveBeenCalledTimes(4);
    expect(deps.refreshEntityEmailStats).toHaveBeenCalledTimes(5);
    expect(report).toEqual({
      office: "office_dallas",
      entityType: "all",
      processedEntities: 5,
    });
  });
});
