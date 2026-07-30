import { isHubspotImportedDealNumber, resolveDealDisplayNumber, sanitizeHubspotDealIdentifiers } from "../deal-display-number";

describe("the human-facing deal number", () => {
  it("prefers the canonical project number", () => {
    expect(
      resolveDealDisplayNumber({ projectNumber: "DFW-1-09026-af", dealNumber: "HS-318900588242" }),
    ).toBe("DFW-1-09026-af");
  });

  it("falls back to the deal number for a BID-BOARD deal, whose projectNumber is EMPTY", () => {
    // The case `projectNumber ?? dealNumber` gets wrong: "" is not nullish, so it wins and the real
    // number is thrown away. This is why the rule cannot be a coalesce.
    expect(resolveDealDisplayNumber({ projectNumber: "", dealNumber: "BB-4417" })).toBe("BB-4417");
    expect(resolveDealDisplayNumber({ projectNumber: "   ", dealNumber: "BB-4417" })).toBe("BB-4417");
  });

  it("NEVER shows a HubSpot id", () => {
    // The other direction the coalesce gets wrong: with no project number it falls straight through
    // to an internal identifier and puts it on screen.
    expect(resolveDealDisplayNumber({ projectNumber: null, dealNumber: "HS-204627995347" })).toBeNull();
    expect(resolveDealDisplayNumber({ projectNumber: "", dealNumber: "hs_9999" })).toBeNull();
  });

  it("returns null when there is no number yet, so the caller can omit it", () => {
    expect(resolveDealDisplayNumber({ projectNumber: null, dealNumber: null })).toBeNull();
    expect(resolveDealDisplayNumber({})).toBeNull();
  });

  it("recognises the HubSpot forms the shared resolver does", () => {
    expect(isHubspotImportedDealNumber("HS-318900588242")).toBe(true);
    expect(isHubspotImportedDealNumber("  HS-9999  ")).toBe(true);
    expect(isHubspotImportedDealNumber("BB-4417")).toBe(false);
    expect(isHubspotImportedDealNumber(null)).toBe(false);
  });
});

describe("HubSpot identifiers embedded in generated prose", () => {
  it("replaces the raw id the close-date rule interpolates into a task title", () => {
    // The real shape, from server/src/modules/tasks: the rule builds the sentence from
    // `context.dealNumber`, so the title publishes an id the deal-number field correctly suppresses.
    expect(sanitizeHubspotDealIdentifiers("Follow up: HS-323641734879 closes 2026-05-08")).toBe(
      "Follow up: Project pending closes 2026-05-08"
    );
  });

  it("handles every separator the pattern allows, anywhere in the string", () => {
    expect(sanitizeHubspotDealIdentifiers("HS-324283495135 needs pricing")).toBe(
      "Project pending needs pricing"
    );
    expect(sanitizeHubspotDealIdentifiers("call about hs_324283495135")).toBe(
      "call about Project pending"
    );
    expect(sanitizeHubspotDealIdentifiers("re: HS 324283495135")).toBe("re: Project pending");
  });

  it("replaces every occurrence, not just the first", () => {
    expect(sanitizeHubspotDealIdentifiers("HS-324283495135 vs HS-323641734879")).toBe(
      "Project pending vs Project pending"
    );
  });

  it("leaves a real project number alone", () => {
    // The whole point is that only HubSpot's imported ids are internal. A T-Rock project number is
    // the number people say out loud.
    expect(sanitizeHubspotDealIdentifiers("Follow up: 24-1180 closes Friday")).toBe(
      "Follow up: 24-1180 closes Friday"
    );
  });

  it("does not eat a short HS token that means something else", () => {
    // The six-digit floor. "HS-2" is not a HubSpot import id, and swallowing it would corrupt a title
    // to hide something that was never exposed.
    expect(sanitizeHubspotDealIdentifiers("Bay HS-2 punch list")).toBe("Bay HS-2 punch list");
  });

  it("returns an empty string for nothing, so a caller can fall back", () => {
    expect(sanitizeHubspotDealIdentifiers(null)).toBe("");
    expect(sanitizeHubspotDealIdentifiers(undefined)).toBe("");
    expect(sanitizeHubspotDealIdentifiers("   ")).toBe("");
  });

  it("agrees with the field-level resolver about what counts as HubSpot", () => {
    // Two rules, one idea. If these ever disagree, one surface starts leaking what the other hides.
    const raw = "HS-324283495135";
    expect(isHubspotImportedDealNumber(raw)).toBe(true);
    expect(sanitizeHubspotDealIdentifiers(`Follow up: ${raw}`)).not.toContain(raw);
  });
});
