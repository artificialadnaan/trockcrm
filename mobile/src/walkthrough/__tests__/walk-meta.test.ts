// Every instant below is built with the LOCAL-time Date constructor, never Date.UTC, and that is the
// whole trick that makes these assertions honest.
//
// The formatting under test reads the DEVICE's timezone on purpose (see walk-meta.ts's header: the
// estimator's own wall-clock time is what makes an instant recognizable later). Pinning a zone from
// inside the test file used to stand in for that — `process.env.TZ = "America/Chicago"` — and it does
// not work: under Jest, `process` is the sandboxed copy the test environment installs, so assigning
// TZ on it never reaches the tzset()/ICU invalidation Node does for the real one. On a UTC runner the
// suite formatted UTC and failed, asserting Central; it only ever passed because this machine happens
// to be on Central. Setting TZ for real would mean changing how Jest is LAUNCHED, which is a worse
// trade: it makes one suite's assertions a property of the test command.
//
// So the zone is removed from the question instead. `new Date(y, m, d, h, min)` names a WALL CLOCK,
// and formatting it back reproduces that same wall clock in every zone — which is exactly the
// behaviour being asserted, stated in the form that is true everywhere.
import {
  UNKNOWN_WALK_TIME,
  deriveRecoveredWalkTitle,
  deriveWalkSiteLabel,
  deriveWalkTitle,
} from "../walk-meta";

/** 30 Jul 2026, 9:15 PM local — the exact example from the design doc's owner decision on
 *  auto-derived titles. */
const AT_MS = new Date(2026, 6, 30, 21, 15, 0).getTime();

describe("deriveWalkTitle", () => {
  it("appends a day-month-year date and 12-hour time to the target name", () => {
    expect(deriveWalkTitle("Post RE Group - Building C", AT_MS)).toBe(
      "Post RE Group - Building C — 30 Jul 2026, 9:15 PM",
    );
  });

  it("pads single-digit minutes and uses the target name verbatim", () => {
    const at = new Date(2026, 0, 5, 9, 5, 0).getTime(); // 5 Jan 2026, 9:05 AM local
    expect(deriveWalkTitle("123 Main St", at)).toBe("123 Main St — 5 Jan 2026, 9:05 AM");
  });

  // The one property the wall-clock construction above cannot state on its own: the formatted time
  // is the DEVICE's reading of the instant, not UTC's. Skipped on a runner that is itself on UTC,
  // where the two are the same string and there is nothing to tell apart.
  it("formats the instant in the device's own timezone, not UTC", () => {
    const at = new Date(2026, 6, 30, 21, 15, 0);
    if (at.getTimezoneOffset() === 0) return;
    expect(deriveWalkTitle("Riverside Plaza", at.getTime())).not.toContain(
      at.toISOString().slice(11, 16),
    );
  });

  it("clamps an unreasonably long target name so the server's title cap can never be exceeded", () => {
    const longName = "X".repeat(400);
    const title = deriveWalkTitle(longName, AT_MS);
    expect(title.length).toBeLessThanOrEqual(300);
  });
});

// A recovered walk carries startedAt: null (upload-core's toRecoveredQueuedWalk — there is no
// reducer history to derive one from), and the completion call's capturedAt then falls back to the
// drain moment. So this title is the ONLY place the office learns when the visit happened. When the
// platform reported no file timestamp either, the honest answer is that nobody knows — and stamping
// `now` in its place dates an old site visit to today, with exactly the confidence of a real reading.
describe("deriveRecoveredWalkTitle", () => {
  it("marks the walk as recovered and dates it from the walk's own recorded time", () => {
    expect(deriveRecoveredWalkTitle("121 Preston Oaks", AT_MS)).toBe(
      "121 Preston Oaks (recovered) — 30 Jul 2026, 9:15 PM",
    );
  });

  it("says the time is unknown rather than substituting today", () => {
    const title = deriveRecoveredWalkTitle("121 Preston Oaks", null);
    expect(title).toBe(`121 Preston Oaks (recovered) — ${UNKNOWN_WALK_TIME}`);
    // The specific harm, stated directly: a walk recorded days ago must not arrive at the office
    // wearing today's date. Nothing downstream carries a truthful instant to correct it with.
    expect(title).not.toContain(String(new Date().getFullYear()));
  });

  // The marker and the unknown-time label are both composed BEFORE the clamp, never appended after
  // it. Appending afterwards is how a maximal title goes one character over MAX_TITLE_CHARS and 400s
  // the completion call — after every artifact is already in R2, i.e. at the one point where the
  // failure costs the whole upload and cannot be retried into success.
  it("clamps to the server's title cap with the recovered marker and an unknown time in place", () => {
    expect(deriveRecoveredWalkTitle("X".repeat(400), null).length).toBeLessThanOrEqual(300);
    expect(deriveRecoveredWalkTitle("X".repeat(400), AT_MS).length).toBeLessThanOrEqual(300);
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
