import { eligibleStageTargets, isStageValidForWorkflowRoute } from "../stage-targets";

const stage = (over: Partial<Parameters<typeof eligibleStageTargets>[0][number]> = {}) => ({
  id: over.id ?? "s1",
  slug: over.slug ?? "estimating",
  workflowFamily: over.workflowFamily ?? "standard_deal",
  isActivePipeline: over.isActivePipeline ?? true,
});

describe("isStageValidForWorkflowRoute", () => {
  it("accepts a stage of the deal's own family", () => {
    expect(isStageValidForWorkflowRoute({ slug: "estimating", workflowFamily: "standard_deal" }, "normal")).toBe(true);
    expect(
      isStageValidForWorkflowRoute({ slug: "service_estimating", workflowFamily: "service_deal" }, "service"),
    ).toBe(true);
  });

  it("never offers a lead-family stage to a deal", () => {
    expect(isStageValidForWorkflowRoute({ slug: "qualified", workflowFamily: "lead" }, "normal")).toBe(false);
    expect(isStageValidForWorkflowRoute({ slug: "qualified", workflowFamily: "lead" }, "service")).toBe(false);
  });

  it("treats an absent family as unconstrained, matching the server", () => {
    expect(isStageValidForWorkflowRoute({ slug: "estimating", workflowFamily: null }, "normal")).toBe(true);
    expect(isStageValidForWorkflowRoute({ slug: "estimating" }, "service")).toBe(true);
  });

  /**
   * The asymmetry, pinned in both directions. A symmetric family check passes the first block and fails
   * the second — which is exactly the plausible-looking bug this helper exists to prevent.
   */
  it("lets a SERVICE deal use the shared canonical standard-family stages", () => {
    for (const slug of ["opportunity", "estimate_under_review", "estimate_sent_to_client", "contract", "won", "lost"]) {
      expect(isStageValidForWorkflowRoute({ slug, workflowFamily: "standard_deal" }, "service")).toBe(true);
    }
  });

  it("does NOT let a service deal use a non-shared standard-family stage", () => {
    expect(isStageValidForWorkflowRoute({ slug: "estimating", workflowFamily: "standard_deal" }, "service")).toBe(false);
    expect(
      isStageValidForWorkflowRoute({ slug: "estimate_in_progress", workflowFamily: "standard_deal" }, "service"),
    ).toBe(false);
  });

  it("never lets a STANDARD deal use a service-family stage, shared slug or not", () => {
    expect(isStageValidForWorkflowRoute({ slug: "service_estimating", workflowFamily: "service_deal" }, "normal")).toBe(
      false,
    );
    // "won" is on the shared list, but the shared list only ever widens the SERVICE direction.
    expect(isStageValidForWorkflowRoute({ slug: "won", workflowFamily: "service_deal" }, "normal")).toBe(false);
  });

  it("treats an unset route as the standard route, matching workflowFamilyForRoute", () => {
    expect(isStageValidForWorkflowRoute({ slug: "estimating", workflowFamily: "standard_deal" }, null)).toBe(true);
    expect(isStageValidForWorkflowRoute({ slug: "service_estimating", workflowFamily: "service_deal" }, undefined)).toBe(
      false,
    );
  });
});

describe("eligibleStageTargets", () => {
  it("drops the stage the deal is already in", () => {
    const stages = [stage({ id: "a", slug: "estimating" }), stage({ id: "b", slug: "contract" })];
    expect(eligibleStageTargets(stages, { stageId: "a", workflowRoute: "normal" }).map((s) => s.id)).toEqual(["b"]);
  });

  it("drops retired stages the write guard would reject", () => {
    const stages = [
      stage({ id: "a", slug: "closed_won", isActivePipeline: false }),
      stage({ id: "b", slug: "contract" }),
    ];
    expect(eligibleStageTargets(stages, { stageId: "z", workflowRoute: "normal" }).map((s) => s.id)).toEqual(["b"]);
  });

  it("defaults a missing isActivePipeline to live rather than emptying the menu", () => {
    const stages = [{ id: "a", slug: "contract", workflowFamily: "standard_deal" }];
    expect(eligibleStageTargets(stages, { stageId: "z", workflowRoute: "normal" })).toHaveLength(1);
  });

  it("hides service-only stages from a standard deal", () => {
    const stages = [
      stage({ id: "a", slug: "service_estimating", workflowFamily: "service_deal" }),
      stage({ id: "b", slug: "estimating" }),
    ];
    expect(eligibleStageTargets(stages, { stageId: "z", workflowRoute: "normal" }).map((s) => s.id)).toEqual(["b"]);
  });

  it("keeps the shared spine visible to a service deal", () => {
    const stages = [
      stage({ id: "a", slug: "contract", workflowFamily: "standard_deal" }),
      stage({ id: "b", slug: "estimating", workflowFamily: "standard_deal" }),
      stage({ id: "c", slug: "service_estimating", workflowFamily: "service_deal" }),
    ];
    expect(eligibleStageTargets(stages, { stageId: "z", workflowRoute: "service" }).map((s) => s.id)).toEqual([
      "a",
      "c",
    ]);
  });
});
