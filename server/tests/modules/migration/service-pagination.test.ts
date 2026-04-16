import { describe, expect, it, vi } from "vitest";
import { stagedCompanies } from "@trock-crm/shared/schema";

let lastOffset = -1;
let lastLimit = -1;

vi.mock("../../../src/db.js", () => {
  const db = {
    select: vi.fn(() => {
      const state: { table: unknown } = { table: null };
      return {
        from(table: unknown) {
          state.table = table;
          return this;
        },
        where() {
          return this;
        },
        orderBy() {
          return this;
        },
        limit(limit: number) {
          lastLimit = limit;
          (state as any).hasPagination = true;
          return this;
        },
        offset(offset: number) {
          lastOffset = offset;
          (state as any).hasPagination = true;
          return this;
        },
        then(resolve: (value: unknown) => void) {
          if (state.table === stagedCompanies) {
            if ((state as any).hasPagination) {
              resolve([
                {
                  id: "company-51",
                  validationStatus: "invalid",
                  exceptionBucket: "unknown_company",
                },
              ]);
              return;
            }
            resolve([{ count: 75 }]);
            return;
          }

          resolve([]);
        },
      };
    }),
  };
  return { db };
});

import { listStagedCompanies } from "../../../src/modules/migration/service.js";

describe("migration queue pagination", () => {
  it("pages through invalid company rows beyond the first 50", async () => {
    lastOffset = -1;
    lastLimit = -1;

    const result = await listStagedCompanies({ validationStatus: "unresolved", page: 2, limit: 50 });

    expect(lastLimit).toBe(50);
    expect(lastOffset).toBe(50);
    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(75);
    expect(result.rows[0]).toMatchObject({
      id: "company-51",
      validationStatus: "invalid",
    });
  });
});
