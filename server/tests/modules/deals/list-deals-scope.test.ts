import { companies, deals, offices, userOfficeAccess, users } from "@trock-crm/shared/schema";
import { describe, expect, it, vi } from "vitest";
import { getDeals } from "../../../src/modules/deals/service.js";

const dbState = vi.hoisted(() => ({
  stages: [
    { id: "stage-estimating", slug: "estimating", name: "Estimating", displayOrder: 1, isTerminal: false, isActivePipeline: true },
    { id: "stage-won", slug: "won", name: "Won", displayOrder: 7, isTerminal: true, isActivePipeline: true },
    { id: "stage-lost", slug: "lost", name: "Lost", displayOrder: 8, isTerminal: true, isActivePipeline: true },
  ],
}));

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/types", async () => import("../../../../shared/src/types/index.js"));
vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn(() => {
      let sourceTable: unknown = null;
      const builder = {
        from: vi.fn((table: unknown) => {
          sourceTable = table;
          return builder;
        }),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: vi.fn((resolve: (value: unknown[]) => unknown) => {
          if (sourceTable === offices) {
            return resolve([{ slug: "dallas", name: "Dallas" }]);
          }
          return resolve(dbState.stages);
        }),
      };
      return builder;
    }),
  },
  pool: {},
}));

type Row = Record<string, unknown>;

function camelName(name: string) {
  return name.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function flattenChunks(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flattenChunks);
  if (value && typeof value === "object" && Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.flatMap(flattenChunks);
  }
  return [value];
}

function extractValues(chunk: unknown): unknown[] {
  if (Array.isArray(chunk)) {
    return chunk
      .filter((item): item is { value: unknown } => Boolean(item) && typeof item === "object" && "value" in item)
      .map((item) => item.value);
  }
  if (chunk && typeof chunk === "object" && "value" in chunk) {
    return [(chunk as { value: unknown }).value];
  }
  return [];
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(flattenText).join("");
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(flattenText).join("");
  }
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return String((value as { name: string }).name);
  }
  if ("value" in (value as Record<string, unknown>)) {
    return flattenText((value as { value: unknown }).value);
  }
  return Object.values(value as Record<string, unknown>).map(flattenText).join("");
}

function collectScalarValues(value: unknown, into: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) collectScalarValues(item, into);
    return into;
  }
  if (!value || typeof value !== "object") {
    into.push(value);
    return into;
  }
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    for (const item of (value as { queryChunks: unknown[] }).queryChunks) collectScalarValues(item, into);
    return into;
  }
  if ("value" in (value as Record<string, unknown>)) {
    collectScalarValues((value as { value: unknown }).value, into);
  }
  return into;
}

function extractValuesUntilNextColumn(chunks: unknown[], startIndex: number) {
  const values: unknown[] = [];
  for (let index = startIndex; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk && typeof chunk === "object" && typeof (chunk as { name?: unknown }).name === "string") {
      break;
    }
    values.push(...extractValues(chunk));
  }
  return values;
}

function containsValue(value: unknown, expected: string, seen = new Set<unknown>()): boolean {
  if (value === expected) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsValue(item, expected, seen));
  return Object.values(value as Record<string, unknown>).some((item) => containsValue(item, expected, seen));
}

function applyWhere(rows: Row[], condition: unknown) {
  const chunks = flattenChunks(condition);
  const conditionText = flattenText(condition).toLowerCase();
  const hasExpandedMinePredicate =
    conditionText.includes("created_by_user_id") &&
    conditionText.includes("performed_by_user_id") &&
    conditionText.includes("ds.user_id");
  const candidateUserIds = new Set(
    rows.flatMap((row) => [
      row.assignedRepId,
      row.createdByUserId,
      ...(Array.isArray(row.activityPerformedByUserIds) ? row.activityPerformedByUserIds : []),
      ...(Array.isArray(row.subscriberUserIds) ? row.subscriberUserIds : []),
    ]).filter((value): value is string => typeof value === "string")
  );
  const mineScopeUserId = collectScalarValues(condition).find(
    (value): value is string => typeof value === "string" && candidateUserIds.has(value)
  );
  if (hasExpandedMinePredicate && typeof mineScopeUserId === "string") {
    return rows.filter((row) => {
      const activityUsers = Array.isArray(row.activityPerformedByUserIds) ? row.activityPerformedByUserIds : [];
      const subscriberUsers = Array.isArray(row.subscriberUserIds) ? row.subscriberUserIds : [];
      return (
        row.assignedRepId === mineScopeUserId ||
        row.createdByUserId === mineScopeUserId ||
        activityUsers.includes(mineScopeUserId) ||
        subscriberUsers.includes(mineScopeUserId)
      );
    });
  }

  if (
    chunks.some(
      (chunk) =>
        Boolean(chunk) &&
        typeof chunk === "object" &&
        Array.isArray((chunk as { value?: unknown }).value) &&
        (chunk as { value: unknown[] }).value.includes("false")
    )
  ) {
    return [];
  }

  let filtered = rows;
  const hasAssignedRepNullPredicate = chunks.some(
    (chunk) =>
      Boolean(chunk) &&
      typeof chunk === "object" &&
      Array.isArray((chunk as { value?: unknown }).value) &&
      (chunk as { value: unknown[] }).value.includes(" is null")
  );
  const assignedRepOrValues = new Set<unknown>();
  if (hasAssignedRepNullPredicate) {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk || typeof chunk !== "object" || (chunk as { name?: unknown }).name !== "assigned_rep_id") {
        continue;
      }
      for (const value of extractValuesUntilNextColumn(chunks, index + 1)) {
        assignedRepOrValues.add(value);
      }
      break;
    }
    filtered = filtered.filter((row) => assignedRepOrValues.has(row.assignedRepId) || row.assignedRepId == null);
  }

  let assignedRepColumnCount = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk || typeof chunk !== "object" || typeof (chunk as { name?: unknown }).name !== "string") {
      continue;
    }

    if ((chunk as { name: string }).name === "assigned_rep_id") {
      assignedRepColumnCount += 1;
    }

    if (hasAssignedRepNullPredicate && (chunk as { name: string }).name === "assigned_rep_id" && assignedRepColumnCount <= 2) {
      continue;
    }

    const values = extractValuesUntilNextColumn(chunks, index + 1);
    if (values.length === 0) continue;

    const property = camelName((chunk as { name: string }).name);
    filtered = filtered.filter((row) => values.includes(row[property]));
  }

  return filtered;
}

function projectRows(rows: Row[], fields?: Record<string, unknown>) {
  if (!fields) return rows.map((row) => ({ ...row }));
  if ("count" in fields) return [{ count: rows.length }];
  return rows.map((row) => {
    const projected: Row = {};
    for (const [key, field] of Object.entries(fields)) {
      const name = (field as { name?: string }).name;
      if (key === "companyName") {
        projected[key] = row.companyName;
        continue;
      }
      if (name) projected[key] = row[camelName(name)];
    }
    return projected;
  });
}

function queryBuilder(rows: Row[], fields?: Record<string, unknown>) {
  let filtered = rows;
  let offsetCount = 0;
  let limitCount: number | null = null;
  const materialize = () => {
    const limited = filtered.slice(offsetCount, limitCount == null ? undefined : offsetCount + limitCount);
    return projectRows(limited, fields);
  };

  return {
    where(condition: unknown) {
      filtered = applyWhere(filtered, condition);
      return this;
    },
    leftJoin() {
      return this;
    },
    orderBy() {
      return this;
    },
    limit(limit: number) {
      limitCount = limit;
      return this;
    },
    offset(offset: number) {
      offsetCount = offset;
      return this;
    },
    then(onfulfilled: (value: Row[]) => unknown) {
      return Promise.resolve(materialize()).then(onfulfilled);
    },
  };
}

function createTenantDb() {
  const state = {
    users: [
      { id: "director-1", reportsTo: null, officeId: "office-1", isActive: true },
      { id: "rep-self", reportsTo: "director-2", officeId: "office-1", isActive: true },
      { id: "rep-team-1", reportsTo: "director-1", officeId: "office-1", isActive: true },
      { id: "rep-team-2", reportsTo: "director-1", officeId: "office-1", isActive: true },
      { id: "rep-other-office", reportsTo: "director-1", officeId: "office-2", isActive: true },
      { id: "rep-inactive", reportsTo: "director-1", officeId: "office-1", isActive: false },
    ],
    deals: [
      { id: "deal-self", assignedRepId: "director-1", createdByUserId: "director-1", officeCode: "dfw", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-team-1", assignedRepId: "rep-team-1", createdByUserId: "rep-team-1", officeCode: "dfw", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-team-2", assignedRepId: "rep-team-2", createdByUserId: "rep-team-2", officeCode: "dfw", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-other-office", assignedRepId: "rep-other-office", createdByUserId: "rep-other-office", officeCode: "dfw", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-unassigned", assignedRepId: null, createdByUserId: "director-1", officeCode: "dfw", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-inactive-rep", assignedRepId: "rep-inactive", createdByUserId: "rep-inactive", officeCode: "dfw", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-rep-self", assignedRepId: "rep-self", createdByUserId: "rep-self", officeCode: "dfw", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-created", assignedRepId: "rep-team-1", createdByUserId: "director-1", officeCode: "dfw", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-activity", assignedRepId: "rep-team-2", createdByUserId: "rep-team-2", officeCode: "dfw", activityPerformedByUserIds: ["director-1"], isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-subscribed", assignedRepId: "rep-team-2", createdByUserId: "rep-team-2", officeCode: "dfw", subscriberUserIds: ["director-1"], isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-legacy-office-fallback", assignedRepId: "rep-team-1", createdByUserId: "rep-team-1", officeCode: null, isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      {
        id: "deal-company",
        assignedRepId: "rep-team-1",
        createdByUserId: "rep-team-1",
        officeCode: "dfw",
        companyId: "company-1",
        companyName: "Acme Apartments",
        isActive: true,
        updatedAt: new Date("2026-05-07T12:00:00Z"),
      },
    ],
    userOfficeAccess: [
      { userId: "rep-other-office", officeId: "office-1" },
    ],
  };

  return {
    select(fields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          if (table === deals) return queryBuilder(state.deals, fields);
          if (table === users) return queryBuilder(state.users, fields);
          if (table === userOfficeAccess) return queryBuilder(state.userOfficeAccess, fields);
          if (table === companies) return queryBuilder([], fields);
          return queryBuilder([], fields);
        },
      };
    },
  };
}

async function listIds(input: { role: string; userId: string; scope?: "mine" | "team" | "all"; activeOfficeId?: string }) {
  const result = await getDeals(
    createTenantDb() as never,
    { isActive: true, scope: input.scope, activeOfficeId: input.activeOfficeId ?? "office-1", limit: 100 } as never,
    input.role,
    input.userId
  );
  return result.deals.map((row) => row.id);
}

describe("getDeals scope filtering", () => {
  it("returns only the director's own deals for scope=mine", async () => {
    await expect(listIds({ role: "director", userId: "director-1", scope: "mine" })).resolves.toEqual([
      "deal-self",
      "deal-unassigned",
      "deal-created",
      "deal-activity",
      "deal-subscribed",
    ]);
  });

  it("returns active direct reports in the active office for scope=team", async () => {
    await expect(listIds({ role: "director", userId: "director-1", scope: "team" })).resolves.toEqual([
      "deal-team-1",
      "deal-team-2",
      "deal-other-office",
      "deal-created",
      "deal-activity",
      "deal-subscribed",
      "deal-legacy-office-fallback",
      "deal-company",
    ]);
  });

  it("scope=all returns only deals from the active office", async () => {
    await expect(listIds({ role: "director", userId: "director-1", scope: "all" })).resolves.toEqual([
      "deal-self",
      "deal-team-1",
      "deal-team-2",
      "deal-other-office",
      "deal-unassigned",
      "deal-inactive-rep",
      "deal-rep-self",
      "deal-created",
      "deal-activity",
      "deal-subscribed",
      "deal-legacy-office-fallback",
      "deal-company",
    ]);
  });

  it("getDeals includes unassigned deals when scope filter is active", async () => {
    await expect(listIds({ role: "director", userId: "director-1", scope: "all" })).resolves.toContain(
      "deal-unassigned"
    );
  });

  it("getDeals returns no deals when active office has no users", async () => {
    await expect(
      listIds({ role: "director", userId: "director-1", scope: "all", activeOfficeId: "office-empty" })
    ).resolves.toEqual([]);
  });

  it("allows reps to request all-office scope explicitly", async () => {
    await expect(listIds({ role: "rep", userId: "rep-self", scope: "all" })).resolves.toEqual([
      "deal-self",
      "deal-team-1",
      "deal-team-2",
      "deal-other-office",
      "deal-unassigned",
      "deal-inactive-rep",
      "deal-rep-self",
      "deal-created",
      "deal-activity",
      "deal-subscribed",
      "deal-legacy-office-fallback",
      "deal-company",
    ]);
  });

  it("getDeals returns companyName for linked companies", async () => {
    const result = await getDeals(
      createTenantDb() as never,
      { isActive: true, scope: "all", activeOfficeId: "office-1", limit: 100 } as never,
      "director",
      "director-1"
    );

    expect(result.deals.find((row) => row.id === "deal-company")).toMatchObject({
      companyName: "Acme Apartments",
    });
  });

  it("getDeals pipeline visibility keeps inactive rows limited to explicit terminal stages", async () => {
    const capturedWheres: unknown[] = [];
    const dataChain: any = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn((condition: unknown) => {
        capturedWheres.push(condition);
        return dataChain;
      }),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockResolvedValue([]),
      then: vi.fn((resolve: (value: Row[]) => unknown) => resolve([{ count: 0 }])),
    };
    const tenantDb = {
      select: vi.fn(() => dataChain),
    } as any;

    await getDeals(
      tenantDb,
      {
        isActive: "pipeline",
        inactiveStageIds: ["stage-won"],
        scope: "all",
        activeOfficeId: "office-1",
        limit: 100,
      } as never,
      "director",
      "director-1"
    );

    expect(capturedWheres.some((condition) => containsValue(condition, "stage-won"))).toBe(true);
    expect(capturedWheres.some((condition) => containsValue(condition, "stage-estimating"))).toBe(false);
  });

  it("getDeals pipeline visibility drops client-supplied non-terminal inactiveStageIds", async () => {
    const capturedWheres: unknown[] = [];
    const dataChain: any = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn((condition: unknown) => {
        capturedWheres.push(condition);
        return dataChain;
      }),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockResolvedValue([]),
      then: vi.fn((resolve: (value: Row[]) => unknown) => resolve([{ count: 0 }])),
    };
    const tenantDb = {
      select: vi.fn(() => dataChain),
    } as any;

    await getDeals(
      tenantDb,
      {
        isActive: "pipeline",
        inactiveStageIds: ["stage-estimating", "stage-won"],
        scope: "all",
        activeOfficeId: "office-1",
        limit: 100,
      } as never,
      "director",
      "director-1"
    );

    expect(capturedWheres.some((condition) => containsValue(condition, "stage-won"))).toBe(true);
    expect(capturedWheres.some((condition) => containsValue(condition, "stage-estimating"))).toBe(false);
  });
});
