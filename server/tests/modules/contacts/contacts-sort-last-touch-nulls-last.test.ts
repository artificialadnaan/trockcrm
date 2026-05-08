import { describe, expect, it, vi } from "vitest";
import { buildContactSortOrder } from "../../../src/modules/contacts/service.js";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));

function flattenSqlChunks(value: unknown): string {
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.map((chunk) => {
    if (typeof chunk === "string") return chunk;
    if (chunk && typeof chunk === "object" && "value" in chunk) {
      return String((chunk as { value: unknown }).value);
    }
    if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
      return flattenSqlChunks(chunk);
    }
    return String(chunk);
  }).join(" ");
}

describe("contacts last_touch_at null sorting", () => {
  it("places untouched contacts after touched contacts on descending last_touch_at sort", () => {
    const sortSql = flattenSqlChunks(buildContactSortOrder("last_touch_at", "desc"));

    expect(sortSql).toContain("GREATEST");
    expect(sortSql).toContain("DESC NULLS LAST");
  });
});
