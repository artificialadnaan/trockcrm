import { leads, userOfficeAccess, users } from "@trock-crm/shared/schema";
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

function applyWhere(rows: Row[], condition: unknown) {
  const chunks = flattenChunks(condition);
  const conditionText = flattenText(condition).toLowerCase();
  const hasExpandedMinePredicate =
    conditionText.includes("created_by_user_id") &&
    conditionText.includes("performed_by_user_id") &&
    conditionText.includes("ls.user_id");
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
      { id: "lead-self", assignedRepId: "director-1", createdByUserId: "director-1", isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
      { id: "lead-team-1", assignedRepId: "rep-team-1", createdByUserId: "rep-team-1", isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
      { id: "lead-team-2", assignedRepId: "rep-team-2", createdByUserId: "rep-team-2", isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
      { id: "lead-other-office", assignedRepId: "rep-other-office", createdByUserId: "rep-other-office", isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
      { id: "lead-inactive-rep", assignedRepId: "rep-inactive", createdByUserId: "rep-inactive", isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
      { id: "lead-rep-self", assignedRepId: "rep-self", createdByUserId: "rep-self", isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
      { id: "lead-created", assignedRepId: "rep-team-1", createdByUserId: "director-1", isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
      { id: "lead-activity", assignedRepId: "rep-team-2", createdByUserId: "rep-team-2", activityPerformedByUserIds: ["director-1"], isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
      { id: "lead-subscribed", assignedRepId: "rep-team-2", createdByUserId: "rep-team-2", subscriberUserIds: ["director-1"], isActive: true, status: "open", companyId: null, propertyId: null, projectTypeId: null },
    ],
    userOfficeAccess: [
      { userId: "rep-other-office", officeId: "office-1" },
    ],
    deals: [],
  };

  return {
    select(fields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          if (table === leads) return queryBuilder(state.leads, fields);
          if (table === users) return queryBuilder(state.users, fields);
          if (table === userOfficeAccess) return queryBuilder(state.userOfficeAccess, fields);
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
      "lead-created",
      "lead-activity",
      "lead-subscribed",
    ]);
  });

  it("returns active direct reports in the active office for scope=team", async () => {
    await expect(listIds({ role: "director", userId: "director-1", scope: "team" })).resolves.toEqual([
      "lead-team-1",
      "lead-team-2",
      "lead-other-office",
      "lead-created",
      "lead-activity",
      "lead-subscribed",
    ]);
  });

  it("scope=all returns only leads from the active office", async () => {
    await expect(listIds({ role: "director", userId: "director-1", scope: "all" })).resolves.toEqual([
      "lead-self",
      "lead-team-1",
      "lead-team-2",
      "lead-other-office",
      "lead-inactive-rep",
      "lead-rep-self",
      "lead-created",
      "lead-activity",
      "lead-subscribed",
    ]);
  });

  it("narrows team scope to a specific assigned rep when both filters are set", async () => {
    const service = createLeadService();
    const rows = await service.listLeads(
      createTenantDb() as never,
      { isActive: "all", scope: "team", activeOfficeId: "office-1", assignedRepId: "rep-team-1" },
      "director",
      "director-1"
    );

    expect(rows.map((row) => row.id)).toEqual(["lead-team-1", "lead-created"]);
  });

  it("allows reps to request all-office scope explicitly", async () => {
    await expect(listIds({ role: "rep", userId: "rep-self", scope: "all" })).resolves.toEqual([
      "lead-self",
      "lead-team-1",
      "lead-team-2",
      "lead-other-office",
      "lead-inactive-rep",
      "lead-rep-self",
      "lead-created",
      "lead-activity",
      "lead-subscribed",
    ]);
  });
});
