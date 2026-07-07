import { describe, expect, it } from "vitest";
import {
  buildNormalizedRfpRequestBody,
  buildRfpAttachmentsFromFiles,
  buildRfpRequestDeliveryPayload,
} from "../../../src/modules/deals/rfp-payload.js";

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

  describe("project number (formatted, never the raw HubSpot id)", () => {
    it("ships the canonical project_number for a HubSpot-imported deal (not the HS id)", () => {
      const payload = buildNormalizedRfpRequestBody({
        sourceEventId: "crm:event-hs",
        deal: {
          id: "deal-hs",
          name: "HubSpot Deal",
          dealNumber: "HS-318900588242", // raw HubSpot id — must never ship
          projectNumber: "DFW-2-31825-aa", // canonical formatted number
        },
      });
      expect(payload.deal.projectNumber).toBe("DFW-2-31825-aa");
    });

    it("uses the bid-board deal_number when project_number is empty (non-HS)", () => {
      const payload = buildNormalizedRfpRequestBody({
        sourceEventId: "crm:event-bb",
        deal: {
          id: "deal-bb",
          name: "Bid Board Deal",
          dealNumber: "ATL-4-12345-aa",
          projectNumber: null,
        },
      });
      expect(payload.deal.projectNumber).toBe("ATL-4-12345-aa");
    });

    it("falls back to the deal id (not the HS id) when there is no real number yet", () => {
      const payload = buildNormalizedRfpRequestBody({
        sourceEventId: "crm:event-pending",
        deal: {
          id: "deal-pending-uuid",
          name: "Pending HubSpot Deal",
          dealNumber: "HS-999999999",
          projectNumber: null,
        },
      });
      expect(payload.deal.projectNumber).toBe("deal-pending-uuid");
      expect(payload.deal.projectNumber).not.toContain("HS-");
    });
  });

  it("maps the resolved deal owner into the payload (Requested by)", () => {
    const payload = buildNormalizedRfpRequestBody({
      sourceEventId: "crm:event-owner",
      deal: {
        id: "deal-owner",
        name: "Owned Deal",
        dealNumber: "dfw-2-99999-aa",
        ownerName: "Maria Gonzalez",
        ownerEmail: "maria@trockgc.com",
      },
    });
    expect(payload.deal.ownerName).toBe("Maria Gonzalez");
    expect(payload.deal.ownerEmail).toBe("maria@trockgc.com");
  });

  it("emits null owner fields (not undefined) when no owner was resolved", () => {
    const payload = buildNormalizedRfpRequestBody({
      sourceEventId: "crm:event-noowner",
      deal: { id: "deal-noowner", name: "No Owner", dealNumber: "dfw-2-88888-aa" },
    });
    expect(payload.deal.ownerName).toBeNull();
    expect(payload.deal.ownerEmail).toBeNull();
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

  it("includes provided attachments in the normalized body", () => {
    const payload = buildNormalizedRfpRequestBody({
      sourceEventId: "crm:event-att",
      deal: { id: "deal-att", name: "Has Files", dealNumber: "dfw-1-00001-aa" },
      attachments: [
        { name: "Roof Plan.pdf", url: "https://signed/x", contentType: "application/pdf" },
      ],
    });

    expect(payload.attachments).toEqual([
      { name: "Roof Plan.pdf", url: "https://signed/x", contentType: "application/pdf" },
    ]);
  });

  it("defaults attachments to an empty array when none are provided", () => {
    const payload = buildNormalizedRfpRequestBody({
      sourceEventId: "crm:event-noatt",
      deal: { id: "deal-noatt", name: "No Files", dealNumber: "dfw-1-00002-aa" },
    });

    expect(payload.attachments).toEqual([]);
  });

  it("maps active deal files to RFP attachments via the injected URL resolver", async () => {
    const attachments = await buildRfpAttachmentsFromFiles(
      [
        {
          displayName: "Roof Plan",
          fileExtension: ".pdf",
          mimeType: "application/pdf",
          r2Key: "deals/d1/roof.pdf",
        },
        {
          displayName: "Site Photo",
          fileExtension: ".jpg",
          mimeType: "image/jpeg",
          r2Key: "deals/d1/site.jpg",
        },
      ],
      async ({ r2Key, filename }) =>
        `https://signed.example/${r2Key}?name=${encodeURIComponent(filename)}`
    );

    expect(attachments).toEqual([
      {
        name: "Roof Plan.pdf",
        url: "https://signed.example/deals/d1/roof.pdf?name=Roof%20Plan.pdf",
        contentType: "application/pdf",
      },
      {
        name: "Site Photo.jpg",
        url: "https://signed.example/deals/d1/site.jpg?name=Site%20Photo.jpg",
        contentType: "image/jpeg",
      },
    ]);
  });

  it("passes attachments through the delivery payload wrapper", () => {
    const payload = buildRfpRequestDeliveryPayload({
      syncHubUrl: "https://synchub.example.com/api/rfp-requests",
      sourceEventId: "crm:event-att2",
      deal: { id: "deal-att2", name: "Wrapped", dealNumber: "dfw-9-12345-aa" },
      attachments: [{ name: "a.pdf", url: "u", contentType: "application/pdf" }],
    });

    expect(payload.body.attachments).toEqual([
      { name: "a.pdf", url: "u", contentType: "application/pdf" },
    ]);
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
