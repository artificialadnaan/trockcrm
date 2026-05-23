import { describe, expect, it, vi } from "vitest";
import {
  aiDocumentIndex,
  aiEmbeddingChunks,
  aiCopilotPackets,
  aiTaskSuggestions,
  aiRiskFlags,
  aiFeedback,
} from "../../../../shared/src/schema/index.js";
const { getDealCopilotContext } = await import("../../../src/modules/ai-copilot/context-service.js");

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

describe("AI copilot schema exports", () => {
  it("exports all tenant AI tables from the shared schema barrel", () => {
    expect(aiDocumentIndex).toBeDefined();
    expect(aiEmbeddingChunks).toBeDefined();
    expect(aiCopilotPackets).toBeDefined();
    expect(aiTaskSuggestions).toBeDefined();
    expect(aiRiskFlags).toBeDefined();
    expect(aiFeedback).toBeDefined();
  });

  it("exposes the expected AI table names for typed query construction", () => {
    expect(aiDocumentIndex[Symbol.for("drizzle:Name")]).toBe("ai_document_index");
    expect(aiEmbeddingChunks[Symbol.for("drizzle:Name")]).toBe("ai_embedding_chunks");
    expect(aiCopilotPackets[Symbol.for("drizzle:Name")]).toBe("ai_copilot_packets");
    expect(aiTaskSuggestions[Symbol.for("drizzle:Name")]).toBe("ai_task_suggestions");
    expect(aiRiskFlags[Symbol.for("drizzle:Name")]).toBe("ai_risk_flags");
    expect(aiFeedback[Symbol.for("drizzle:Name")]).toBe("ai_feedback");
  });

  it("builds a deal copilot context with deal snapshot, activities, emails, and task counts", async () => {
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{
            id: "deal-1",
            deal_number: "TR-2026-0001",
            name: "Alpha Plaza",
            stage_id: "stage-1",
            stage_name: "Estimating",
            assigned_rep_id: "user-1",
            dd_estimate: "15000.00",
            bid_estimate: "22000.00",
            awarded_amount: null,
            proposal_status: "revision_requested",
            last_activity_at: "2026-04-14T12:00:00.000Z",
            expected_close_date: "2026-04-30",
            stage_slug: "estimating",
            workflow_route: "normal",
            stage_entered_at: "2026-04-01T00:00:00.000Z",
            on_hold: false,
            on_hold_started_at: null,
            on_hold_accumulated_seconds: 0,
            on_hold_accumulated_seconds_at_stage_entry: 0,
          }],
        })
        .mockResolvedValueOnce({
          rows: [
            { id: "activity-2", type: "email", subject: "Client follow-up", body: "Need revised proposal", occurred_at: "2026-04-14T12:00:00.000Z" },
            { id: "activity-1", type: "note", subject: "Estimator note", body: "Waiting on pricing", occurred_at: "2026-04-13T09:00:00.000Z" },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            { id: "email-2", subject: "Need revision", body_preview: "Please revise the estimate", direction: "inbound", sent_at: "2026-04-14T11:30:00.000Z", from_address: "client@example.com", to_addresses: ["sales@trock.com"] },
            { id: "email-1", subject: "Proposal sent", body_preview: "Attached proposal", direction: "outbound", sent_at: "2026-04-12T15:00:00.000Z", from_address: "sales@trock.com", to_addresses: ["client@example.com"] },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ open_task_count: 1, overdue_task_count: 0 }],
        }),
    };

    const context = await getDealCopilotContext(tenantDb as any, "deal-1", "user-1");

    expect(context.deal.id).toBe("deal-1");
    expect(context.deal.stageName).toBe("Estimating");
    expect(context.deal.proposalStatus).toBe("revision_requested");
    expect(context.deal.atRisk).toMatchObject({
      isAtRisk: true,
      reason: "threshold_reached",
      thresholdDays: 14,
    });
    expect(context.recentActivities.map((activity) => activity.id)).toEqual(["activity-2", "activity-1"]);
    expect(context.recentEmails[0]?.bodyPreview).toBe("Please revise the estimate");
    expect(context.taskSummary).toEqual({ openTaskCount: 1, overdueTaskCount: 0 });

    const activityQueryChunks = flattenQueryChunks(tenantDb.execute.mock.calls[1]?.[0]);
    const emailQueryChunks = flattenQueryChunks(tenantDb.execute.mock.calls[2]?.[0]);
    const emailQuerySql = emailQueryChunks.map((chunk) => String(chunk)).join(" ");
    expect(activityQueryChunks).toContain("user-1");
    expect(emailQuerySql).toContain("assigned_entity_type");
    expect(emailQuerySql).toContain("assigned_entity_id");
    expect(emailQuerySql).toContain("deal");
    expect(emailQuerySql).not.toContain("user_id =");
  });

  it("sends an on-hold deal to the copilot as not at risk", async () => {
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{
            id: "deal-1",
            deal_number: "TR-2026-0001",
            name: "Alpha Plaza",
            stage_id: "stage-1",
            stage_name: "Estimating",
            assigned_rep_id: "user-1",
            dd_estimate: null,
            bid_estimate: null,
            awarded_amount: null,
            proposal_status: null,
            last_activity_at: null,
            expected_close_date: null,
            stage_slug: "estimating",
            workflow_route: "normal",
            stage_entered_at: "2026-03-01T00:00:00.000Z",
            on_hold: true,
            on_hold_started_at: "2026-04-10T00:00:00.000Z",
            on_hold_accumulated_seconds: 0,
            on_hold_accumulated_seconds_at_stage_entry: 0,
          }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ open_task_count: 1, overdue_task_count: 0 }] }),
    };

    const context = await getDealCopilotContext(tenantDb as any, "deal-1", "user-1");

    expect(context.deal.atRisk).toMatchObject({
      isAtRisk: false,
      reason: "on_hold",
      thresholdDays: 14,
    });
    const dealQuerySql = flattenQueryChunks(tenantDb.execute.mock.calls[0]?.[0]).map((chunk) => String(chunk)).join(" ");
    expect(dealQuerySql).toContain("on_hold");
    expect(dealQuerySql).toContain("bid_board_stage_slug");
    expect(dealQuerySql).toContain("mirror_psc.name");
    expect(dealQuerySql).not.toContain("stale_threshold_days");
  });
});
