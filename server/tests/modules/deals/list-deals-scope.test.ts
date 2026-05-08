import { deals, userOfficeAccess, users } from "@trock-crm/shared/schema";
import { describe, expect, it, vi } from "vitest";
import { getDeals } from "../../../src/modules/deals/service.js";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/types", async () => import("../../../../shared/src/types/index.js"));

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

function applyWhere(rows: Row[], condition: unknown) {
  const chunks = flattenChunks(condition);
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
      { id: "deal-self", assignedRepId: "director-1", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-team-1", assignedRepId: "rep-team-1", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-team-2", assignedRepId: "rep-team-2", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-other-office", assignedRepId: "rep-other-office", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-unassigned", assignedRepId: null, isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-inactive-rep", assignedRepId: "rep-inactive", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
      { id: "deal-rep-self", assignedRepId: "rep-self", isActive: true, updatedAt: new Date("2026-05-07T12:00:00Z") },
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
          return queryBuilder([], fields);
        },
      };
    },
  };
}

async function listIds(input: { role: string; userId: string; scope?: "mine" | "team" | "all" }) {
  const result = await getDeals(
    createTenantDb() as never,
    { isActive: true, scope: input.scope, activeOfficeId: "office-1", limit: 100 } as never,
    input.role,
    input.userId
  );
  return result.deals.map((row) => row.id);
}

describe("getDeals scope filtering", () => {
  it("returns only the director's own deals for scope=mine", async () => {
    await expect(listIds({ role: "director", userId: "director-1", scope: "mine" })).resolves.toEqual([
      "deal-self",
    ]);
  });

  it("returns active direct reports in the active office for scope=team", async () => {
    await expect(listIds({ role: "director", userId: "director-1", scope: "team" })).resolves.toEqual([
      "deal-team-1",
      "deal-team-2",
      "deal-other-office",
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
    ]);
  });

  it("getDeals includes unassigned deals when scope filter is active", async () => {
    await expect(listIds({ role: "director", userId: "director-1", scope: "all" })).resolves.toContain(
      "deal-unassigned"
    );
  });

  it("forces reps to their own deals regardless of requested scope", async () => {
    await expect(listIds({ role: "rep", userId: "rep-self", scope: "all" })).resolves.toEqual([
      "deal-rep-self",
    ]);
  });
});
