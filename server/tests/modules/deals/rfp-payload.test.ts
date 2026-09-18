import { describe, expect, it } from "vitest";
import {
  buildNormalizedRfpRequestBody,
  withRfpRequestBodyIdentity,
  buildRfpAttachmentsFromFiles,
  buildRfpRequestDeliveryPayload,
  resolveRfpDealAmount,
} from "../../../src/modules/deals/rfp-payload.js";

describe("RFP normalized payload builder", () => {
  it.each(["service", "roofing"])("preserves property and opportunity context for every CRM RFP type: %s", (projectType) => {
    const payload = buildNormalizedRfpRequestBody({
      deal: { id: "deal-1", dealNumber: "TR-1", name: "North wing repair", propertyName: "Park Villas", projectType },
      sourceEventId: "project-name-contract",
    });
    expect(payload.deal.name).toBe("Park Villas - North wing repair");
    expect(payload.deal.projectType).toBe(projectType === "service" ? "4" : "3");
  });
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

  describe("crmActivityLog (the Bid Board project Note)", () => {
    it("carries the pre-rendered activity block through to SyncHub", () => {
      const note =
        "CRM Activity Log — TR-26-0412 (as of Aug 17, 2026)\n\nAug 14, 2026 · Call · Jane Rep\n  Owner confirmed scope.";
      const payload = buildNormalizedRfpRequestBody({
        sourceEventId: "crm:event-activity",
        deal: { id: "deal-activity", name: "Has History", dealNumber: "dfw-3-12345-aa", crmActivityLog: note },
      });

      expect(payload.deal.crmActivityLog).toBe(note);
      // It must NOT leak into the description — Procore renders that as Project Description, which stays
      // the deal's scope only.
      expect(payload.deal.description).toBeNull();
    });

    it("emits null (not undefined) when the deal has no activity", () => {
      const payload = buildNormalizedRfpRequestBody({
        sourceEventId: "crm:event-noactivity",
        deal: { id: "deal-noactivity", name: "No History", dealNumber: "dfw-3-12346-aa" },
      });

      expect(payload.deal.crmActivityLog).toBeNull();
      expect(JSON.parse(JSON.stringify(payload)).deal).toHaveProperty("crmActivityLog", null);
    });

    it("treats a whitespace-only render as absent", () => {
      const payload = buildNormalizedRfpRequestBody({
        sourceEventId: "crm:event-blankactivity",
        deal: { id: "deal-blank", name: "Blank", dealNumber: "dfw-3-12347-aa", crmActivityLog: "   \n  " },
      });

      expect(payload.deal.crmActivityLog).toBeNull();
    });
  });

  describe("identity uuids (company / property)", () => {
    it("carries the deal's company and property uuids alongside the display names", () => {
      const payload = buildNormalizedRfpRequestBody({
        sourceEventId: "crm:event-ids",
        deal: {
          id: "deal-ids",
          name: "Identified",
          dealNumber: "dfw-4-12345-aa",
          companyId: "11111111-1111-1111-1111-111111111111",
          propertyId: "22222222-2222-2222-2222-222222222222",
          companyName: "Palm Group",
        },
      });

      expect(payload.deal.companyId).toBe("11111111-1111-1111-1111-111111111111");
      expect(payload.deal.propertyId).toBe("22222222-2222-2222-2222-222222222222");
      // The names still ship — the ids are additive, not a replacement.
      expect(payload.deal.companyName).toBe("Palm Group");
    });

    it("emits null (not undefined) for an id the deal does not have", () => {
      const payload = buildNormalizedRfpRequestBody({
        sourceEventId: "crm:event-noids",
        deal: {
          id: "deal-noids",
          name: "Unidentified",
          dealNumber: "dfw-4-12346-aa",
          companyId: "11111111-1111-1111-1111-111111111111",
        },
      });

      expect(payload.deal.propertyId).toBeNull();
      // On the wire: an omitted key and a null are different things downstream, and only null says
      // "the CRM looked and there is nothing there".
      const onTheWire = JSON.parse(JSON.stringify(payload)).deal;
      expect(onTheWire).toHaveProperty("propertyId", null);
      expect(onTheWire).toHaveProperty("companyId", "11111111-1111-1111-1111-111111111111");
    });

    it("treats a blank id as absent", () => {
      const payload = buildNormalizedRfpRequestBody({
        sourceEventId: "crm:event-blankids",
        deal: { id: "deal-blankids", name: "Blank", dealNumber: "dfw-4-12347-aa", companyId: "  " },
      });

      expect(payload.deal.companyId).toBeNull();
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

describe("resolveRfpDealAmount", () => {
  it("walks awarded > bid > dd > forecast", () => {
    expect(
      resolveRfpDealAmount({
        awardedAmount: "925000",
        bidEstimate: "800000",
        ddEstimate: "700000",
        forecastRevenue: "600000",
      })
    ).toBe(925000);
    expect(
      resolveRfpDealAmount({ awardedAmount: null, bidEstimate: "800000", ddEstimate: "700000" })
    ).toBe(800000);
    expect(resolveRfpDealAmount({ ddEstimate: "700000", forecastRevenue: "600000" })).toBe(700000);
    expect(resolveRfpDealAmount({ forecastRevenue: "600000" })).toBe(600000);
  });

  it("treats blank, absent and non-numeric columns as no value", () => {
    expect(resolveRfpDealAmount({})).toBeNull();
    expect(resolveRfpDealAmount({ awardedAmount: "", bidEstimate: null, ddEstimate: undefined })).toBeNull();
    expect(resolveRfpDealAmount({ awardedAmount: "not a number" })).toBeNull();
    // 0 is a real answer, not "missing" — it must not fall through to the next column.
    expect(resolveRfpDealAmount({ awardedAmount: 0, bidEstimate: "800000" })).toBe(0);
  });

  it("is the SAME precedence the send-time payload uses", () => {
    const deal = {
      id: "deal-precedence",
      name: "Precedence",
      dealNumber: "dfw-4-12345-aa",
      awardedAmount: null,
      bidEstimate: "248500",
      ddEstimate: "100000",
      forecastRevenue: "95000",
    };

    // If these two ever diverge, the number in the RFP email and the number on the RFP report
    // are computed by different rules for the same deal.
    expect(buildNormalizedRfpRequestBody({ deal, sourceEventId: "e" }).deal.amount).toBe(
      resolveRfpDealAmount(deal)
    );
  });
});

describe("RFP client email — a present-but-invalid address must not sink the delivery", () => {
  // Production, 2026-09-10: six Bella Vida RFPs died on `mailto:bellavidapm@bellairemultifamily.com`
  // pasted into a contact record. SyncHub 422s a malformed address, the worker burned 8 retries, and
  // the deals sat in send_failed for 8 days. The field is OPTIONAL — 273 RFPs have delivered with it
  // absent — so a value we cannot vouch for must degrade to null, never be forwarded as-is.

  const build = (clientEmail: unknown) =>
    buildNormalizedRfpRequestBody({
      deal: { id: "deal-1", name: "Bella Vida", projectType: "service", clientEmail },
      sourceEventId: "crm:event-1",
    }).deal.clientEmail;

  it("strips a mailto: prefix pasted from a web page or mail client", () => {
    expect(build("mailto:bellavidapm@bellairemultifamily.com")).toBe("bellavidapm@bellairemultifamily.com");
  });

  it.each([
    ["MAILTO:Casey@Example.com", "Casey@Example.com"],
    ["  mailto:casey@example.com  ", "casey@example.com"],
    ["<casey@example.com>", "casey@example.com"],
    ["Casey Jones <casey@example.com>", "casey@example.com"],
    ["casey@example.com,", "casey@example.com"],
  ])("recovers the address from %j", (input, expected) => {
    expect(build(input)).toBe(expected);
  });

  it("passes a clean address through untouched", () => {
    expect(build("casey@example.com")).toBe("casey@example.com");
  });

  it.each(["not-an-email", "mailto:", "@example.com", "casey@", "   "])(
    "drops %j to null rather than forwarding something SyncHub will reject",
    (input) => {
      expect(build(input)).toBeNull();
    }
  );

  it("leaves an absent email absent", () => {
    expect(build(null)).toBeNull();
    expect(build(undefined)).toBeNull();
  });
});

describe("RFP retry — a rescued body must not re-send the value that killed it", () => {
  // The retry path does NOT rebuild the payload: it spreads the DEAD job's stored body and re-resolves
  // only identity. So the six Bella Vida RFPs would have re-sent `mailto:...` and 422'd again even after
  // the contact record was corrected. Re-derive the email from the deal, and normalize either way.

  const rescue = (storedEmail: string | null, dealEmail?: string | null) =>
    withRfpRequestBodyIdentity(
      { deal: { clientEmail: storedEmail } } as any,
      { companyId: "c1", propertyId: "p1", ...(dealEmail === undefined ? {} : { clientEmail: dealEmail }) } as any
    ).deal.clientEmail;

  it("takes the deal's CURRENT contact email over the one frozen in the dead payload", () => {
    expect(rescue("mailto:old@example.com", "corrected@example.com")).toBe("corrected@example.com");
  });

  it("normalizes a stored mailto: when the caller supplies no current email", () => {
    expect(rescue("mailto:bellavidapm@bellairemultifamily.com")).toBe("bellavidapm@bellairemultifamily.com");
  });

  it("drops an unrecoverable stored value rather than re-sending it", () => {
    expect(rescue("not-an-email")).toBeNull();
  });

  it("still re-resolves the identity ids it always did", () => {
    const body = withRfpRequestBodyIdentity(
      { deal: { clientEmail: null } } as any,
      { companyId: "company-9", propertyId: "property-9" } as any
    );
    expect(body.deal.companyId).toBe("company-9");
    expect(body.deal.propertyId).toBe("property-9");
  });
});

describe("RFP client email — Codex review findings on PR #1145", () => {
  const build = (clientEmail: unknown) =>
    buildNormalizedRfpRequestBody({
      deal: { id: "deal-1", name: "D", projectType: "service", clientEmail },
      sourceEventId: "crm:e1",
    }).deal.clientEmail;

  // P1: the ORIGINAL bug was a pasted mailto link. Real ones carry query params, and stripping only the
  // scheme leaves `casey@example.com?subject=RFP` — which the first permissive regex ACCEPTED, so the
  // sanitizer would have forwarded an invalid mailbox and 422'd the RFP exactly as before.
  it.each([
    ["mailto:casey@example.com?subject=RFP", "casey@example.com"],
    ["mailto:casey@example.com?subject=RFP&body=hello", "casey@example.com"],
    ["mailto:casey@example.com#fragment", "casey@example.com"],
  ])("drops mailto query/fragment parameters: %j", (input, expected) => {
    expect(build(input)).toBe(expected);
  });

  it.each(["casey@example.com?subject=RFP", "casey@example.com#frag", "casey@exa mple.com"])(
    "rejects %j outright rather than forwarding it",
    (input) => {
      expect(build(input)).toBeNull();
    }
  );

  // P2: an explicit null from the caller means "this contact HAS no email" and is authoritative.
  // Treating it as "not supplied" resurrects the stale address the retry is trying to escape.
  it("treats an explicitly null current email as authoritative, not as absent", () => {
    const body = withRfpRequestBodyIdentity(
      { deal: { clientEmail: "mailto:stale@old.example.com", contactName: "Old", clientPhone: "1" } } as any,
      { companyId: "c1", propertyId: "p1", clientEmail: null } as any
    );
    expect(body.deal.clientEmail).toBeNull();
  });

  it("still falls back to the stored value when the caller supplies no clientEmail key at all", () => {
    const body = withRfpRequestBodyIdentity(
      { deal: { clientEmail: "mailto:kept@example.com" } } as any,
      { companyId: "c1", propertyId: "p1" } as any
    );
    expect(body.deal.clientEmail).toBe("kept@example.com");
  });

  // P2: refreshing only the email onto a stored body leaves the PREVIOUS contact's name and phone,
  // shipping SyncHub a hybrid person.
  it("refreshes name and phone with the email, never a hybrid contact record", () => {
    const body = withRfpRequestBodyIdentity(
      { deal: { clientEmail: "old@example.com", contactName: "Old Person", clientPhone: "111" } } as any,
      {
        companyId: "c1",
        propertyId: "p1",
        clientEmail: "new@example.com",
        contactName: "New Person",
        clientPhone: "222",
      } as any
    );
    expect(body.deal.clientEmail).toBe("new@example.com");
    expect(body.deal.contactName).toBe("New Person");
    expect(body.deal.clientPhone).toBe("222");
  });

  it("leaves the stored contact tuple alone when no current contact is supplied", () => {
    const body = withRfpRequestBodyIdentity(
      { deal: { clientEmail: "a@b.com", contactName: "Stored", clientPhone: "999" } } as any,
      { companyId: "c1", propertyId: "p1" } as any
    );
    expect(body.deal.contactName).toBe("Stored");
    expect(body.deal.clientPhone).toBe("999");
  });
});

describe("RFP client email — Codex round 2", () => {
  const build = (clientEmail: unknown) =>
    buildNormalizedRfpRequestBody({
      deal: { id: "d", name: "D", projectType: "service", clientEmail },
      sourceEventId: "crm:e1",
    }).deal.clientEmail;

  // Dots may only SEPARATE segments. A character-class local part accepted all of these, and standard
  // validators reject them — so forwarding one reproduces the 422 this sanitizer exists to prevent.
  it.each([".casey@example.com", "casey.@example.com", "casey..jones@example.com", "casey@example..com"])(
    "rejects malformed dot placement: %j",
    (input) => {
      expect(build(input)).toBeNull();
    }
  );

  it.each(["casey.jones@example.com", "casey@mail.example.co.uk", "o'brien+rfp@example.com"])(
    "still accepts a legitimate address: %j",
    (input) => {
      expect(build(input)).toBe(input);
    }
  );
});

describe("RFP client email — Codex round 3 (domain labels)", () => {
  const build = (clientEmail: unknown) =>
    buildNormalizedRfpRequestBody({
      deal: { id: "d", name: "D", projectType: "service", clientEmail },
      sourceEventId: "crm:e1",
    }).deal.clientEmail;

  it.each(["casey@-example.com", "casey@foo.-example.com", "casey@example-.com"])(
    "rejects a hyphen at a domain-label boundary: %j",
    (input) => {
      expect(build(input)).toBeNull();
    }
  );

  it("still accepts a hyphen INSIDE a label", () => {
    expect(build("casey@my-host.example.com")).toBe("casey@my-host.example.com");
  });
});
