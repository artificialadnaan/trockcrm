import { describe, expect, it, vi } from "vitest";

const { naturalLanguageSearch } = await import("../../../src/modules/search/service.js");

describe("search service", () => {
  it("boosts AI search artifacts using historical interaction data", async () => {
    // searchFiles + AI evidence still use raw .execute(); deals/contacts/companies/leads/
    // properties + the interaction-score lookup now use the .select() query builder.
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // searchFiles -> no files
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
      }); // searchAiEvidence

    const dealRows = [
      {
        id: "deal-1",
        name: "Alpha Plaza",
        dealNumber: "D-1001",
        projectNumber: null,
        propertyCity: "Dallas",
        propertyState: "TX",
        stageSlug: null,
        onHold: false,
      },
    ];
    const feedbackRows = [
      {
        targetId: "query-1",
        feedbackValue: "search_impression",
        comment: JSON.stringify({
          targetValue: "deal_lookup",
          deepLink: "/search?q=alpha%20revision",
          queryContext: {
            query: "alpha revision",
            intent: "deal_lookup",
            structuredTotal: 1,
            topEntityTypes: ["deal"],
            recommendedActionTypes: ["refresh_deal_copilot"],
            hasEvidence: true,
          },
        }),
      },
      {
        targetId: "query-1",
        feedbackValue: "recommended_action_executed",
        comment: JSON.stringify({
          targetValue: "refresh_deal_copilot",
          deepLink: "/deals/deal-1?tab=overview&focus=copilot",
          executionMode: "api_then_navigate",
          apiEndpoint: "/ai/deals/deal-1/regenerate",
        }),
      },
      {
        targetId: "query-2",
        feedbackValue: "recommended_action_click",
        comment: JSON.stringify({
          targetValue: "review_deal_emails",
          deepLink: "/deals/deal-1?tab=email",
        }),
      },
      {
        targetId: "query-3",
        feedbackValue: "top_entity_click",
        comment: JSON.stringify({
          targetValue: "deal:deal-1",
          deepLink: "/deals/deal-1",
        }),
      },
    ];

    // A chainable query-builder stub: every method returns the builder; awaiting it resolves to
    // the configured rows. Sequenced across the select() calls the search makes.
    const chainable = (rows: unknown[]) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin", "groupBy"]) {
        builder[method] = vi.fn(() => builder);
      }
      (builder as { then: unknown }).then = (resolve: (value: unknown) => unknown) => resolve(rows);
      return builder;
    };

    // naturalLanguageSearch keeps the narrow default types (deals/contacts/files) for backward
    // compat, so the select() calls are: searchDeals, searchContacts, then the interaction-score
    // lookup (files uses .execute()). Default to empty for any extra call.
    const select = vi.fn(() => chainable([]));
    select.mockReturnValueOnce(chainable(dealRows)); // searchDeals
    select.mockReturnValueOnce(chainable([])); // searchContacts
    select.mockReturnValueOnce(chainable(feedbackRows)); // getSearchInteractionScores

    const tenantDb = {
      execute,
      select,
    };

    const result = await naturalLanguageSearch(tenantDb as any, "deal alpha revision");

    expect(result.topEntities[0]).toMatchObject({
      deepLink: "/deals/deal-1",
      interactionScore: 1,
    });
    expect(result.recommendedActions[0]).toMatchObject({
      actionType: "refresh_deal_copilot",
      deepLink: "/deals/deal-1?tab=overview&focus=copilot",
      executionMode: "api_then_navigate",
      interactionScore: 10,
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
