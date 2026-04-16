import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDealBlindSpotSignals } = await import("../../../src/modules/ai-copilot/signal-service.js");

describe("AI copilot signal service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns deterministic blind-spot signals from deal workflow state", async () => {
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{
            deal_id: "deal-1",
            stage_id: "stage-1",
            stage_name: "Estimating",
            stage_entered_at: "2026-03-01T00:00:00.000Z",
            stale_threshold_days: 14,
            proposal_status: "revision_requested",
            required_documents: ["site_photos"],
          }],
        })
        .mockResolvedValueOnce({ rows: [{ open_task_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ inbound_without_followup_count: 2 }] })
        .mockResolvedValueOnce({ rows: [{ revision_owner_movement_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ missing_required_document_count: 1 }] }),
    };

    const signals = await getDealBlindSpotSignals(tenantDb as any, "deal-1", new Date("2026-04-15T00:00:00.000Z"));

    expect(signals.map((signal) => signal.signalType)).toEqual([
      "stale_stage",
      "missing_next_task",
      "recent_inbound_no_followup",
      "revision_without_owner_movement",
      "estimating_gate_gap",
    ]);
    expect(signals.every((signal) => Array.isArray(signal.evidence))).toBe(true);
    expect(signals.every((signal) => typeof signal.severity === "string")).toBe(true);
  });

  it("returns an empty array when no deterministic blind spots are present", async () => {
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{
            deal_id: "deal-1",
            stage_id: "stage-1",
            stage_name: "Estimating",
            stage_entered_at: "2026-04-10T00:00:00.000Z",
            stale_threshold_days: 14,
            proposal_status: "drafting",
            required_documents: ["site_photos"],
          }],
        })
        .mockResolvedValueOnce({ rows: [{ open_task_count: 2 }] })
        .mockResolvedValueOnce({ rows: [{ inbound_without_followup_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ revision_owner_movement_count: 1 }] })
        .mockResolvedValueOnce({ rows: [{ missing_required_document_count: 0 }] }),
    };

    const signals = await getDealBlindSpotSignals(tenantDb as any, "deal-1", new Date("2026-04-15T00:00:00.000Z"));

    expect(signals).toEqual([]);
  });
});
