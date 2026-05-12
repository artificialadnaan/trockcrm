import { describe, expect, it } from "vitest";
import { resolveOfficeCodeFromOffice } from "./offices.js";

describe("resolveOfficeCodeFromOffice", () => {
  it.each([
    [{ slug: "dallas", name: "Dallas" }, "dfw"],
    [{ slug: "dfw", name: "Dallas-Fort Worth" }, "dfw"],
    [{ slug: "atlanta", name: "Atlanta" }, "atl"],
    [{ slug: "atl", name: "Atlanta" }, "atl"],
  ] as const)("maps known office metadata to deal officeCode", (office, expected) => {
    expect(resolveOfficeCodeFromOffice(office)).toBe(expected);
  });

  it("returns null when no active office metadata can be resolved", () => {
    expect(resolveOfficeCodeFromOffice(null)).toBeNull();
    expect(resolveOfficeCodeFromOffice({ slug: "", name: "" })).toBeNull();
  });
});
