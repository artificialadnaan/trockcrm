// Date/time formatting reads the process's local timezone (deliberately — see walk-meta.ts's header:
// the estimator's own wall-clock time is the point). Pin TZ so the formatted strings asserted below are
// reproducible on any machine/CI runner, not just one that happens to be on US Central time. Node reads
// process.env.TZ per Date call (not cached at startup), so setting it here — before any Date is
// constructed — is sufficient; nothing else in the suite depends on the host timezone.
process.env.TZ = "America/Chicago";

import { deriveWalkSiteLabel, deriveWalkTitle } from "../walk-meta";

// 2026-07-31T02:15:00Z is 2026-07-30, 9:15 PM in America/Chicago (CDT, UTC-5) — the exact example from
// the design doc's owner decision on auto-derived titles.
const AT_MS = Date.UTC(2026, 6, 31, 2, 15, 0);

describe("deriveWalkTitle", () => {
  it("appends a day-month-year date and 12-hour time to the target name", () => {
    expect(deriveWalkTitle("Post RE Group - Building C", AT_MS)).toBe(
      "Post RE Group - Building C — 30 Jul 2026, 9:15 PM",
    );
  });

  it("pads single-digit minutes and uses the target name verbatim", () => {
    const at = Date.UTC(2026, 0, 5, 15, 5, 0); // 2026-01-05T15:05:00Z -> 9:05 AM Central
    expect(deriveWalkTitle("123 Main St", at)).toBe("123 Main St — 5 Jan 2026, 9:05 AM");
  });

  it("clamps an unreasonably long target name so the server's title cap can never be exceeded", () => {
    const longName = "X".repeat(400);
    const title = deriveWalkTitle(longName, AT_MS);
    expect(title.length).toBeLessThanOrEqual(300);
  });
});

describe("deriveWalkSiteLabel", () => {
  it("returns the trimmed property address when present", () => {
    expect(deriveWalkSiteLabel("  123 Main St, Dallas, TX  ")).toBe("123 Main St, Dallas, TX");
  });

  it("returns an empty string — never null/undefined — when the address is unknown", () => {
    expect(deriveWalkSiteLabel(null)).toBe("");
    expect(deriveWalkSiteLabel(undefined)).toBe("");
  });

  it("treats a whitespace-only address as unknown", () => {
    expect(deriveWalkSiteLabel("   ")).toBe("");
  });

  // property_address is unrestricted free text (not validated at deal-creation), so an imported
  // record can exceed the server's cap even though a normal address never gets close. Without this
  // clamp, a long address would strand an otherwise fully-uploaded walk: the completion call would
  // permanently 400 on siteLabel after every artifact already made it to R2.
  it("clamps an unreasonably long address so the server's siteLabel cap can never be exceeded", () => {
    const longAddress = "1 Some Very Long Rd, ".repeat(30);
    const label = deriveWalkSiteLabel(longAddress);
    expect(label.length).toBeLessThanOrEqual(300);
  });
});
