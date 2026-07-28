import {
  canSubmit,
  describeMatch,
  haltsForDuplicates,
  isCorroborated,
  leadFlagNextStep,
  isPositionTooCoarse,
  personDetailsWillBeDiscarded,
  planContact,
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
    expect(describeMatch(match({ addressMatch: "exact" }), QUERY)).toBe("Same address");
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

describe("describeMatch — precision", () => {
  it("rounds metres rather than printing a raw float", () => {
    // distanceMeters is a number, not an integer. "40.7318 m away" reads as false precision from a GPS
    // fix that is accurate to tens of metres.
    expect(describeMatch(match({ addressMatch: null, reason: "distance", distanceMeters: 40.7318 })))
      .toBe("41 m away");
  });
});

describe("isPositionTooCoarse — the boundary", () => {
  it("treats a fix exactly at the threshold as acceptable", () => {
    // Strict >, deliberately: the threshold is the largest fix still worth trusting, and nothing else
    // recorded that choice.
    expect(isPositionTooCoarse(100, 100)).toBe(false);
    expect(isPositionTooCoarse(100.1, 100)).toBe(true);
  });
});

describe("planContact — who the visit is filed against", () => {
  const base = { first: "Dana", last: "Reyes", key: "dana|reyes||", resolvedContactId: null, waived: false };

  it("creates a contact when the draft names one and nothing is committed", () => {
    expect(planContact(base).plan).toEqual({ action: "create" });
  });

  it("skips the person when the draft has no complete name", () => {
    expect(planContact({ ...base, last: "" }).plan).toEqual({ action: "skip" });
  });

  it("reuses a contact committed by a failed attempt rather than creating a second one", () => {
    const { plan } = planContact({ ...base, retained: { id: "c1", key: "dana|reyes||" } });
    expect(plan).toEqual({ action: "reuse", contactId: "c1" });
  });

  it("DROPS a retained contact once the name changes", () => {
    // The rep corrected the name after a failed save. Reusing here filed the visit against the person
    // they had just replaced.
    const { plan, dropRetained } = planContact({
      ...base,
      last: "Ruiz",
      key: "dana|ruiz||",
      retained: { id: "c1", key: "dana|reyes||" },
    });
    expect(dropRetained).toBe(true);
    expect(plan).toEqual({ action: "create" });
  });

  it("DROPS a retained contact when only the phone or title changed", () => {
    // Keyed on the name alone this read as unchanged, so the corrected phone number never left the
    // phone while the rep sat looking at it.
    const { plan, dropRetained } = planContact({
      ...base,
      key: "dana|reyes|5551234|super|",
      retained: { id: "c1", key: "dana|reyes||super|" },
    });
    expect(dropRetained).toBe(true);
    expect(plan).toEqual({ action: "create" });
  });

  it("DROPS a retained contact when the company target changes", () => {
    const { plan } = planContact({
      ...base,
      key: "dana|reyes||co-2",
      retained: { id: "c1", key: "dana|reyes||co-1" },
    });
    expect(plan).toEqual({ action: "create" });
  });

  it("uses the duplicate the rep picked, in preference to anything else", () => {
    const { plan } = planContact({
      ...base,
      resolvedContactId: "existing-9",
      retained: { id: "c1", key: "dana|reyes||" },
    });
    expect(plan).toEqual({ action: "reuse", contactId: "existing-9" });
  });

  it("does not re-create after the rep waived the person", () => {
    // Without this the resubmit calls /contacts again, gets the same dedup answer, and the screen asks
    // the question the rep just answered — forever.
    expect(planContact({ ...base, waived: true }).plan).toEqual({ action: "skip" });
  });
});

describe("haltsForDuplicates", () => {
  it("halts when the reply carries suggestions and no new id", () => {
    expect(haltsForDuplicates({ duplicates: [{ id: "a" }] })).toBe(true);
  });

  it("proceeds once a contact was actually created", () => {
    expect(haltsForDuplicates({ createdId: "c1", duplicates: [] })).toBe(false);
  });

  it("proceeds when there is nothing to ask about", () => {
    expect(haltsForDuplicates({ duplicates: null })).toBe(false);
  });
});

describe("personDetailsWillBeDiscarded", () => {
  const d = (o: Partial<Record<"first" | "last" | "phone" | "title", string>>) =>
    personDetailsWillBeDiscarded({ first: "", last: "", phone: "", title: "", ...o });

  it("warns on a phone with no name — the case that showed nothing at all", () => {
    expect(d({ phone: "555-1234" })).toBe(true);
  });

  it("warns on a title with no name", () => {
    expect(d({ title: "Property manager" })).toBe(true);
  });

  it("warns on a half-typed name in either direction", () => {
    expect(d({ first: "Dana" })).toBe(true);
    expect(d({ last: "Reyes" })).toBe(true);
  });

  it("stays quiet on a complete person", () => {
    expect(d({ first: "Dana", last: "Reyes", phone: "555-1234" })).toBe(false);
  });

  it("stays quiet on an empty person block, which is the normal case", () => {
    expect(d({})).toBe(false);
  });

  it("treats whitespace as empty", () => {
    expect(d({ first: "  ", last: "  " })).toBe(false);
  });
});

describe("a CONTACT is a valid target", () => {
  // The screen promised "a company or contact" long before one could be chosen. These pin the gate
  // side of that promise, so the target can never silently narrow back to property-or-company.
  it("lets a visit submit against a contact alone", () => {
    expect(
      canSubmit({ target: { contactId: "ct1" }, type: "site_visit", body: "Met Dana", outcome: "" }),
    ).toBe(true);
  });

  it("does not ask for a property when a contact is the target", () => {
    expect(
      submitBlockedReason({ target: { contactId: "ct1" }, type: "call", body: "x", outcome: "" }),
    ).toBeNull();
  });

  it("still blocks with no target at all", () => {
    expect(
      submitBlockedReason({ target: {}, type: "call", body: "x", outcome: "" }),
    ).toMatch(/property/i);
  });
});

describe("leadFlagNextStep — flagging a prospect for the office", () => {
  it("sends the marker alone when the rep typed no next step", () => {
    expect(leadFlagNextStep({ flagged: true, nextStep: "" })).toBe("Create lead");
  });

  it("KEEPS the rep's own next step alongside the marker", () => {
    // One column holds both. Dropping either half loses something real: their text, or the flag the
    // office queue matches on.
    expect(leadFlagNextStep({ flagged: true, nextStep: "Call Dana Monday" })).toBe(
      "Create lead — Call Dana Monday",
    );
  });

  it("leaves an unflagged next step exactly as typed", () => {
    expect(leadFlagNextStep({ flagged: false, nextStep: "Call Dana Monday" })).toBe("Call Dana Monday");
  });

  it("sends nothing when there is neither a flag nor a next step", () => {
    expect(leadFlagNextStep({ flagged: false, nextStep: "   " })).toBeUndefined();
  });

  it("starts with the marker, so the office can match on a prefix", () => {
    expect(leadFlagNextStep({ flagged: true, nextStep: "x" })!.startsWith("Create lead")).toBe(true);
  });
});

describe("describeMatch — uncorroborated address hits", () => {
  it("does NOT claim 'Same address' when nothing corroborates it", () => {
    // An uncoordinated legacy row with no locality passes localityContradicts by "cannot disprove",
    // which is right for matching and wrong for the label: "100 Main St" is in every city.
    expect(
      describeMatch(
        match({ addressMatch: "exact", distanceMeters: null, city: null, state: null, zip: null }),
      ),
    ).toMatch(/no city on file/i);
  });

  it("still says 'Same address' when the locality agrees", () => {
    expect(
      describeMatch(
        match({ addressMatch: "exact", distanceMeters: null, city: "Dallas", state: "TX", zip: "75201" }),
        QUERY,
      ),
    ).toBe("Same address");
  });

  it("treats a distance reading as corroboration on its own", () => {
    expect(
      describeMatch(
        match({ addressMatch: "exact", distanceMeters: 12, city: null, state: null, zip: null }),
      ),
    ).toBe("Same address · 12 m away");
  });
});

/** A geocode that DID return a locality — corroboration needs two sides to agree. */
const QUERY = { city: "Dallas", state: "TX", zip: "75201" };

describe("isCorroborated — ONE rule for the label and the veto", () => {
  // These two consumers must never disagree: a row labelled "no city on file" that still blocks Add,
  // or a "Same address" that does not, is the contradiction this function exists to make impossible.
  it("counts a distance reading on its own", () => {
    expect(isCorroborated(match({ distanceMeters: 12, city: null, state: null, zip: null }), null)).toBe(true);
  });

  it("counts a ZIP, or a city WITH its state, when the QUERY has one to agree with", () => {
    expect(isCorroborated(match({ distanceMeters: null, city: null, state: null, zip: "75201" }), QUERY)).toBe(true);
    expect(isCorroborated(match({ distanceMeters: null, city: "Dallas", state: "TX", zip: null }), QUERY)).toBe(true);
  });

  it("does NOT corroborate when the geocode returned no locality at all", () => {
    // parseMapboxFeatures permits a street line with no city. The candidate's own ZIP then agrees with
    // nothing — the server's check is "cannot disprove", so it has not agreed either.
    expect(
      isCorroborated(match({ distanceMeters: null, city: "Austin", state: "TX", zip: "78701" }), null),
    ).toBe(false);
  });

  it("does NOT count a state on its own", () => {
    // "TX" agrees with every "100 Main St" in Texas. Because this verdict can veto creating a building,
    // one such row would block the rep from adding the real one however often they rejected it.
    expect(isCorroborated(match({ distanceMeters: null, city: null, state: "TX", zip: null }), QUERY)).toBe(false);
  });

  it("does not count a bare city either", () => {
    expect(isCorroborated(match({ distanceMeters: null, city: "Springfield", state: null, zip: null }), QUERY)).toBe(false);
  });

  it("is false for a row with neither — the phantom that must not veto", () => {
    expect(isCorroborated(match({ distanceMeters: null, city: null, state: null, zip: null }))).toBe(false);
  });
});

describe("isCorroborated — a bounding-box corner is not proximity", () => {
  it("does not treat an out-of-radius distance as corroboration", () => {
    // The box returns rows up to ~283 m at its corners, but only <=200 m earns the "distance" reason.
    // Counting the rest let a property a block away veto adding the building underfoot.
    expect(isCorroborated(match({ distanceMeters: 260, city: null, state: null, zip: null }), null)).toBe(false);
  });

  it("still counts a distance inside the radius", () => {
    expect(isCorroborated(match({ distanceMeters: 200, city: null, state: null, zip: null }), null)).toBe(true);
  });
});

describe("selectable vs advisory matches", () => {
  // The rule match-service.ts states and this enforces: when unsure, MISS. An address hit with no
  // locality and no coordinates is unsure — "100 Main St" is in every town — so it may be SHOWN but
  // must not be a one-tap target, because the tap attaches this visit and everything after it.
  const isSelectable = (m: PropertyMatch) => m.addressMatch === null || isCorroborated(m, QUERY);

  it("keeps an uncorroborated address hit OUT of the tappable list", () => {
    expect(
      isSelectable(match({ addressMatch: "exact", distanceMeters: null, city: null, state: null, zip: null })),
    ).toBe(false);
  });

  it("keeps a corroborated address hit selectable", () => {
    expect(
      isSelectable(match({ addressMatch: "exact", distanceMeters: null, city: "Dallas", state: "TX", zip: "75201" })),
    ).toBe(true);
  });

  it("keeps a proximity-only hit selectable — distance IS the corroboration", () => {
    // These reached the list by being within the radius, so they are not the unsure case.
    expect(
      isSelectable(match({ addressMatch: null, distanceMeters: 40, city: null, state: null, zip: null })),
    ).toBe(true);
  });
});
