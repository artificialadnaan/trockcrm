import { userOfficeAccess, users } from "@trock-crm/shared/schema";
import { describe, expect, it, vi } from "vitest";
import { resolveTeamRepIds } from "../../../src/modules/shared/team-scope.js";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));

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
    then(onfulfilled: (value: Row[]) => unknown) {
      return Promise.resolve(projectRows(filtered, fields)).then(onfulfilled);
    },
  };
}

function createTenantDb() {
  const state = {
    users: [
      { id: "rep-primary", reportsTo: "director-1", officeId: "office-dfw", isActive: true },
      { id: "rep-access", reportsTo: "director-1", officeId: "office-atl", isActive: true },
      { id: "rep-other-office", reportsTo: "director-1", officeId: "office-atl", isActive: true },
      { id: "rep-inactive", reportsTo: "director-1", officeId: "office-atl", isActive: false },
    ],
    userOfficeAccess: [
      { userId: "rep-access", officeId: "office-dfw" },
      { userId: "rep-inactive", officeId: "office-dfw" },
    ],
  };

  return {
    select(fields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          if (table === users) return queryBuilder(state.users, fields);
          if (table === userOfficeAccess) return queryBuilder(state.userOfficeAccess, fields);
          return queryBuilder([], fields);
        },
      };
    },
  };
}

describe("resolveTeamRepIds", () => {
  it("resolveTeamRepIds includes direct reports with office access overrides", async () => {
    await expect(resolveTeamRepIds(createTenantDb() as never, "director-1", "office-dfw")).resolves.toEqual([
      "rep-primary",
      "rep-access",
    ]);
  });
});
