import { describe, expect, it } from "vitest";
import { getStageRequirementAction } from "./stage-change-dialog";

describe("getStageRequirementAction", () => {
  it("routes scoping field blockers to the scoping workspace", () => {
    expect(
      getStageRequirementAction("deal-1", {
        fields: ["opportunity.bidDueDate"],
        documents: [],
        approvals: [],
      })
    ).toEqual({
      label: "Open Scoping Workspace",
      to: "/deals/deal-1?tab=scoping",
    });
  });

  it("routes CRM file blockers to the files tab", () => {
    expect(
      getStageRequirementAction("deal-1", {
        fields: [],
        documents: ["proposal"],
        approvals: [],
      })
    ).toEqual({
      label: "Open Files",
      to: "/deals/deal-1?tab=files",
    });
  });

  it("routes generic field blockers to the overview tab", () => {
    expect(
      getStageRequirementAction("deal-1", {
        fields: ["expectedCloseDate"],
        documents: [],
        approvals: [],
      })
    ).toEqual({
      label: "Open Overview",
      to: "/deals/deal-1?tab=overview",
    });
  });

  it("returns null when the blocker is approval-only", () => {
    expect(
      getStageRequirementAction("deal-1", {
        fields: [],
        documents: [],
        approvals: ["director"],
      })
    ).toBeNull();
  });
});
