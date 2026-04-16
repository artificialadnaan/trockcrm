import { describe, expect, it, vi } from "vitest";
import { stagedActivities, stagedDeals, stagedLeads, stagedContacts } from "@trock-crm/shared/schema";

const updateCalls: Array<Record<string, unknown>> = [];
let activityFetchCount = 0;
let activityScenario: "multi-linked" | "raw-associations" = "multi-linked";

vi.mock("../../../src/db.js", () => {
  const db = {
    select: vi.fn((columns?: Record<string, unknown>) => {
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
          if (state.table === stagedDeals && columns && "id" in columns) {
            resolve([{ id: "deal-hs-1" }]);
            return;
          }

          if (state.table === stagedLeads && columns && "id" in columns) {
            resolve([{ id: "lead-hs-1" }]);
            return;
          }

          if (state.table === stagedContacts && columns && "id" in columns) {
            resolve([{ id: "contact-hs-1" }]);
            return;
          }

          if (state.table === stagedActivities) {
            activityFetchCount++;
            if (activityFetchCount > 1) {
              resolve([]);
              return;
            }

            resolve(
              activityScenario === "multi-linked"
                ? [
                    {
                      id: "activity-1",
                      hubspotActivityId: "hs-act-1",
                      hubspotDealId: "deal-hs-1",
                      hubspotDealIds: ["deal-hs-1", "deal-hs-2"],
                      hubspotContactId: "contact-hs-1",
                      hubspotContactIds: ["contact-hs-1"],
                      rawData: {
                        associations: {
                          deals: { results: [{ id: "deal-hs-1" }, { id: "deal-hs-2" }] },
                          contacts: { results: [{ id: "contact-hs-1" }] },
                        },
                      },
                      mappedType: "email",
                      validationStatus: "pending",
                      validationErrors: [],
                    },
                  ]
                : [
                    {
                      id: "activity-2",
                      hubspotActivityId: "hs-act-2",
                      hubspotDealId: "deal-hs-1",
                      hubspotDealIds: [],
                      hubspotContactId: "contact-hs-1",
                      hubspotContactIds: [],
                      rawData: {
                        associations: {
                          deals: { results: [{ id: "deal-hs-1" }, { id: "deal-hs-2" }] },
                          contacts: { results: [{ id: "contact-hs-1" }] },
                        },
                      },
                      mappedType: "email",
                      validationStatus: "pending",
                      validationErrors: [],
                    },
                  ]
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

import { validateStagedActivities } from "../../../src/modules/migration/validator.js";

describe("validateStagedActivities", () => {
  it("marks multi-linked activities as invalid so exception handling can review them", async () => {
    updateCalls.length = 0;
    activityFetchCount = 0;
    activityScenario = "multi-linked";

    const result = await validateStagedActivities();

    expect(result.invalid).toBe(1);
    expect(result.exceptions.ambiguous_email_activity_attribution).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({
      validationStatus: "invalid",
      validationErrors: [
        {
          field: "associations",
          error: "Activity matches more than one deal/contact target",
        },
      ],
    });
  });

  it("preserves raw HubSpot associations even when staged ids only include the primary link", async () => {
    updateCalls.length = 0;
    activityFetchCount = 0;
    activityScenario = "raw-associations";

    const result = await validateStagedActivities();

    expect(result.invalid).toBe(1);
    expect(result.exceptions.ambiguous_email_activity_attribution).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({
      validationStatus: "invalid",
      validationErrors: [
        {
          field: "associations",
          error: "Activity matches more than one deal/contact target",
        },
      ],
    });
  });
});
