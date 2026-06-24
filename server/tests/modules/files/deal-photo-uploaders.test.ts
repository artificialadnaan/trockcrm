import { describe, expect, it } from "vitest";
import { getDealPhotoUploaders } from "../../../src/modules/files/service.js";

// Minimal tenantDb stub: the deal-scope lookup (select→from→where→limit) returns no source lead, and the
// uploader query (selectDistinct→from→leftJoin→where) yields a fixed row set we control.
function tenantDb(rows: Array<{ id: string | null; name: string; avatarUrl: string | null }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ sourceLeadId: null }],
        }),
      }),
    }),
    selectDistinct: () => ({
      from: () => ({
        leftJoin: () => ({
          where: async () => rows,
        }),
      }),
    }),
  };
}

describe("getDealPhotoUploaders", () => {
  it("drops uploaders with no id and sorts the rest by name", async () => {
    const db = tenantDb([
      { id: "u-2", name: "Zoe", avatarUrl: null },
      { id: null, name: "Unknown", avatarUrl: null },
      { id: "u-1", name: "Adam", avatarUrl: "a.png" },
    ]);

    const result = await getDealPhotoUploaders(db as any, "deal-1");

    expect(result).toEqual([
      { id: "u-1", name: "Adam", avatarUrl: "a.png" },
      { id: "u-2", name: "Zoe", avatarUrl: null },
    ]);
  });
});
