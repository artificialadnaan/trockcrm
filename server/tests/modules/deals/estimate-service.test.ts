import { describe, expect, it } from "vitest";
import { createLineItem, updateLineItem } from "../../../src/modules/deals/estimate-service.js";

function createTenantDbMock() {
  const state = {
    insertedValues: undefined as Record<string, unknown> | undefined,
    updatedValues: undefined as Record<string, unknown> | undefined,
  };

  const tenantDb = {
    select(selection?: unknown) {
      return {
        from() {
          const chain = {
            where() {
              return {
                limit: async () => [
                  selection
                    ? {
                        item: {
                          id: "line-1",
                          sectionId: "section-1",
                          description: "Existing",
                          quantity: "2",
                          unitPrice: "10",
                          totalPrice: "20.00",
                          displayOrder: 1,
                        },
                        dealId: "deal-1",
                      }
                    : { id: "section-1", dealId: "deal-1" },
                ],
              };
            },
            innerJoin() {
              return chain;
            },
          };
          return chain;
        },
      };
    },
    insert() {
      return {
        values(values: Record<string, unknown>) {
          state.insertedValues = values;
          return {
            returning: async () => [{ id: "line-1", ...values }],
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          state.updatedValues = values;
          return {
            where() {
              return {
                returning: async () => [{ id: "line-1", ...values }],
              };
            },
          };
        },
      };
    },
  };

  return { tenantDb: tenantDb as any, state };
}

describe("estimate line item alias columns", () => {
  it("syncs alias columns when creating a line item", async () => {
    const { tenantDb, state } = createTenantDbMock();

    await createLineItem(tenantDb, "deal-1", "section-1", {
      description: " Membrane repair ",
      quantity: "3.456",
      unitPrice: "12.50",
      displayOrder: 4,
    });

    expect(state.insertedValues).toMatchObject({
      dealId: "deal-1",
      description: "Membrane repair",
      label: "Membrane repair",
      quantity: "3.456",
      qty: "3.46",
      unitPrice: "12.50",
      rate: "12.50",
      totalPrice: "43.20",
      total: "43.20",
      displayOrder: 4,
      sortOrder: 4,
    });
  });

  it("syncs alias columns when updating quantity and description", async () => {
    const { tenantDb, state } = createTenantDbMock();

    await updateLineItem(tenantDb, "line-1", "deal-1", {
      description: " Revised repair ",
      quantity: "5.555",
    });

    expect(state.updatedValues).toMatchObject({
      dealId: "deal-1",
      description: "Revised repair",
      label: "Revised repair",
      quantity: "5.555",
      qty: "5.56",
      totalPrice: "55.55",
      total: "55.55",
    });
  });

  it("rounds negative half-values away from zero matching Postgres semantics", async () => {
    const cases = [
      ["-1.005", "-1.01"],
      ["-1.004", "-1.00"],
      ["1.005", "1.01"],
      ["1.004", "1.00"],
      ["0", "0.00"],
    ] as const;

    for (const [quantity, expectedQty] of cases) {
      const { tenantDb, state } = createTenantDbMock();

      await createLineItem(tenantDb, "deal-1", "section-1", {
        description: `Quantity ${quantity}`,
        quantity,
        unitPrice: "1",
      });

      expect(state.insertedValues).toMatchObject({ qty: expectedQty });
    }
  });

  it("rounds negative half-values away from zero matching Postgres for known-failing cases", async () => {
    const cases = [
      ["-9.995", "-10.00"],
      ["-1.005", "-1.01"],
      ["-2.665", "-2.67"],
      ["-0.005", "-0.01"],
      ["1.005", "1.01"],
      ["9.995", "10.00"],
    ] as const;

    for (const [quantity, expectedQty] of cases) {
      const { tenantDb, state } = createTenantDbMock();

      await createLineItem(tenantDb, "deal-1", "section-1", {
        description: `Quantity ${quantity}`,
        quantity,
        unitPrice: "1",
      });

      expect(state.insertedValues).toMatchObject({ qty: expectedQty });
    }
  });
});
