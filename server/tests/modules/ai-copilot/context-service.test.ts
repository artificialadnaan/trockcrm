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
            stale_threshold_days: 14,
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

    const context = await getDealCopilotContext(tenantDb as any, "deal-1");

    expect(context.deal.id).toBe("deal-1");
    expect(context.deal.stageName).toBe("Estimating");
    expect(context.deal.proposalStatus).toBe("revision_requested");
    expect(context.recentActivities.map((activity) => activity.id)).toEqual(["activity-2", "activity-1"]);
    expect(context.recentEmails[0]?.bodyPreview).toBe("Please revise the estimate");
    expect(context.taskSummary).toEqual({ openTaskCount: 1, overdueTaskCount: 0 });
  });
});
