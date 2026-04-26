import { describe, expect, it } from "vitest";
import {
  LEAD_SOURCE_CATEGORIES,
  normalizeLeadSourceInput,
  validateLeadSourceInput,
} from "../../../src/modules/leads/source-control.js";

describe("lead source controls", () => {
  it("strictly maps only case-insensitive exact category names", () => {
    expect(normalizeLeadSourceInput("referral")).toEqual({
      sourceCategory: "Referral",
      sourceDetail: null,
    });
    expect(normalizeLeadSourceInput("Sales Prospecting")).toEqual({
      sourceCategory: "Sales Prospecting",
      sourceDetail: null,
    });
    expect(normalizeLeadSourceInput("referral from client")).toEqual({
      sourceCategory: "Other",
      sourceDetail: "referral from client",
    });
    expect(normalizeLeadSourceInput("trade-show")).toEqual({
      sourceCategory: "Other",
      sourceDetail: "trade-show",
    });
  });

  it("requires source detail only when category is Other", () => {
    expect(LEAD_SOURCE_CATEGORIES).toContain("Other");
    expect(() => validateLeadSourceInput({ sourceCategory: "Referral", sourceDetail: "" })).not.toThrow();
    expect(() => validateLeadSourceInput({ sourceCategory: "Other", sourceDetail: "" })).toThrow(
      /Source detail is required/
    );
    expect(() =>
      validateLeadSourceInput({ sourceCategory: "Other", sourceDetail: "legacy value" })
    ).not.toThrow();
  });
});
