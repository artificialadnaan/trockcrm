import { humanizeStageSlug, stageLabelFor } from "../stage-label";
import type { PipelineStage } from "../api/types";

const stage = (id: string, slug: string, name: string): PipelineStage => ({
  id,
  slug,
  name,
  displayOrder: 0,
  isTerminal: false,
  isActivePipeline: true,
  color: null,
});

const STAGES = [stage("s-opp", "opportunity", "Opportunity"), stage("s-est", "estimating", "Estimating")];

describe("stageLabelFor", () => {
  it("prefers the configured name for the display slug", () => {
    expect(stageLabelFor({ displayStageSlug: "estimating", stageId: "s-opp" }, STAGES)).toBe("Estimating");
  });

  it("humanizes a Bid Board-only slug rather than reverting to the CRM stage", () => {
    // THE bug. `sent_to_production` has no CRM pipeline row, and falling back to the deal's stageId
    // labelled a CLOSED deal "Opportunity" — a different, older stage the deal has already left. A
    // slightly unpolished "Sent to production" beats a polished falsehood.
    expect(stageLabelFor({ displayStageSlug: "sent_to_production", stageId: "s-opp" }, STAGES)).toBe(
      "Sent to production",
    );
  });

  it("never returns the CRM stage name when a display slug is present", () => {
    expect(stageLabelFor({ displayStageSlug: "closed_won", stageId: "s-opp" }, STAGES)).not.toBe(
      "Opportunity",
    );
  });

  it("keeps every card labelled when the stages request failed entirely", () => {
    // /deals/stages can fail while /deals succeeds. Without the slug fallback the whole column went
    // blank, which reads as "these deals have no stage" rather than "we couldn't load stage names".
    expect(stageLabelFor({ displayStageSlug: "estimating", stageId: "s-est" }, undefined)).toBe(
      "Estimating",
    );
  });

  it("falls back to the CRM stage id only when there is no display slug at all", () => {
    expect(stageLabelFor({ displayStageSlug: null, stageId: "s-opp" }, STAGES)).toBe("Opportunity");
  });

  it("uses stageSlug when displayStageSlug is absent", () => {
    expect(stageLabelFor({ stageSlug: "estimating", stageId: "s-opp" }, STAGES)).toBe("Estimating");
  });

  it("returns undefined when there is nothing to label with", () => {
    expect(stageLabelFor({ stageId: null }, STAGES)).toBeUndefined();
  });
});

describe("humanizeStageSlug", () => {
  it.each([
    ["sent_to_production", "Sent to production"],
    ["closed_won", "Closed won"],
    ["estimating", "Estimating"],
  ])("%s → %s", (slug, expected) => {
    expect(humanizeStageSlug(slug)).toBe(expected);
  });
});
