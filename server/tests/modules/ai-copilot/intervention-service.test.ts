import { Table } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../../../../shared/src/schema/index.js";

async function loadDisconnectCaseTables(tenantDb: {
  select: () => {
    from: (table: unknown) => Promise<unknown>;
  };
}) {
  const cases = await tenantDb.select().from(schema.aiDisconnectCases as any);
  const history = await tenantDb.select().from(schema.aiDisconnectCaseHistory as any);

  return { cases, history };
}

describe("AI intervention service schema foundation", () => {
  it("exports the disconnect case tables with the columns the workspace needs", () => {
    expect(schema.aiDisconnectCases).toBeDefined();
    expect(schema.aiDisconnectCaseHistory).toBeDefined();

    const caseColumns = (schema.aiDisconnectCases as any)[Table.Symbol.Columns];
    const historyColumns = (schema.aiDisconnectCaseHistory as any)[Table.Symbol.Columns];

    expect(Object.keys(caseColumns)).toEqual(
      expect.arrayContaining([
        "id",
        "officeId",
        "scopeType",
        "scopeId",
        "dealId",
        "companyId",
        "disconnectType",
        "clusterKey",
        "businessKey",
        "severity",
        "status",
        "assignedTo",
        "generatedTaskId",
        "escalated",
        "snoozedUntil",
        "reopenCount",
        "firstDetectedAt",
        "lastDetectedAt",
        "lastIntervenedAt",
        "resolvedAt",
        "resolutionReason",
        "metadataJson",
        "createdAt",
        "updatedAt",
      ])
    );

    expect(Object.keys(historyColumns)).toEqual(
      expect.arrayContaining([
        "id",
        "disconnectCaseId",
        "actionType",
        "actedBy",
        "actedAt",
        "fromStatus",
        "toStatus",
        "fromAssignee",
        "toAssignee",
        "fromSnoozedUntil",
        "toSnoozedUntil",
        "notes",
        "metadataJson",
      ])
    );
  });

  it("passes the exported tables into a Drizzle-style select chain", async () => {
    const selectChain = {
      from: vi.fn(async (table: unknown) => table),
    };
    const tenantDb = {
      select: vi.fn(() => selectChain),
    };

    const result = await loadDisconnectCaseTables(tenantDb as any);

    expect(tenantDb.select).toHaveBeenCalledTimes(2);
    expect(selectChain.from).toHaveBeenNthCalledWith(1, schema.aiDisconnectCases);
    expect(selectChain.from).toHaveBeenNthCalledWith(2, schema.aiDisconnectCaseHistory);
    expect(result.cases).toBe(schema.aiDisconnectCases);
    expect(result.history).toBe(schema.aiDisconnectCaseHistory);
  });
});
