import { describe, expect, it } from "vitest";
import { formatSignedDate } from "./contracts-signed-page";

describe("formatSignedDate", () => {
  it("formats date-only contract signed dates without timezone drift", () => {
    expect(formatSignedDate("2026-05-01")).toBe("May 1, 2026");
  });

  it("formats ISO timestamps with milliseconds", () => {
    expect(formatSignedDate("2026-05-01T00:00:00.000Z")).toBe("May 1, 2026");
  });

  it("formats ISO timestamps without milliseconds", () => {
    expect(formatSignedDate("2026-05-01T18:30:00Z")).toBe("May 1, 2026");
  });

  it("preserves the existing empty value placeholder", () => {
    expect(formatSignedDate(null)).toBe("—");
  });
});
