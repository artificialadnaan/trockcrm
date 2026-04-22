import { describe, expect, it } from "vitest";
import { normalizeCatalogItem } from "../../../src/modules/procore/catalog-sync-service.js";

describe("normalizeCatalogItem", () => {
  it("maps Procore item payload fields into the local catalog shape", () => {
    const result = normalizeCatalogItem({
      id: "item-1",
      name: "Parapet Wall Flashing",
      unit_of_measure: "ft",
      unit_cost: 45,
      item_type: "Labor",
      cost_code: { code: "07-100", name: "Damproofing and Waterproofing" },
    } as any);

    expect(result.item.externalId).toBe("item-1");
    expect(result.item.unit).toBe("ft");
    expect(result.price.blendedUnitCost).toBe("45");
    expect(result.code?.code).toBe("07-100");
  });
});
