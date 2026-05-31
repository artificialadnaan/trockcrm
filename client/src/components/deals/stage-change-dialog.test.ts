import { describe, expect, it } from "vitest";
import {
  getStageChangeDialogSemantics,
  getStageRequirementAction,
  isExpectedCloseDateSoleGateBlocker,
  isGateResolvedByInlineCloseDate,
} from "./stage-change-dialog";

describe("isExpectedCloseDateSoleGateBlocker", () => {
  it("is true when expectedCloseDate is the ONLY missing field and nothing else blocks", () => {
    expect(
      isExpectedCloseDateSoleGateBlocker(
        { fields: ["expectedCloseDate"], documents: [], approvals: [] },
        false,
        "estimating"
      )
    ).toBe(true);
  });

  it("is false when another field is also missing", () => {
    expect(
      isExpectedCloseDateSoleGateBlocker(
        { fields: ["expectedCloseDate", "opportunity.bidDueDate"], documents: [], approvals: [] },
        false,
        "estimating"
      )
    ).toBe(false);
  });

  it("is false when a document or approval also blocks", () => {
    expect(
      isExpectedCloseDateSoleGateBlocker(
        { fields: ["expectedCloseDate"], documents: ["proposal"], approvals: [] },
        false,
        "estimating"
      )
    ).toBe(false);
    expect(
      isExpectedCloseDateSoleGateBlocker(
        { fields: ["expectedCloseDate"], documents: [], approvals: ["director"] },
        false,
        "estimating"
      )
    ).toBe(false);
  });

  it("is false for a backward move (override is for the direction, the date can't clear it)", () => {
    expect(
      isExpectedCloseDateSoleGateBlocker(
        { fields: ["expectedCloseDate"], documents: [], approvals: [] },
        true,
        "estimating"
      )
    ).toBe(false);
  });

  it("is false from the close_out stage: a won move can require an override from the close-out checklist (server stage-gate Rule 2) that the inline date does NOT clear — and that override source is invisible to missingRequirements", () => {
    expect(
      isExpectedCloseDateSoleGateBlocker(
        { fields: ["expectedCloseDate"], documents: [], approvals: [] },
        false,
        "close_out"
      )
    ).toBe(false);
  });

  it("is false when expectedCloseDate isn't among the missing fields", () => {
    expect(isExpectedCloseDateSoleGateBlocker({ fields: [], documents: [], approvals: [] }, false, "estimating")).toBe(false);
    expect(isExpectedCloseDateSoleGateBlocker(null, false, "estimating")).toBe(false);
    expect(isExpectedCloseDateSoleGateBlocker(undefined, false, "estimating")).toBe(false);
  });
});

describe("isGateResolvedByInlineCloseDate", () => {
  const today = "2026-05-31";

  it("is true when ECD is the sole blocker AND the supplied date is usable (today-or-future)", () => {
    expect(
      isGateResolvedByInlineCloseDate(
        { fields: ["expectedCloseDate"], documents: [], approvals: [] },
        false,
        "estimating",
        "2026-12-01",
        today
      )
    ).toBe(true);
    // today itself counts as usable
    expect(
      isGateResolvedByInlineCloseDate(
        { fields: ["expectedCloseDate"], documents: [], approvals: [] },
        false,
        "estimating",
        today,
        today
      )
    ).toBe(true);
  });

  it("is false when no date (or an empty date) has been supplied", () => {
    expect(
      isGateResolvedByInlineCloseDate(
        { fields: ["expectedCloseDate"], documents: [], approvals: [] },
        false,
        "estimating",
        "",
        today
      )
    ).toBe(false);
  });

  it("is false when the supplied date is in the past", () => {
    expect(
      isGateResolvedByInlineCloseDate(
        { fields: ["expectedCloseDate"], documents: [], approvals: [] },
        false,
        "estimating",
        "2020-01-01",
        today
      )
    ).toBe(false);
  });

  it("is false when something other than the date also blocks (the date can't clear those)", () => {
    expect(
      isGateResolvedByInlineCloseDate(
        { fields: ["expectedCloseDate", "opportunity.bidDueDate"], documents: [], approvals: [] },
        false,
        "estimating",
        "2026-12-01",
        today
      )
    ).toBe(false);
  });

  it("is false from close_out even with a usable date (the close-out-checklist override isn't cleared by the date)", () => {
    expect(
      isGateResolvedByInlineCloseDate(
        { fields: ["expectedCloseDate"], documents: [], approvals: [] },
        false,
        "close_out",
        "2026-12-01",
        today
      )
    ).toBe(false);
  });
});

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

describe("getStageChangeDialogSemantics", () => {
  it("treats won and lost as canonical terminal transitions", () => {
    expect(getStageChangeDialogSemantics("won")).toMatchObject({
      isClosedWon: true,
      isClosedLost: false,
      shouldForceCompletion: false,
    });
    expect(getStageChangeDialogSemantics("lost")).toMatchObject({
      isClosedWon: false,
      isClosedLost: true,
      shouldForceCompletion: true,
    });
  });

  it("keeps historical terminal aliases working", () => {
    expect(getStageChangeDialogSemantics("sent_to_production")).toMatchObject({ isClosedWon: true });
    expect(getStageChangeDialogSemantics("service_lost")).toMatchObject({
      isClosedLost: true,
      shouldForceCompletion: true,
    });
  });
});
