import { leads, users } from "@trock-crm/shared/schema";
import { describe, expect, it, vi } from "vitest";
import { createLeadService } from "../../../src/modules/leads/service.js";

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
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk || typeof chunk !== "object" || typeof (chunk as { name?: unknown }).name !== "string") {
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
  return {
    where(condition: unknown) {
      filtered = applyWhere(filtered, condition);
      return this;
    },
    orderBy() {
      return this;
    },
    then(onfulfilled: (value: Row[]) => unknown) {
      return Promise.resolve(projectRows(filtered, fields)).then(onfulfilled);
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
    leads: [
      { id: "lead-self", assignedRepId: "director-1", isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
      { id: "lead-team-1", assignedRepId: "rep-team-1", isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
      { id: "lead-team-2", assignedRepId: "rep-team-2", isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
      { id: "lead-other-office", assignedRepId: "rep-other-office", isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
      { id: "lead-inactive-rep", assignedRepId: "rep-inactive", isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
      { id: "lead-rep-self", assignedRepId: "rep-self", isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
    ],
    deals: [],
  };

  return {
    select(fields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          if (table === leads) return queryBuilder(state.leads, fields);
          if (table === users) return queryBuilder(state.users, fields);
          return queryBuilder([], fields);
        },
      };
    },
  };
}

async function listIds(input: { role: string; userId: string; scope?: "mine" | "team" | "all" }) {
  const service = createLeadService();
  const rows = await service.listLeads(
    createTenantDb() as never,
    { isActive: "all", scope: input.scope, activeOfficeId: "office-1" },
    input.role,
    input.userId
  );
  return rows.map((row) => row.id);
}

describe("listLeads scope filtering", () => {
  it("returns only the director's own leads for scope=mine", async () => {
    await expect(listIds({ role: "director", userId: "director-1", scope: "mine" })).resolves.toEqual([
      "lead-self",
    ]);
  });

  it("returns active direct reports in the active office for scope=team", async () => {
    await expect(listIds({ role: "director", userId: "director-1", scope: "team" })).resolves.toEqual([
      "lead-team-1",
      "lead-team-2",
    ]);
  });

  it("returns all active-office tenant leads for scope=all", async () => {
    await expect(listIds({ role: "director", userId: "director-1", scope: "all" })).resolves.toEqual([
      "lead-self",
      "lead-team-1",
      "lead-team-2",
      "lead-other-office",
      "lead-inactive-rep",
      "lead-rep-self",
    ]);
  });

  it("forces reps to their own leads regardless of requested scope", async () => {
    await expect(listIds({ role: "rep", userId: "rep-self", scope: "all" })).resolves.toEqual([
      "lead-rep-self",
    ]);
  });
});
