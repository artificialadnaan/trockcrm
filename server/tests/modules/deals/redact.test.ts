import { describe, expect, it } from "vitest";
import {
  redactDealList,
  redactDealResponse,
  shouldIncludeHubspotId,
} from "../../../src/modules/deals/redact";

describe("shouldIncludeHubspotId", () => {
  it("returns true only when admin AND query opts in", () => {
    expect(shouldIncludeHubspotId({ includeHubspotId: "true" }, "admin")).toBe(true);
    expect(shouldIncludeHubspotId({ includeHubspotId: "1" }, "admin")).toBe(true);
  });

  it("blocks non-admin even when query opts in", () => {
    expect(shouldIncludeHubspotId({ includeHubspotId: "true" }, "rep")).toBe(false);
    expect(shouldIncludeHubspotId({ includeHubspotId: "true" }, "director")).toBe(false);
  });

  it("returns false when query does not opt in", () => {
    expect(shouldIncludeHubspotId({}, "admin")).toBe(false);
    expect(shouldIncludeHubspotId({ includeHubspotId: "false" }, "admin")).toBe(false);
    expect(shouldIncludeHubspotId({ includeHubspotId: "yes" }, "admin")).toBe(false);
  });
});

describe("redactDealResponse", () => {
  it("strips hubspotDealId from the response by default", () => {
    const result = redactDealResponse(
      { id: "deal-1", name: "Steeplechase", hubspotDealId: "HS-324283495135", projectNumber: "ATL-2-12826-AH" },
      { includeHubspotId: false }
    );
    expect(result).not.toHaveProperty("hubspotDealId");
    expect(result.id).toBe("deal-1");
    expect(result.projectNumber).toBe("ATL-2-12826-AH");
  });

  it("preserves hubspotDealId when includeHubspotId is true", () => {
    const result = redactDealResponse(
      { id: "deal-1", hubspotDealId: "HS-324283495135" },
      { includeHubspotId: true }
    );
    expect(result.hubspotDealId).toBe("HS-324283495135");
  });

  it("is a no-op when the deal has no hubspotDealId property", () => {
    const result = redactDealResponse({ id: "deal-1", name: "Native deal" }, { includeHubspotId: false });
    expect(result).toEqual({ id: "deal-1", name: "Native deal" });
  });
});

describe("redactDealList", () => {
  it("redacts hubspotDealId from every deal in the list", () => {
    const deals = [
      { id: "d1", hubspotDealId: "HS-1" },
      { id: "d2", hubspotDealId: null },
      { id: "d3", hubspotDealId: "HS-3" },
    ];
    const result = redactDealList(deals, { includeHubspotId: false });
    for (const deal of result) {
      expect(deal).not.toHaveProperty("hubspotDealId");
    }
    expect(result.map((d) => d.id)).toEqual(["d1", "d2", "d3"]);
  });

  it("preserves hubspotDealId on every deal when opted in", () => {
    const deals = [{ id: "d1", hubspotDealId: "HS-1" }];
    const result = redactDealList(deals, { includeHubspotId: true });
    expect(result[0].hubspotDealId).toBe("HS-1");
  });
});
