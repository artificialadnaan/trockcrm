import { describe, expect, it, vi, beforeEach } from "vitest";

const updateDealMock = vi.hoisted(() => vi.fn());
const updateLeadMock = vi.hoisted(() => vi.fn());
const poolQueryMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../server/src/modules/deals/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../server/src/modules/deals/service.js")>(
    "../../../../server/src/modules/deals/service.js"
  );
  return {
    ...actual,
    updateDeal: updateDealMock,
  };
});

vi.mock("../../../../server/src/modules/leads/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../server/src/modules/leads/service.js")>(
    "../../../../server/src/modules/leads/service.js"
  );
  return {
    ...actual,
    updateLead: updateLeadMock,
  };
});

vi.mock("../../../../server/src/db.js", () => ({
  pool: {
    query: poolQueryMock,
  },
}));

import {
  bulkReassignOwnershipQueueRows,
  getMyCleanupQueue,
  getOfficeOwnershipQueue,
} from "../../../../server/src/modules/admin/cleanup-queue-service.js";

type CleanupRowSeed = {
  id: string;
  name: string;
  stageId: string;
  stageName: string;
  assignedRepId: string | null;
  decisionMakerName: string | null;
  budgetStatus: string | null;
  nextStep: string | null;
  nextStepDueAt: string | null;
  forecastWindow: string | null;
  forecastConfidencePercent: number | null;
  lastActivityAt: string | null;
  companyId: string | null;
  propertyId: string | null;
  ownershipSyncStatus: string | null;
  unassignedReasonCode: string | null;
};

const repLeadRows: CleanupRowSeed[] = [
  {
    id: "lead-1",
    name: "Rep Lead",
    stageId: "stage-lead-1",
    stageName: "Lead Qualification",
    assignedRepId: "rep-1",
    decisionMakerName: null,
    budgetStatus: null,
    nextStep: null,
    nextStepDueAt: null,
    forecastWindow: null,
    forecastConfidencePercent: null,
    lastActivityAt: "2026-04-20T12:00:00.000Z",
    companyId: "company-1",
    propertyId: "property-1",
    ownershipSyncStatus: "matched",
    unassignedReasonCode: null,
  },
];

const repDealRows: CleanupRowSeed[] = [
  {
    id: "deal-1",
    name: "Rep Deal",
    stageId: "stage-deal-1",
    stageName: "Estimating",
    assignedRepId: "rep-1",
    decisionMakerName: "Taylor",
    budgetStatus: null,
    nextStep: "Follow up",
    nextStepDueAt: null,
    forecastWindow: "Q2",
    forecastConfidencePercent: 75,
    lastActivityAt: "2026-04-19T12:00:00.000Z",
    companyId: "company-1",
    propertyId: "property-1",
    ownershipSyncStatus: "matched",
    unassignedReasonCode: null,
  },
  {
    id: "deal-2",
    name: "Other Rep Deal",
    stageId: "stage-deal-2",
    stageName: "Estimating",
    assignedRepId: "rep-2",
    decisionMakerName: null,
    budgetStatus: null,
    nextStep: null,
    nextStepDueAt: null,
    forecastWindow: null,
    forecastConfidencePercent: null,
    lastActivityAt: null,
    companyId: null,
    propertyId: null,
    ownershipSyncStatus: "matched",
    unassignedReasonCode: null,
  },
];

const officeLeadRows: CleanupRowSeed[] = [
  {
    id: "lead-2",
    name: "Office Lead",
    stageId: "stage-lead-2",
    stageName: "Lead Qualification",
    assignedRepId: null,
    decisionMakerName: null,
    budgetStatus: null,
    nextStep: null,
    nextStepDueAt: null,
    forecastWindow: null,
    forecastConfidencePercent: null,
    lastActivityAt: null,
    companyId: null,
    propertyId: null,
    ownershipSyncStatus: "unmatched",
    unassignedReasonCode: "owner_mapping_failure",
  },
];

const officeDealRows: CleanupRowSeed[] = [
  {
    id: "deal-3",
    name: "Office Deal",
    stageId: "stage-deal-3",
    stageName: "Qualification",
    assignedRepId: "rep-3",
    decisionMakerName: null,
    budgetStatus: null,
    nextStep: null,
    nextStepDueAt: null,
    forecastWindow: null,
    forecastConfidencePercent: null,
    lastActivityAt: null,
    companyId: null,
    propertyId: null,
    ownershipSyncStatus: "conflict",
    unassignedReasonCode: "inactive_owner_match",
  },
];

function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object") return "";

  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }

  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }

  return "";
}

function extractSqlLiteralText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks
      .map((chunk) => {
        if (typeof chunk === "string") return chunk;
        if (typeof chunk === "number" || typeof chunk === "boolean") return "";
        if (!chunk || typeof chunk !== "object") return "";
        if (!("value" in chunk)) return "";
        const chunkValue = (chunk as { value: unknown }).value;
        if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlLiteralText).join("");
        if (typeof chunkValue === "string") return chunkValue;
        return "";
      })
      .join("");
  }

  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlLiteralText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }

  return "";
}

function makeTenantDb(rowsByTable: Record<string, CleanupRowSeed[]>) {
  const execute = vi.fn(async (query: unknown) => {
    const text = extractSqlText(query).replace(/\s+/g, " ").trim().toLowerCase();

    if (text.includes("from deals")) {
      const rows = rowsByTable.deals ?? [];
      if (/(?:^|\s)id\s*=/i.test(text)) {
        const id = extractSqlText(query).match(/id = ([^ \n]+)/i)?.[1]?.replace(/['"]/g, "");
        return { rows: rows.filter((row) => row.id === id) };
      }
      if (text.includes("assigned_rep_id =")) {
        const assignee = extractSqlText(query).match(/assigned_rep_id = ([^ \n]+)/i)?.[1]?.replace(/['"]/g, "");
        return { rows: rows.filter((row) => row.assignedRepId === assignee) };
      }
      if (text.includes("assigned_rep_id is null") || text.includes("ownership_sync_status")) {
        return { rows: rows.filter((row) => row.assignedRepId === null || row.unassignedReasonCode != null) };
      }
      return { rows };
    }

    if (text.includes("from leads")) {
      const rows = rowsByTable.leads ?? [];
      if (/(?:^|\s)id\s*=/i.test(text)) {
        const id = extractSqlText(query).match(/id = ([^ \n]+)/i)?.[1]?.replace(/['"]/g, "");
        return { rows: rows.filter((row) => row.id === id) };
      }
      if (text.includes("assigned_rep_id =")) {
        const assignee = extractSqlText(query).match(/assigned_rep_id = ([^ \n]+)/i)?.[1]?.replace(/['"]/g, "");
        return { rows: rows.filter((row) => row.assignedRepId === assignee) };
      }
      if (text.includes("assigned_rep_id is null") || text.includes("ownership_sync_status")) {
        return { rows: rows.filter((row) => row.assignedRepId === null || row.unassignedReasonCode != null) };
      }
      return { rows };
    }

    return { rows: [] };
  });

  return {
    execute,
  };
}

beforeEach(() => {
  updateDealMock.mockReset();
  updateLeadMock.mockReset();
  poolQueryMock.mockReset();
  poolQueryMock.mockResolvedValue({
    rows: [
      { id: "office-1", name: "Office One", slug: "office-one" },
      { id: "office-2", name: "Office Two", slug: "office-two" },
    ],
  });
});

describe("cleanup queue service", () => {
  it("returns rep cleanup items only for assigned records", async () => {
    const tenantDb = makeTenantDb({ deals: repDealRows, leads: repLeadRows });

    const result = await getMyCleanupQueue(tenantDb as any, "rep-1", "office-1");

    expect(result.rows.map((row) => row.recordId)).toEqual(["deal-1", "lead-1"]);
    expect(result.rows.every((row) => row.assignedUserId === "rep-1")).toBe(true);
    expect(result.rows.every((row) => row.reasonCodes.length > 0)).toBe(true);
  });

  it("returns office ownership rows only for unassigned or ownership-exception records", async () => {
    const tenantDb = makeTenantDb({ deals: officeDealRows, leads: officeLeadRows });

    const result = await getOfficeOwnershipQueue(tenantDb as any, "office-1");

    expect(result.rows.map((row) => row.recordId)).toEqual(["deal-3", "lead-2"]);
    expect(result.rows.map((row) => row.stageName)).toEqual(["Qualification", "Lead Qualification"]);
    expect(
      result.rows.every((row) =>
        row.reasonCodes.some((reason) =>
          ["unassigned_owner", "owner_mapping_failure", "inactive_owner_match"].includes(reason)
        )
      )
    ).toBe(true);
    expect(result.rows.flatMap((row) => row.reasonCodes)).toEqual(expect.arrayContaining(["owner_mapping_failure", "inactive_owner_match"]));
  });

  it("groups reason codes by missing_next_step and missing_budget_status", async () => {
    const tenantDb = makeTenantDb({ deals: repDealRows, leads: repLeadRows });

    const result = await getMyCleanupQueue(tenantDb as any, "rep-1", "office-1");
    const grouped = new Map(result.byReason.map((item) => [item.reasonCode, item.count]));

    expect(grouped.get("missing_next_step")).toBe(1);
    expect(grouped.get("missing_budget_status")).toBe(2);
  });

  it("allows a director to view a non-active office they can access", async () => {
    const tenantDb = makeTenantDb({ deals: officeDealRows, leads: officeLeadRows });

    const result = await getOfficeOwnershipQueue(
      tenantDb as any,
      "office-2",
      { id: "director-1", role: "director", officeId: "office-1", activeOfficeId: "office-1" } as any
    );

    expect(result.rows.map((row) => row.recordId)).toEqual(["deal-3", "lead-2"]);
  });

  it("rejects a director who lacks access to the requested office", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ id: "office-1", name: "Office One", slug: "office-one" }],
    });

    const tenantDb = makeTenantDb({ deals: officeDealRows, leads: officeLeadRows });

    await expect(
      getOfficeOwnershipQueue(
        tenantDb as any,
        "office-2",
        { id: "director-1", role: "director", officeId: "office-1", activeOfficeId: "office-1" } as any
      )
    ).rejects.toThrow(/accessible office/i);
  });

  it("bulk reassigns rows only to active users with access to the row office", async () => {
    const tenantDb = makeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Office Deal",
          assignedRepId: null,
          decisionMakerName: null,
          budgetStatus: null,
          nextStep: null,
          nextStepDueAt: null,
          forecastWindow: null,
          forecastConfidencePercent: null,
          lastActivityAt: null,
          companyId: null,
          propertyId: null,
          ownershipSyncStatus: "conflict",
          unassignedReasonCode: "inactive_owner_match",
        },
      ],
      leads: [
        {
          id: "lead-1",
          name: "Office Lead",
          assignedRepId: null,
          decisionMakerName: null,
          budgetStatus: null,
          nextStep: null,
          nextStepDueAt: null,
          forecastWindow: null,
          forecastConfidencePercent: null,
          lastActivityAt: null,
          companyId: null,
          propertyId: null,
          ownershipSyncStatus: "unmatched",
          unassignedReasonCode: "owner_mapping_failure",
        },
      ],
    });
    updateDealMock.mockResolvedValue({ id: "deal-1" });
    updateLeadMock.mockResolvedValue({ id: "lead-1" });

    const result = await bulkReassignOwnershipQueueRows(
      tenantDb as any,
      { id: "director-1", role: "director", officeId: "office-1", activeOfficeId: "office-1" } as any,
      {
        officeId: "office-2",
        rows: [
          { recordType: "deal", recordId: "deal-1" },
          { recordType: "lead", recordId: "lead-1" },
        ],
        assigneeId: "rep-1",
      }
    );

    expect(result.updated).toBe(2);
    expect(updateDealMock).toHaveBeenCalledWith(
      tenantDb,
      "deal-1",
      { assignedRepId: "rep-1" },
      "director",
      "director-1",
      "office-2"
    );
    expect(updateLeadMock).toHaveBeenCalledWith(
      tenantDb,
      "lead-1",
      { assignedRepId: "rep-1", officeId: "office-2" },
      "director",
      "director-1"
    );
    expect(tenantDb.execute).toHaveBeenCalled();
  });

  it("rejects non-queue rows before reassignment", async () => {
    const tenantDb = makeTenantDb({
      deals: [
        {
          id: "deal-99",
          name: "Clean Deal",
          assignedRepId: "rep-1",
          decisionMakerName: "Taylor",
          budgetStatus: "confirmed",
          nextStep: "Follow up",
          nextStepDueAt: "2026-04-21T12:00:00.000Z",
          forecastWindow: "Q2",
          forecastConfidencePercent: 80,
          lastActivityAt: "2026-04-21T12:00:00.000Z",
          companyId: "company-1",
          propertyId: "property-1",
          ownershipSyncStatus: "matched",
          unassignedReasonCode: null,
        },
      ],
      leads: [],
    });

    await expect(
      bulkReassignOwnershipQueueRows(
        tenantDb as any,
        { id: "director-1", role: "director", officeId: "office-1", activeOfficeId: "office-1" } as any,
        {
          officeId: "office-2",
          rows: [{ recordType: "deal", recordId: "deal-99" }],
          assigneeId: "rep-1",
        }
      )
    ).rejects.toThrow(/Queue row not found/i);
  });

  it("treats zero forecast confidence as present", async () => {
    const tenantDb = makeTenantDb({
      deals: [
        {
          id: "deal-zero",
          name: "Zero Confidence Deal",
          assignedRepId: "rep-1",
          decisionMakerName: "Taylor",
          budgetStatus: null,
          nextStep: "Follow up",
          nextStepDueAt: "2026-04-21T12:00:00.000Z",
          forecastWindow: "Q2",
          forecastConfidencePercent: 0,
          lastActivityAt: "2026-04-21T12:00:00.000Z",
          companyId: "company-1",
          propertyId: "property-1",
          ownershipSyncStatus: "matched",
          unassignedReasonCode: null,
        },
      ],
      leads: [],
    });

    const result = await getMyCleanupQueue(tenantDb as any, "rep-1", "office-1");
    const zeroRow = result.rows.find((row) => row.recordId === "deal-zero");

    expect(zeroRow).toBeDefined();
    expect(zeroRow?.reasonCodes).not.toContain("missing_forecast_confidence");
  });

  it("keeps request IDs out of SQL literals when loading queue rows", async () => {
    const tenantDb = makeTenantDb({ deals: [], leads: [] });
    const maliciousId = "deal-1' OR 1=1 --";

    await expect(
      bulkReassignOwnershipQueueRows(
        tenantDb as any,
        { id: "director-1", role: "director", officeId: "office-1", activeOfficeId: "office-1" } as any,
        {
          officeId: "office-1",
          rows: [{ recordType: "deal", recordId: maliciousId }],
          assigneeId: "rep-1",
        }
      )
    ).rejects.toThrow();

    const sqlLiteralText = tenantDb.execute.mock.calls
      .map(([query]) => extractSqlLiteralText(query))
      .join(" ");

    expect(sqlLiteralText).not.toContain(maliciousId);
  });
});
