import { describe, expect, it, vi } from "vitest";
import { stagedLeads } from "@trock-crm/shared/schema";

const updateCalls: Array<Record<string, unknown>> = [];
let batchFetchCount = 0;

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
        limit() {
          return this;
        },
        then(resolve: (value: unknown) => void) {
          if (state.table === stagedLeads) {
            batchFetchCount++;
            resolve(
              batchFetchCount === 1
                ? [
                    {
                      id: "lead-1",
                      hubspotLeadId: "hs-lead-1",
                      mappedName: "Lead Alpha",
                      mappedCompanyName: "Alpha Roofing",
                      mappedPropertyName: "123 Main",
                      mappedDealName: "Lead Alpha",
                      candidateDealCount: 2,
                      candidatePropertyCount: 1,
                      mappedOwnerEmail: "rep@trock.com",
                      validationStatus: "pending",
                      validationErrors: [],
                      validationWarnings: [],
                      exceptionBucket: null,
                      exceptionReason: null,
                      reviewNotes: null,
                      promotedAt: null,
                    },
                  ]
                : []
            );
            return;
          }

          resolve([]);
        },
      };
    }),
    update: vi.fn(() => {
      let payload: Record<string, unknown> | null = null;
      return {
        set(next: Record<string, unknown>) {
          payload = next;
          return this;
        },
        where() {
          if (payload) updateCalls.push(payload);
          return this;
        },
      };
    }),
  };
  return { db };
});

import { validateStagedLeads } from "../../../src/modules/migration/validator.js";

describe("validateStagedLeads", () => {
  it("persists ambiguous deal association so approval is blocked later", async () => {
    updateCalls.length = 0;
    batchFetchCount = 0;

    const result = await validateStagedLeads();

    expect(result.exceptions.ambiguous_deal_association).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({
      validationStatus: "needs_review",
      exceptionBucket: "ambiguous_deal_association",
    });
  });
});
