import { describe, expect, it } from "vitest";
import { getOfficeTimezone, isOfficeLocalSendDue } from "../../src/lib/office-timezone.js";

describe("office timezone helpers", () => {
  it("defaults missing office timezones to America/Chicago", () => {
    expect(getOfficeTimezone(null)).toBe("America/Chicago");
    expect(getOfficeTimezone({})).toBe("America/Chicago");
    expect(getOfficeTimezone({ timezone: "" })).toBe("America/Chicago");
  });

  it("rejects an explicit invalid office timezone", () => {
    expect(() => getOfficeTimezone({ timezone: "Not/AZone" })).toThrow("Invalid office timezone");
  });

  it("treats 8:00 AM in the office timezone as due", () => {
    expect(
      isOfficeLocalSendDue({
        timezone: "America/Chicago",
        nowUtc: new Date("2026-04-16T13:00:00.000Z"),
        targetHour: 8,
      })
    ).toBe(true);
  });
});
