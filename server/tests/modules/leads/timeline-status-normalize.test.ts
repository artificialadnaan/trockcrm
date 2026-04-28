import { describe, expect, it } from "vitest";
import {
  isBlankTimelineStatusValue,
  isLegacyTimelineStatusValue,
  isValidIsoDate,
  normalizeTimelineStatusForSave,
} from "@trock-crm/shared/types";

describe("normalizeTimelineStatusForSave", () => {
  it("returns null for empty string", () => {
    expect(normalizeTimelineStatusForSave("")).toBeNull();
  });

  it("returns null for whitespace-only", () => {
    expect(normalizeTimelineStatusForSave("   ")).toBeNull();
    expect(normalizeTimelineStatusForSave("\t\n  ")).toBeNull();
  });

  it("returns null for undefined and null", () => {
    expect(normalizeTimelineStatusForSave(undefined)).toBeNull();
    expect(normalizeTimelineStatusForSave(null)).toBeNull();
  });

  it("trims whitespace-padded valid date and returns it normalized", () => {
    expect(normalizeTimelineStatusForSave("  2026-09-15  ")).toBe("2026-09-15");
    expect(normalizeTimelineStatusForSave("\n2026-12-31\t")).toBe("2026-12-31");
  });

  it("returns already-normalized YYYY-MM-DD unchanged", () => {
    expect(normalizeTimelineStatusForSave("2026-09-15")).toBe("2026-09-15");
    expect(normalizeTimelineStatusForSave("2027-01-01")).toBe("2027-01-01");
  });

  it("rejects legacy freeform values", () => {
    expect(normalizeTimelineStatusForSave("Q1 2026")).toBeNull();
    expect(normalizeTimelineStatusForSave("next quarter")).toBeNull();
    expect(normalizeTimelineStatusForSave("ASAP")).toBeNull();
  });

  it("rejects alternate date formats", () => {
    expect(normalizeTimelineStatusForSave("2026/09/15")).toBeNull();
    expect(normalizeTimelineStatusForSave("09/15/2026")).toBeNull();
    expect(normalizeTimelineStatusForSave("Sep 15 2026")).toBeNull();
    expect(normalizeTimelineStatusForSave("2026-9-15")).toBeNull();
    expect(normalizeTimelineStatusForSave("26-09-15")).toBeNull();
  });

  it("rejects partial inputs", () => {
    expect(normalizeTimelineStatusForSave("2026")).toBeNull();
    expect(normalizeTimelineStatusForSave("2026-09")).toBeNull();
    expect(normalizeTimelineStatusForSave("2026-09-")).toBeNull();
  });

  it("rejects non-string inputs", () => {
    expect(normalizeTimelineStatusForSave(20260915)).toBeNull();
    expect(normalizeTimelineStatusForSave(true)).toBeNull();
    expect(normalizeTimelineStatusForSave({ date: "2026-09-15" })).toBeNull();
  });

  it("is idempotent", () => {
    const once = normalizeTimelineStatusForSave("  2026-09-15  ");
    const twice = normalizeTimelineStatusForSave(once);
    expect(twice).toBe("2026-09-15");
  });
});

describe("isLegacyTimelineStatusValue", () => {
  it("treats blank as not legacy (it's just empty)", () => {
    expect(isLegacyTimelineStatusValue("")).toBe(false);
    expect(isLegacyTimelineStatusValue("   ")).toBe(false);
    expect(isLegacyTimelineStatusValue(null)).toBe(false);
    expect(isLegacyTimelineStatusValue(undefined)).toBe(false);
  });

  it("treats valid ISO dates as not legacy", () => {
    expect(isLegacyTimelineStatusValue("2026-09-15")).toBe(false);
    expect(isLegacyTimelineStatusValue("  2026-09-15  ")).toBe(false);
  });

  it("flags legacy freeform text", () => {
    expect(isLegacyTimelineStatusValue("Q1 2026")).toBe(true);
    expect(isLegacyTimelineStatusValue("next quarter")).toBe(true);
    expect(isLegacyTimelineStatusValue("2026/09/15")).toBe(true);
  });
});

describe("isBlankTimelineStatusValue", () => {
  it("matches empty / whitespace / null / undefined", () => {
    expect(isBlankTimelineStatusValue("")).toBe(true);
    expect(isBlankTimelineStatusValue("  \t")).toBe(true);
    expect(isBlankTimelineStatusValue(null)).toBe(true);
    expect(isBlankTimelineStatusValue(undefined)).toBe(true);
  });

  it("does not match populated strings", () => {
    expect(isBlankTimelineStatusValue("2026-09-15")).toBe(false);
    expect(isBlankTimelineStatusValue("Q1")).toBe(false);
  });
});

describe("isValidIsoDate", () => {
  it("matches YYYY-MM-DD with optional surrounding whitespace", () => {
    expect(isValidIsoDate("2026-09-15")).toBe(true);
    expect(isValidIsoDate("  2026-09-15  ")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isValidIsoDate("Q1 2026")).toBe(false);
    expect(isValidIsoDate("2026/09/15")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
    expect(isValidIsoDate(20260915)).toBe(false);
  });
});
