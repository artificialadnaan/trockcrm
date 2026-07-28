import { describe, it, expect } from "vitest";
import { parseFileDateParam } from "../../../src/modules/files/file-constants.js";

describe("parseFileDateParam", () => {
  it("accepts a date-only YYYY-MM-DD", () => {
    expect(parseFileDateParam("2026-07-10")).toBe("2026-07-10");
  });
  it("accepts a full ISO timestamp", () => {
    expect(parseFileDateParam("2026-07-10T23:30:00Z")).toBe("2026-07-10T23:30:00Z");
  });
  it("trims surrounding whitespace", () => {
    expect(parseFileDateParam("  2026-07-10  ")).toBe("2026-07-10");
  });
  it("rejects a month-overflow date", () => {
    expect(parseFileDateParam("2026-13-45")).toBeUndefined();
  });
  it("rejects calendar day-overflow dates (Date.parse silently rolls these over)", () => {
    expect(parseFileDateParam("2026-02-30")).toBeUndefined();
    expect(parseFileDateParam("2026-04-31")).toBeUndefined();
  });
  it("rejects ECMAScript reduced-precision forms (Date.parse accepts, the SQL ::date cast rejects)", () => {
    expect(parseFileDateParam("2026")).toBeUndefined();
    expect(parseFileDateParam("2026-07")).toBeUndefined();
  });
  it("rejects malformed / empty / non-string input", () => {
    expect(parseFileDateParam("garbage")).toBeUndefined();
    expect(parseFileDateParam("")).toBeUndefined();
    expect(parseFileDateParam(undefined)).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseFileDateParam(12345 as any)).toBeUndefined();
  });
});

/**
 * `Date.parse` is necessary but not sufficient. It NORMALIZES calendar overflow and reports success,
 * while Postgres rejects the original string when the value is cast to timestamptz — so these used to
 * pass validation and then 500 at the cast, which is exactly what this helper exists to prevent.
 */
describe("parseFileDateParam — full timestamps with calendar overflow", () => {
  it("rejects an overflowing day in a full ISO timestamp (Date.parse silently rolls it over)", () => {
    // Date.parse accepts this and yields March 2nd; Postgres raises 'date/time field value out of range'.
    expect(Date.isNaN?.(0) ?? Number.isNaN(Date.parse("2026-02-30T00:00:00Z"))).toBe(false);
    expect(parseFileDateParam("2026-02-30T00:00:00Z")).toBeUndefined();
    expect(parseFileDateParam("2026-04-31T12:00:00.000Z")).toBeUndefined();
    expect(parseFileDateParam("2026-13-01T00:00:00Z")).toBeUndefined();
  });

  it("still accepts the ISO timestamps the feed client actually sends", () => {
    expect(parseFileDateParam("2026-07-27T00:00:00.000Z")).toBe("2026-07-27T00:00:00.000Z");
    expect(parseFileDateParam("2026-02-28T23:59:59.999Z")).toBe("2026-02-28T23:59:59.999Z");
    // Leap day in a real leap year.
    expect(parseFileDateParam("2028-02-29T00:00:00Z")).toBe("2028-02-29T00:00:00Z");
  });
});

/**
 * The bounds Postgres applies that `Date.parse` does not. Both were found by sweeping this validator
 * against a real `::timestamptz` cast: of 20,162 candidates it accepted 20,160, and Postgres rejected
 * 55 of those — 2 for year zero (one per branch of this function) and 53 for a timezone offset past
 * ±15:59. Each case below is paired with a NEIGHBOURING value that must still be accepted, so the fix
 * cannot degrade into "reject more things".
 */
describe("parseFileDateParam — Postgres year and timezone-offset bounds", () => {
  it("rejects year zero in BOTH the date-only and datetime branches", () => {
    // Postgres uses the proleptic Gregorian calendar (no year 0); JavaScript's Date has one, accepts it,
    // and round-trips it faithfully — so the calendar check alone cannot catch it.
    expect(parseFileDateParam("0000-01-01")).toBeUndefined();
    expect(parseFileDateParam("0000-01-01T00:00:00Z")).toBeUndefined();
  });

  it("still accepts year 0001, so the guard is year-zero-specific and not 'old dates'", () => {
    expect(parseFileDateParam("0001-01-01")).toBe("0001-01-01");
    expect(parseFileDateParam("0001-01-01T00:00:00Z")).toBe("0001-01-01T00:00:00Z");
  });

  it("rejects timezone offsets beyond Postgres's ±15:59 limit", () => {
    // Date.parse accepts offsets out to ±23:59.
    expect(parseFileDateParam("2026-07-27T12:00:00+16:00")).toBeUndefined();
    expect(parseFileDateParam("2026-07-27T12:00:00+16:30")).toBeUndefined();
    expect(parseFileDateParam("2026-07-27T12:00:00-16:59")).toBeUndefined();
  });

  it("still accepts the boundary offset ±15:59 and the ordinary forms", () => {
    // The control: one minute inside the limit must survive, or this is a broader rejection wearing a
    // specific fix's clothes.
    expect(parseFileDateParam("2026-07-27T12:00:00+15:59")).toBe("2026-07-27T12:00:00+15:59");
    expect(parseFileDateParam("2026-07-27T12:00:00-15:59")).toBe("2026-07-27T12:00:00-15:59");
    expect(parseFileDateParam("2026-07-27T12:00:00Z")).toBe("2026-07-27T12:00:00Z");
    expect(parseFileDateParam("2026-07-27T12:00:00+00:00")).toBe("2026-07-27T12:00:00+00:00");
    expect(parseFileDateParam("2026-07-27T12:00:00-05:00")).toBe("2026-07-27T12:00:00-05:00");
  });
});
