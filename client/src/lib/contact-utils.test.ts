import { describe, expect, it } from "vitest";
import { getContactCompanyName } from "./contact-utils";

describe("getContactCompanyName", () => {
  it("prefers the resolved linked company name over the free-text companyName", () => {
    expect(
      getContactCompanyName({ linkedCompanyName: "Avenue5 Residential", companyName: "Stale Inc" }, "Unassigned")
    ).toBe("Avenue5 Residential");
  });

  it("resolves the linked name even when the free-text companyName is null (the reported bug)", () => {
    expect(
      getContactCompanyName({ linkedCompanyName: "Avenue5 Residential", companyName: null }, "Unassigned")
    ).toBe("Avenue5 Residential");
  });

  it("falls back to the free-text companyName when there is no linked name", () => {
    expect(getContactCompanyName({ linkedCompanyName: null, companyName: "Manual Co" }, "Unassigned")).toBe("Manual Co");
    // linkedCompanyName may be omitted entirely (optional field) — same outcome.
    expect(getContactCompanyName({ companyName: "Manual Co" }, "Unassigned")).toBe("Manual Co");
  });

  it("returns the fallback when neither a linked nor a free-text name is present", () => {
    expect(getContactCompanyName({ linkedCompanyName: null, companyName: null }, "Unassigned")).toBe("Unassigned");
    expect(getContactCompanyName({ linkedCompanyName: null, companyName: null }, "Unknown company")).toBe("Unknown company");
  });

  it("returns null (not a fallback string) when no fallback is supplied — for callers that drop empties", () => {
    expect(getContactCompanyName({ linkedCompanyName: null, companyName: null })).toBeNull();
  });
});
