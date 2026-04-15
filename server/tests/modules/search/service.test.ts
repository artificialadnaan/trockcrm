import { describe, expect, it, vi } from "vitest";

const { naturalLanguageSearch } = await import("../../../src/modules/search/service.js");

describe("search service", () => {
  it("boosts AI search artifacts using historical interaction data", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "deal-1",
            deal_number: "D-1001",
            name: "Alpha Plaza",
            property_city: "Dallas",
            property_state: "TX",
            rank: 0.9,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: "chunk-1",
            source_type: "email_message",
            source_id: "email-1",
            deal_id: "deal-1",
            text: "Customer asked for a revision on Alpha Plaza.",
            metadata_json: { subject: "Revision request" },
            rank: 0.8,
          },
        ],
      });

    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([
          {
            feedbackValue: "recommended_action_executed",
            comment: JSON.stringify({
              targetValue: "refresh_deal_copilot",
              deepLink: "/deals/deal-1?tab=overview&focus=copilot",
              executionMode: "api_then_navigate",
              apiEndpoint: "/ai/deals/deal-1/regenerate",
            }),
          },
          {
            feedbackValue: "recommended_action_click",
            comment: JSON.stringify({
              targetValue: "review_deal_emails",
              deepLink: "/deals/deal-1?tab=email",
            }),
          },
          {
            feedbackValue: "top_entity_click",
            comment: JSON.stringify({
              targetValue: "deal:deal-1",
              deepLink: "/deals/deal-1",
            }),
          },
        ]),
      })),
    }));

    const tenantDb = {
      execute,
      select,
    };

    const result = await naturalLanguageSearch(tenantDb as any, "alpha revision");

    expect(result.topEntities[0]).toMatchObject({
      deepLink: "/deals/deal-1",
      interactionScore: 1,
    });
    expect(result.recommendedActions[0]).toMatchObject({
      actionType: "refresh_deal_copilot",
      deepLink: "/deals/deal-1?tab=overview&focus=copilot",
      executionMode: "api_then_navigate",
      interactionScore: 8,
    });
    expect(result.evidence[0]).toMatchObject({
      deepLink: "/deals/deal-1",
      interactionScore: 1,
    });
    expect(result.recommendedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionType: "refresh_deal_copilot",
          executionMode: "api_then_navigate",
          apiEndpoint: "/ai/deals/deal-1/regenerate",
          deepLink: "/deals/deal-1?tab=overview&focus=copilot",
        }),
      ])
    );
  });
});
