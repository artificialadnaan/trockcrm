import { describe, expect, it, vi } from "vitest";
import {
  buildContactSortOrder,
} from "../../../src/modules/contacts/service.js";

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

describe("contacts last_touch_at sorting", () => {
  it("orders by the same derived expression returned as lastTouchAt", () => {
    const sortSql = flattenSqlChunks(buildContactSortOrder("last_touch_at", "desc"));

    expect(sortSql).toContain("GREATEST");
    expect(sortSql).toContain("DESC NULLS LAST");
  });

  it("includes email touches in the last_touch_at ordering expression", () => {
    const sortSql = flattenSqlChunks(buildContactSortOrder("last_touch_at", "desc"));

    expect(sortSql).toContain("emails");
    expect(sortSql).toContain("sent_at");
    expect(sortSql).toContain("GREATEST");
  });
});
