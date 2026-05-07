import { desc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  buildContactLastTouchAtSql,
  buildContactSortOrder,
} from "../../../src/modules/contacts/service.js";

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
    expect(buildContactSortOrder("last_touch_at", "desc")).toEqual(desc(buildContactLastTouchAtSql()));
  });

  it("includes email touches in the last_touch_at ordering expression", () => {
    const sortSql = flattenSqlChunks(buildContactSortOrder("last_touch_at", "desc"));

    expect(sortSql).toContain("emails");
    expect(sortSql).toContain("sent_at");
    expect(sortSql).toContain("GREATEST");
  });
});
