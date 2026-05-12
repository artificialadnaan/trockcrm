import { describe, expect, it } from "vitest";
import {
  planReassignment,
  type ReassignCandidate,
} from "../../../scripts/reassign-hubspot-import-stages";

const OPPORTUNITY_STAGE_ID = "03ab1b79-9412-43ec-82b4-624e0a60fd19";
const DD_STAGE_ID = "0416a7db-1e5a-4d0a-88a2-bc5f1480755c";
const ESTIMATING_STAGE_ID = "11111111-2222-3333-4444-555555555555";

function makeCandidate(overrides: Partial<ReassignCandidate> = {}): ReassignCandidate {
  return {
    dealId: "deal-1",
    dealNumber: "HS-1001",
    projectNumber: null,
    currentStageId: OPPORTUNITY_STAGE_ID,
    hubspotStageName: null,
    hubspotDealId: "hs-1001",
    ...overrides,
  };
}

describe("planReassignment", () => {
  it("maps 'Pipe Line' hubspot stage to DD when current stage is Opportunity", () => {
    const plan = planReassignment({
      tenant: "office_dallas",
      candidates: [makeCandidate({ hubspotStageName: "Pipe Line" })],
    });
    expect(plan.rows).toEqual([
      expect.objectContaining({
        action: "move_to_dd",
        targetStageId: DD_STAGE_ID,
        reason: expect.stringContaining("Pipe Line"),
      }),
    ]);
  });

  it("maps 'RFP' hubspot stage to DD when current stage is Opportunity", () => {
    const plan = planReassignment({
      tenant: "office_dallas",
      candidates: [makeCandidate({ hubspotStageName: "RFP" })],
    });
    expect(plan.rows[0]).toMatchObject({ action: "move_to_dd", targetStageId: DD_STAGE_ID });
  });

  it("is case-insensitive on the hubspot stage label", () => {
    const plan = planReassignment({
      tenant: "office_dallas",
      candidates: [
        makeCandidate({ dealId: "d1", hubspotStageName: "pipe line" }),
        makeCandidate({ dealId: "d2", hubspotStageName: "  RFP  " }),
        makeCandidate({ dealId: "d3", hubspotStageName: "PIPE LINE" }),
      ],
    });
    for (const row of plan.rows) {
      expect(row.action).toBe("move_to_dd");
      expect(row.targetStageId).toBe(DD_STAGE_ID);
    }
  });

  it("does not move deals whose current stage is not Opportunity (preserves import-script routing)", () => {
    const plan = planReassignment({
      tenant: "office_dallas",
      candidates: [
        makeCandidate({
          dealId: "already-estimating",
          currentStageId: ESTIMATING_STAGE_ID,
          hubspotStageName: "Pipe Line",
        }),
      ],
    });
    expect(plan.rows[0]).toMatchObject({
      action: "skip_already_correct",
      targetStageId: null,
    });
  });

  it("leaves unmapped hubspot stages in Opportunity and flags for manual review", () => {
    const plan = planReassignment({
      tenant: "office_dallas",
      candidates: [
        makeCandidate({ hubspotStageName: "Closed Won" }),
        makeCandidate({ dealId: "d2", hubspotStageName: null }),
        makeCandidate({ dealId: "d3", hubspotStageName: "" }),
      ],
    });
    for (const row of plan.rows) {
      expect(row.action).toBe("skip_unmapped");
      expect(row.targetStageId).toBeNull();
      expect(row.reason).toMatch(/no mapping rule/);
    }
  });

  it("never targets a stage other than DD (no cross-family or terminal jumps)", () => {
    const candidates: ReassignCandidate[] = [
      makeCandidate({ dealId: "d1", hubspotStageName: "Pipe Line" }),
      makeCandidate({ dealId: "d2", hubspotStageName: "RFP" }),
      makeCandidate({ dealId: "d3", hubspotStageName: "Unknown stage" }),
    ];
    const plan = planReassignment({ tenant: "office_dallas", candidates });
    for (const row of plan.rows) {
      if (row.targetStageId !== null) {
        expect(row.targetStageId).toBe(DD_STAGE_ID);
      }
    }
  });

  it("reports examined count equal to candidate count", () => {
    const plan = planReassignment({
      tenant: "office_dallas",
      candidates: Array.from({ length: 24 }, (_, i) =>
        makeCandidate({ dealId: `d-${i}`, hubspotStageName: i % 12 === 0 ? "RFP" : "Pipe Line" })
      ),
    });
    expect(plan.examined).toBe(24);
    expect(plan.rows.filter((row) => row.action === "move_to_dd")).toHaveLength(24);
  });
});
