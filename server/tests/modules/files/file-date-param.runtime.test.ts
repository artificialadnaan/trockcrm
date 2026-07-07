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
