// @vitest-environment jsdom
//
// The Daily Activity Log is limited to a named allowlist (DAILY_ACTIVITY_LOG_VIEWER_EMAILS). These cases pin
// the CLIENT half of that gate: the report index must not offer a card the viewer cannot open, and the
// category tally must agree with the grid beneath it. The server enforces the allowlist on the endpoint —
// hiding the card is courtesy, not the boundary.
import { describe, expect, it } from "vitest";
import { visibleReportCategories } from "./reports-page";

const DAILY_ACTIVITY_LOG = "Daily Activity Log";

function cardNames(ctx: Parameters<typeof visibleReportCategories>[0]) {
  return visibleReportCategories(ctx).flatMap((group) => group.reports.map((report) => report.name));
}

describe("visibleReportCategories", () => {
  it("offers the Daily Activity Log to a flagged viewer", () => {
    expect(cardNames({ canViewDailyActivityLog: true })).toContain(DAILY_ACTIVITY_LOG);
  });

  it("hides it from a viewer the server did not flag", () => {
    expect(cardNames({ canViewDailyActivityLog: false })).not.toContain(DAILY_ACTIVITY_LOG);
  });

  // An older client bundle, or a session minted before the flag existed, sends no flag at all. Absent must
  // read as "no" — the endpoint would 403 anyway, so offering the card would only produce a dead link.
  it("hides it when the flag is absent entirely", () => {
    expect(cardNames({})).not.toContain(DAILY_ACTIVITY_LOG);
    expect(cardNames({ canViewDailyActivityLog: undefined })).not.toContain(DAILY_ACTIVITY_LOG);
  });

  it("removes only that card — every other report still shows", () => {
    const allowed = cardNames({ canViewDailyActivityLog: true });
    const denied = cardNames({ canViewDailyActivityLog: false });
    expect(denied).toEqual(allowed.filter((name) => name !== DAILY_ACTIVITY_LOG));
    expect(denied).toContain("Rep Activity");
    expect(denied).toContain("Director Scorecard");
  });

  // The page prints group.reports.length as the headline count for each category. If the tally were taken
  // from the unfiltered list it would advertise 5 Performance reports while rendering 4.
  it("keeps each category's count equal to the cards it actually renders", () => {
    for (const group of visibleReportCategories({ canViewDailyActivityLog: false })) {
      expect(group.reports.length).toBeGreaterThan(0);
      expect(group.reports.some((report) => report.name === DAILY_ACTIVITY_LOG)).toBe(false);
    }
    const performance = visibleReportCategories({ canViewDailyActivityLog: false }).find(
      (group) => group.category === "Performance"
    );
    const performanceAllowed = visibleReportCategories({ canViewDailyActivityLog: true }).find(
      (group) => group.category === "Performance"
    );
    expect(performance?.reports.length).toBe((performanceAllowed?.reports.length ?? 0) - 1);
  });
});
