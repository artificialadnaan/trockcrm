import { describe, expect, it, vi } from "vitest";
import { listCatalogCandidatesForMatching } from "../../../src/modules/estimating/catalog-read-model-service.js";

describe("listCatalogCandidatesForMatching", () => {
  it("keeps catalog items without a primary code in the candidate set", async () => {
    const where = vi.fn().mockResolvedValue([
      {
        id: "item-1",
        name: "Mobilization",
        unit: "ea",
        primaryCode: null,
        catalogBaselinePrice: "500.00",
      },
    ]);

    const appDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            leftJoin: vi.fn(() => ({
              leftJoin: vi.fn(() => ({
                where,
              })),
            })),
          })),
        })),
      })),
    } as any;

    const rows = await listCatalogCandidatesForMatching(appDb, "source-1", "snapshot-1");

    expect(where).toHaveBeenCalled();
    expect(rows[0]?.primaryCode).toBeNull();
  });
});
