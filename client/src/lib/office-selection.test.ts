import { describe, expect, it } from "vitest";
import {
  buildOfficeSelectionOptions,
  getOfficeRequestOptions,
  resolveDefaultOfficeCode,
} from "./office-selection";

describe("office selection helpers", () => {
  const offices = [
    { id: "office-dallas", name: "Dallas", slug: "dallas" },
    { id: "office-atlanta", name: "Atlanta", slug: "atlanta" },
    { id: "office-test", name: "Test Office", slug: "test" },
  ];

  it("exposes only DFW and ATL with stable display labels", () => {
    expect(buildOfficeSelectionOptions(offices)).toEqual([
      { code: "dfw", label: "DFW (Dallas)", officeId: "office-dallas" },
      { code: "atl", label: "ATL (Atlanta)", officeId: "office-atlanta" },
    ]);
  });

  it("defaults to the active office code when the active office is known", () => {
    expect(resolveDefaultOfficeCode({ offices, activeOfficeId: "office-atlanta", currentOfficeCode: "" })).toBe("atl");
  });

  it("keeps a user's manual selection stable after offices refetch", () => {
    expect(resolveDefaultOfficeCode({ offices, activeOfficeId: "office-dallas", currentOfficeCode: "atl" })).toBe("atl");
  });

  it("builds the tenant routing header from the selected office id", () => {
    expect(getOfficeRequestOptions("office-atlanta")).toEqual({
      headers: { "x-office-id": "office-atlanta" },
    });
  });
});
