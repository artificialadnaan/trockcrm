import { describe, expect, it } from "vitest";
import { leadQualification } from "@trock-crm/shared/schema";

async function loadQualificationServiceModule() {
  try {
    return await import("../../../src/modules/leads/qualification-service.js");
  } catch {
    return null;
  }
}

function createFakeTenantDb(initial?: {
  leadQualification?: Array<Record<string, unknown>>;
}) {
  const state = {
    leadQualification: initial?.leadQualification ?? [],
  };

  return {
    select() {
      return {
        from(table: unknown) {
          if (table !== leadQualification) {
            throw new Error("Unexpected table");
          }
          return {
            where() {
              return {
                limit(limit: number) {
                  return Promise.resolve(state.leadQualification.slice(0, limit));
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      if (table !== leadQualification) {
        throw new Error("Unexpected table");
      }
      return {
        values(value: Record<string, unknown>) {
          const row = {
            id: value.id ?? `qualification-${state.leadQualification.length + 1}`,
            ...value,
          };
          state.leadQualification.push(row);
          return {
            returning() {
              return Promise.resolve([row]);
            },
          };
        },
      };
    },
    update(table: unknown) {
      if (table !== leadQualification) {
        throw new Error("Unexpected table");
      }
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              state.leadQualification.forEach((row) => Object.assign(row, values));
              return {
                returning() {
                  return Promise.resolve(state.leadQualification);
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("lead qualification numeric validation", () => {
  it("normalizes formatted currency input before writing the estimated opportunity value", async () => {
    const mod = await loadQualificationServiceModule();

    expect(mod).not.toBeNull();

    const tenantDb = createFakeTenantDb();
    const result = await mod!.upsertLeadQualification(tenantDb as never, "lead-1", {
      estimatedOpportunityValue: "$42,500",
    });

    expect(result?.estimatedOpportunityValue).toBe("42500.00");
  });

  it("rejects invalid estimated opportunity values with a controlled validation error", async () => {
    const mod = await loadQualificationServiceModule();

    expect(mod).not.toBeNull();

    const tenantDb = createFakeTenantDb();

    await expect(
      mod!.upsertLeadQualification(tenantDb as never, "lead-1", {
        estimatedOpportunityValue: "r234",
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Estimated opportunity value must be a valid number",
    });
  });
});
