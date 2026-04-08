import { describe, expect, it } from "vitest";
import { DIRECTOR_DASHBOARD_ACTIONS } from "./director-dashboard-actions";

describe("DIRECTOR_DASHBOARD_ACTIONS", () => {
  it("defines destinations for every dashboard header action", () => {
    expect(DIRECTOR_DASHBOARD_ACTIONS).toHaveLength(2);
    expect(DIRECTOR_DASHBOARD_ACTIONS.map((action) => action.to)).toEqual([
      "/tasks",
      "/reports",
    ]);
  });

  it("uses accessible labels for every dashboard header action", () => {
    for (const action of DIRECTOR_DASHBOARD_ACTIONS) {
      expect(action.label.trim().length).toBeGreaterThan(0);
      expect(action.title.trim().length).toBeGreaterThan(0);
    }
  });
});
