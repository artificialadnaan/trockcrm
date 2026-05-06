import { describe, expect, it } from "vitest";
import { buildNormalizedRfpRequestBody, buildRfpRequestDeliveryPayload } from "../../../src/modules/deals/rfp-payload.js";

describe("RFP normalized payload builder", () => {
  it("maps CRM deal fields to the SyncHub RFP request contract", () => {
    const payload = buildNormalizedRfpRequestBody({
      sourceEventId: "crm:event-1",
      deal: {
        id: "deal-1",
        name: "Palm Villas",
        dealNumber: "dfw-4-12345-aa",
        projectType: "roofing",
        workflowRoute: "service",
        awardedAmount: null,
        bidEstimate: "125000.50",
        ddEstimate: "100000",
        forecastRevenue: "95000",
        estimator: "Internal Estimator",
        bidBoardEstimator: "Bid Board Estimator",
        companyName: "Palm Group",
        contactName: "Casey Contact",
        clientEmail: "casey@example.com",
        clientPhone: "555-1000",
        propertyAddress: "100 Main",
        propertyCity: "Dallas",
        propertyState: "TX",
        propertyZip: "75201",
        propertyCountry: "USA",
        description: "Exterior scope",
        bidDueDate: "2026-06-01T15:30:00.000Z",
        bidBoardDueDate: "2026-07-01",
      },
    });

    expect(payload).toMatchObject({
      sourceSystem: "trock_crm",
      sourceDealId: "deal-1",
      sourceEventId: "crm:event-1",
      deal: {
        name: "Palm Villas",
        projectNumber: "dfw-4-12345-aa",
        projectType: "3",
        amount: 125000.5,
        estimator: "Internal Estimator",
        companyName: "Palm Group",
        contactName: "Casey Contact",
        clientEmail: "casey@example.com",
        clientPhone: "555-1000",
        address: {
          street: "100 Main",
          city: "Dallas",
          state: "TX",
          zip: "75201",
          country: "USA",
        },
        description: "Exterior scope",
        dueDate: "2026-06-01T15:30:00.000Z",
        workflowRoute: "service",
      },
      attachments: [],
    });
  });

  it("falls back from CRM-native fields to Bid Board mirror fields", () => {
    const payload = buildNormalizedRfpRequestBody({
      sourceEventId: "crm:event-2",
      deal: {
        id: "deal-2",
        name: "Fallback",
        dealNumber: "dfw-9-12345-aa",
        workflowRoute: "normal",
        estimator: null,
        bidBoardEstimator: "Mirror Estimator",
        propertyAddress: "200 Main",
        propertyCity: null,
        propertyState: null,
        propertyZip: null,
        propertyCountry: null,
        bidDueDate: null,
        bidBoardDueDate: "2026-08-02",
      },
    });

    expect(payload.deal.estimator).toBe("Mirror Estimator");
    expect(payload.deal.address?.country).toBe("US");
    expect(payload.deal.dueDate).toBe(new Date("2026-08-02").toISOString());
  });

  it("wraps the body with delivery metadata", () => {
    const payload = buildRfpRequestDeliveryPayload({
      syncHubUrl: "https://synchub.example.com/api/rfp-requests",
      sourceEventId: "crm:event-3",
      deal: {
        id: "deal-3",
        name: "Wrapped",
        dealNumber: "dfw-9-12345-aa",
      },
    });

    expect(payload.dealId).toBe("deal-3");
    expect(payload.syncHubUrl).toBe("https://synchub.example.com/api/rfp-requests");
    expect(payload.body.sourceSystem).toBe("trock_crm");
  });
});
