import { describe, expect, it } from "vitest";
import { buildArchivedDescription, businessDateStamp } from "./archive-description.js";

const AT = new Date("2026-07-08T18:00:00Z"); // 1pm America/Chicago (CDT)

describe("businessDateStamp", () => {
  it("formats the America/Chicago calendar day as YYYY-MM-DD", () => {
    expect(businessDateStamp(AT)).toBe("2026-07-08");
    // 00:30 UTC on Jul 9 is still Jul 8 in Chicago
    expect(businessDateStamp(new Date("2026-07-09T00:30:00Z"))).toBe("2026-07-08");
  });
});

describe("buildArchivedDescription", () => {
  it("prepends an archive block above the existing description", () => {
    expect(buildArchivedDescription("Roof scope, 3 buildings.", "Lost to competitor", AT)).toBe(
      "[Archived 2026-07-08 — Lost to competitor]\n\nRoof scope, 3 buildings."
    );
  });

  it("returns just the block when there is no prior description", () => {
    expect(buildArchivedDescription(null, "Duplicate", AT)).toBe("[Archived 2026-07-08 — Duplicate]");
    expect(buildArchivedDescription("   ", "Duplicate", AT)).toBe("[Archived 2026-07-08 — Duplicate]");
  });

  it("trims the reason", () => {
    expect(buildArchivedDescription(null, "  spaced  ", AT)).toBe("[Archived 2026-07-08 — spaced]");
  });

  it("preserves newlines in the reason without collapsing them", () => {
    expect(buildArchivedDescription(null, "Line1\nLine2", AT)).toBe(
      "[Archived 2026-07-08 — Line1\nLine2]"
    );
  });
});
