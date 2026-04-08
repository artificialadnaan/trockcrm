import { describe, expect, it } from "vitest";
import { getScheduleReportActionConfig } from "./report-actions";

describe("getScheduleReportActionConfig", () => {
  it("keeps the schedule report action disabled until scheduling exists", () => {
    expect(getScheduleReportActionConfig()).toEqual({
      label: "Schedule Report (Coming Soon)",
      disabled: true,
      title: "Report scheduling is not available yet.",
    });
  });
});
