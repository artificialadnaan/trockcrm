import { describe, it, expect } from "vitest";
import {
  mapDeal,
  mapContact,
  mapActivity,
  mapHubSpotStage,
  buildOwnerEmailMap,
} from "../../../src/modules/migration/field-mapper.js";
import type { HubSpotDeal, HubSpotContact, HubSpotActivity, HubSpotOwner } from "../../../src/modules/migration/hubspot-client.js";

describe("buildOwnerEmailMap", () => {
  it("builds email map from owner list", () => {
    const owners: HubSpotOwner[] = [
      { id: "111", email: "john@trock.com" },
      { id: "222", email: "JANE@TROCK.COM" },
    ];
    const map = buildOwnerEmailMap(owners);
    expect(map.get("111")).toBe("john@trock.com");
    expect(map.get("222")).toBe("jane@trock.com"); // lowercased
  });

  it("skips owners without email", () => {
    const owners: HubSpotOwner[] = [{ id: "333" }];
    const map = buildOwnerEmailMap(owners);
    expect(map.has("333")).toBe(false);
  });
});

describe("mapHubSpotStage", () => {
  it("maps known HubSpot stage slugs to CRM slugs", () => {
    expect(mapHubSpotStage("closedwon")).toBe("closed_won");
    expect(mapHubSpotStage("closedlost")).toBe("closed_lost");
    expect(mapHubSpotStage("contractsent")).toBe("bid_sent");
  });

  it("passes through unknown stages unchanged", () => {
    expect(mapHubSpotStage("unknownstage")).toBe("unknownstage");
  });

  it("returns empty string for undefined input", () => {
    expect(mapHubSpotStage(undefined)).toBe("");
  });
});

describe("mapDeal", () => {
  const ownerMap = new Map([["owner-1", "rep@trock.com"]]);

  const baseDeal: HubSpotDeal = {
    id: "hs-deal-1",
    properties: {
      dealname: "  Test Deal  ",
      dealstage: "contractsent",
      hubspot_owner_id: "owner-1",
      amount: "150000",
      closedate: "2026-06-01T00:00:00Z",
      lead_source: "Referral",
    },
  };

  it("maps all core fields correctly", () => {
    const result = mapDeal(baseDeal, ownerMap);
    expect(result.hubspotDealId).toBe("hs-deal-1");
    expect(result.mappedName).toBe("Test Deal"); // trimmed
    expect(result.mappedStage).toBe("bid_sent");
    expect(result.mappedRepEmail).toBe("rep@trock.com");
    expect(result.mappedAmount).toBe(150000);
    expect(result.mappedCloseDate).toBe("2026-06-01");
    expect(result.mappedSource).toBe("Referral");
  });

  it("sets null for missing amount", () => {
    const deal = { ...baseDeal, properties: { ...baseDeal.properties, amount: "" } };
    const result = mapDeal(deal, ownerMap);
    expect(result.mappedAmount).toBeNull();
  });

  it("uses HubSpot as default source when lead_source missing", () => {
    const deal = { ...baseDeal, properties: { ...baseDeal.properties, lead_source: undefined } };
    const result = mapDeal(deal, ownerMap);
    expect(result.mappedSource).toBe("HubSpot");
  });

  it("handles unknown owner ID gracefully", () => {
    const deal = {
      ...baseDeal,
      properties: { ...baseDeal.properties, hubspot_owner_id: "unknown-owner" },
    };
    const result = mapDeal(deal, ownerMap);
    expect(result.mappedRepEmail).toBeNull();
  });
});

describe("mapContact", () => {
  const baseContact: HubSpotContact = {
    id: "hs-contact-1",
    properties: {
      firstname: "John",
      lastname: "Smith",
      email: "JOHN@CLIENT.COM",
      phone: "(214) 555-1234",
      company: "Test Corp",
    },
  };

  it("maps core fields and normalizes email to lowercase", () => {
    const result = mapContact(baseContact);
    expect(result.hubspotContactId).toBe("hs-contact-1");
    expect(result.mappedFirstName).toBe("John");
    expect(result.mappedLastName).toBe("Smith");
    expect(result.mappedEmail).toBe("john@client.com");
    expect(result.mappedPhone).toBe("(214) 555-1234");
    expect(result.mappedCompany).toBe("Test Corp");
  });

  it("defaults category to 'other'", () => {
    const result = mapContact(baseContact);
    expect(result.mappedCategory).toBe("other");
  });

  it("infers 'client' category from customer lifecycle stage", () => {
    const contact: HubSpotContact = {
      ...baseContact,
      properties: { ...baseContact.properties, lifecyclestage: "customer" },
    };
    const result = mapContact(contact);
    expect(result.mappedCategory).toBe("client");
  });
});

describe("mapActivity", () => {
  const baseActivity: HubSpotActivity = {
    id: "hs-act-1",
    properties: {
      hs_call_title: "Follow-up call",
      hs_call_body: "Discussed pricing options",
      hs_timestamp: "2026-04-15T14:30:00Z",
    },
    associations: {
      deals: { results: [{ id: "deal-hs-1" }] },
      contacts: { results: [{ id: "contact-hs-1" }] },
    },
  };
  (baseActivity as any).__type = "calls";

  it("maps call activity correctly", () => {
    const result = mapActivity(baseActivity);
    expect(result.hubspotActivityId).toBe("hs-act-1");
    expect(result.mappedType).toBe("call");
    expect(result.mappedSubject).toBe("Follow-up call");
    expect(result.mappedBody).toBe("Discussed pricing options");
    expect(result.hubspotDealId).toBe("deal-hs-1");
    expect(result.hubspotContactId).toBe("contact-hs-1");
    expect(result.mappedOccurredAt).toContain("2026-04-15");
  });

  it("maps note activity", () => {
    const note: HubSpotActivity = {
      id: "hs-note-1",
      properties: { hs_note_body: "Met at site" },
    };
    (note as any).__type = "notes";
    const result = mapActivity(note);
    expect(result.mappedType).toBe("note");
    expect(result.mappedBody).toBe("Met at site");
    expect(result.mappedSubject).toBe("Note");
  });
});
