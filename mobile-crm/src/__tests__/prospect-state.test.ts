import {
  canSubmit,
  describeMatch,
  isPositionTooCoarse,
  submitBlockedReason,
} from "../prospect-state";
import type { PropertyMatch } from "../api/endpoints/prospecting";

const match = (over: Partial<PropertyMatch> = {}): PropertyMatch => ({
  id: "p1",
  name: "Palm Villas",
  address: "1420 Bishop St",
  city: "Dallas",
  state: "TX",
  zip: "75201",
  companyId: "c1",
  companyName: "Palm Villas HOA",
  distanceMeters: null,
  reason: "address",
  addressMatch: "exact",
  ...over,
});

describe("canSubmit", () => {
  const base = { type: "site_visit" as const, body: "Met the super", outcome: "" };

  it("requires somewhere to attach", () => {
    // The server's source_entity_type/id are NOT NULL and the route answers 400 "Activity target is
    // required". Enforcing it here is the difference between a disabled button with a reason and a rep
    // filling in a form outside, tapping save, and getting a 400 they cannot act on.
    expect(canSubmit({ ...base, target: {} })).toBe(false);
    expect(canSubmit({ ...base, target: { propertyId: "p1" } })).toBe(true);
  });

  it.each([
    ["a company", { companyId: "c1" }],
    ["a contact", { contactId: "ct1" }],
    ["a deal", { dealId: "d1" }],
    ["a lead", { leadId: "l1" }],
  ])("accepts %s as the target too", (_label, target) => {
    // A rep who cannot get a property fix must still be able to log the call they just made.
    expect(canSubmit({ ...base, target })).toBe(true);
  });

  it("requires the capture to SAY something", () => {
    // A target with no content is a row asserting a rep was somewhere and nothing about why — worse
    // than no row, because it looks like data.
    expect(canSubmit({ target: { propertyId: "p1" }, type: "site_visit", body: "  ", outcome: "  " }))
      .toBe(false);
    expect(canSubmit({ target: { propertyId: "p1" }, type: "site_visit", body: "", outcome: "No answer" }))
      .toBe(true);
  });

  it("requires a type — the server 400s without one", () => {
    expect(canSubmit({ ...base, target: { propertyId: "p1" }, type: null })).toBe(false);
  });
});

describe("submitBlockedReason", () => {
  it("is null exactly when the capture can be submitted", () => {
    const ok = { target: { propertyId: "p1" }, type: "call" as const, body: "Spoke to Dana", outcome: "" };
    expect(submitBlockedReason(ok)).toBeNull();
    expect(canSubmit(ok)).toBe(true);
  });

  it("names the missing piece rather than just refusing", () => {
    // A disabled control with no explanation is the same defect as a dead one — outside on a roof, the
    // rep will not go hunting for which field it wants.
    expect(submitBlockedReason({ target: {}, type: "call", body: "x", outcome: "" })).toMatch(/property/i);
    expect(submitBlockedReason({ target: { propertyId: "p1" }, type: null, body: "x", outcome: "" }))
      .toMatch(/what happened/i);
    expect(submitBlockedReason({ target: { propertyId: "p1" }, type: "call", body: "", outcome: "" }))
      .toMatch(/note or an outcome/i);
  });
});

describe("isPositionTooCoarse", () => {
  it("flags a fix wider than the matcher's own radius", () => {
    // 300 m covers a city block; the matcher works at 200. Offering "the property you're at" from that
    // is a confident guess, and a confidently wrong property attaches the visit to the neighbour.
    expect(isPositionTooCoarse(300, 100)).toBe(true);
    expect(isPositionTooCoarse(35, 100)).toBe(false);
  });

  it("does not warn when accuracy is unknown", () => {
    // Unknown is not the same as bad; warning on every fix teaches reps to ignore the warning.
    expect(isPositionTooCoarse(null, 100)).toBe(false);
  });
});

describe("describeMatch", () => {
  /**
   * The reason travels from the server so this is not a guess. "Same address" and "40 m away" are
   * different claims with different confidence, and an unexplained suggestion is how the wrong property
   * gets confirmed.
   */
  it("distinguishes an exact address from a same-building hint", () => {
    expect(describeMatch(match({ addressMatch: "exact" }))).toBe("Same address");
    // The suite case: the stored record names a tenancy the geocode didn't. Strong, not certain — and
    // saying so is what stops a rep confirming the wrong tenant in a tower.
    expect(describeMatch(match({ addressMatch: "base" }))).toMatch(/check the suite/i);
  });

  it("reports proximity in units a person reads", () => {
    expect(describeMatch(match({ addressMatch: null, reason: "distance", distanceMeters: 40 })))
      .toBe("40 m away");
    expect(describeMatch(match({ addressMatch: null, reason: "distance", distanceMeters: 1500 })))
      .toBe("1.5 km away");
  });

  it("combines both when both are known", () => {
    expect(describeMatch(match({ addressMatch: "exact", distanceMeters: 12 })))
      .toBe("Same address · 12 m away");
  });

  it("never renders an empty description", () => {
    // A blank row in the confirm list is a tappable thing with no stated reason.
    expect(describeMatch(match({ addressMatch: null, reason: "distance", distanceMeters: null })))
      .toBe("Nearby");
  });
});

describe("describeMatch — the suite caveat survives a distance reading", () => {
  it("keeps 'check the suite' when coordinates are also present", () => {
    // Coordinates prove the BUILDING, never the tenancy. "Same building · 12 m away" without the
    // caveat reads as certainty about the wrong thing, and confirming the wrong suite attaches the
    // visit to the neighbouring tenant.
    expect(describeMatch(match({ addressMatch: "base", distanceMeters: 12 }))).toMatch(/check the suite/i);
  });
});
