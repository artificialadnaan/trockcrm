import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDealBlindSpotSignals } = await import("../../../src/modules/ai-copilot/signal-service.js");

function flattenQueryChunks(input: unknown, seen = new WeakSet<object>()): unknown[] {
  if (!input || typeof input !== "object") return [input];
  if (seen.has(input as object)) return [];
  seen.add(input as object);

  const queryChunks = (input as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) {
    return queryChunks.flatMap((chunk) => flattenQueryChunks(chunk, seen));
  }

  if ("value" in (input as Record<string, unknown>)) {
    return [(input as Record<string, unknown>).value];
  }

  return Object.values(input as Record<string, unknown>).flatMap((value) => flattenQueryChunks(value, seen));
}

describe("AI copilot signal service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("issues independent blind-spot reads concurrently", async () => {
    const queryResults = [
      {
        rows: [{
          deal_id: "deal-1",
          stage_id: "stage-1",
          stage_slug: "estimating",
          workflow_route: "normal",
          stage_name: "Estimating",
          stage_entered_at: "2026-04-10T00:00:00.000Z",
          on_hold: false,
          on_hold_started_at: null,
          on_hold_accumulated_seconds: 0,
          on_hold_accumulated_seconds_at_stage_entry: 0,
          proposal_status: "drafting",
          required_documents: [],
        }],
      },
      { rows: [{ open_task_count: 1 }] },
      { rows: [{ inbound_without_followup_count: 0 }] },
      { rows: [{ revision_owner_movement_count: 1 }] },
      { rows: [{ missing_required_document_count: 0 }] },
    ];
    const resolvers: Array<(value: unknown) => void> = [];
    const tenantDb = {
      execute: vi.fn(() => new Promise((resolve) => resolvers.push(resolve))),
    };

    const pendingSignals = getDealBlindSpotSignals(
      tenantDb as any,
      "deal-1",
      new Date("2026-04-15T00:00:00.000Z")
    );

    expect(tenantDb.execute).toHaveBeenCalledTimes(5);
    queryResults.forEach((result, index) => resolvers[index](result));
    await expect(pendingSignals).resolves.toEqual([]);
  });

  it("returns deterministic blind-spot signals from deal workflow state", async () => {
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{
            deal_id: "deal-1",
            stage_id: "stage-1",
            stage_slug: "estimating",
            workflow_route: "normal",
            stage_name: "Estimating",
            stage_entered_at: "2026-03-01T00:00:00.000Z",
            on_hold: false,
            on_hold_started_at: null,
            on_hold_accumulated_seconds: 0,
            on_hold_accumulated_seconds_at_stage_entry: 0,
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

    const inboundQuerySql = flattenQueryChunks(tenantDb.execute.mock.calls[2]?.[0]).map((chunk) => String(chunk)).join(" ");
    expect(inboundQuerySql).toContain("assigned_entity_type");
    expect(inboundQuerySql).toContain("assigned_entity_id");
    expect(inboundQuerySql).toContain("deal");
  });

  it("returns an empty array when no deterministic blind spots are present", async () => {
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{
            deal_id: "deal-1",
            stage_id: "stage-1",
            stage_slug: "estimating",
            workflow_route: "normal",
            stage_name: "Estimating",
            stage_entered_at: "2026-04-10T00:00:00.000Z",
            on_hold: false,
            on_hold_started_at: null,
            on_hold_accumulated_seconds: 0,
            on_hold_accumulated_seconds_at_stage_entry: 0,
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

  it("uses the hold-aware At Risk engine for stale-stage signals", async () => {
    const now = new Date("2026-04-15T00:00:00.000Z");
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{
            deal_id: "deal-1",
            stage_id: "stage-1",
            stage_slug: "estimating",
            workflow_route: "normal",
            stage_name: "Estimating",
            stage_entered_at: "2026-03-01T00:00:00.000Z",
            on_hold: true,
            on_hold_started_at: "2026-04-10T00:00:00.000Z",
            on_hold_accumulated_seconds: 0,
            on_hold_accumulated_seconds_at_stage_entry: 0,
            proposal_status: "drafting",
            required_documents: [],
          }],
        })
        .mockResolvedValueOnce({ rows: [{ open_task_count: 1 }] })
        .mockResolvedValueOnce({ rows: [{ inbound_without_followup_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ revision_owner_movement_count: 1 }] })
        .mockResolvedValueOnce({ rows: [{ missing_required_document_count: 0 }] }),
    };

    const signals = await getDealBlindSpotSignals(tenantDb as any, "deal-1", now);

    expect(signals.map((signal) => signal.signalType)).not.toContain("stale_stage");
    const dealQuerySql = flattenQueryChunks(tenantDb.execute.mock.calls[0]?.[0]).map((chunk) => String(chunk)).join(" ");
    expect(dealQuerySql).toContain("on_hold");
    expect(dealQuerySql).toContain("bid_board_stage_slug");
    expect(dealQuerySql).toContain("mirror_psc.name");
    expect(dealQuerySql).not.toContain("stale_threshold_days");
  });

  it("still surfaces non-held over-threshold deals as stale-stage signals", async () => {
    const now = new Date("2026-04-15T00:00:00.000Z");
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{
            deal_id: "deal-1",
            stage_id: "stage-1",
            stage_slug: "estimating",
            workflow_route: "normal",
            stage_name: "Estimating",
            stage_entered_at: "2026-03-01T00:00:00.000Z",
            on_hold: false,
            on_hold_started_at: null,
            on_hold_accumulated_seconds: 0,
            on_hold_accumulated_seconds_at_stage_entry: 0,
            proposal_status: "drafting",
            required_documents: [],
          }],
        })
        .mockResolvedValueOnce({ rows: [{ open_task_count: 1 }] })
        .mockResolvedValueOnce({ rows: [{ inbound_without_followup_count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ revision_owner_movement_count: 1 }] })
        .mockResolvedValueOnce({ rows: [{ missing_required_document_count: 0 }] }),
    };

    const signals = await getDealBlindSpotSignals(tenantDb as any, "deal-1", now);

    expect(signals).toEqual([
      expect.objectContaining({
        signalType: "stale_stage",
        evidence: [
          expect.objectContaining({
            daysInStage: 45,
            staleThresholdDays: 14,
          }),
        ],
      }),
    ]);
  });
});
