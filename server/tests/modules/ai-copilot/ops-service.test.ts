import { describe, expect, it, vi } from "vitest";

const { getAiActionQueue, getAiOpsMetrics, getAiReviewQueue, getAiReviewPacketDetail } = await import("../../../src/modules/ai-copilot/service.js");

describe("AI ops service", () => {
  it("returns aggregate AI ops metrics", async () => {
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              packets_generated_24h: 12,
              packets_pending: 3,
              avg_confidence_7d: "0.8125",
              open_blind_spots: 5,
              suggestions_accepted_30d: 9,
              suggestions_dismissed_30d: 4,
              triage_actions_30d: 11,
              escalations_30d: 3,
              ai_search_interactions_30d: 14,
              ai_search_queries_with_click_30d: 6,
              ai_search_workflow_executions_30d: 5,
              ai_search_queries_with_workflow_30d: 3,
              ai_search_queries_served_30d: 9,
              ai_search_workflow_conversion_rate_30d: "0.3333",
              resolved_blind_spots_30d: 6,
              recurring_blind_spots_open: 2,
              recurring_suggestions_open: 4,
              positive_feedback_30d: 7,
              negative_feedback_30d: 2,
              documents_indexed: 44,
              documents_pending: 6,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            { source_type: "email_message", indexed: 20, pending: 2 },
            { source_type: "activity_note", indexed: 14, pending: 3 },
          ],
        }),
    };

    const result = await getAiOpsMetrics(tenantDb as any);

    expect(result).toEqual({
      packetsGenerated24h: 12,
      packetsPending: 3,
      avgConfidence7d: 0.8125,
      openBlindSpots: 5,
      suggestionsAccepted30d: 9,
      suggestionsDismissed30d: 4,
      triageActions30d: 11,
      escalations30d: 3,
      aiSearchInteractions30d: 14,
      aiSearchQueriesWithClick30d: 6,
      aiSearchWorkflowExecutions30d: 5,
      aiSearchQueriesWithWorkflow30d: 3,
      aiSearchQueriesServed30d: 9,
      aiSearchWorkflowConversionRate30d: 0.3333,
      resolvedBlindSpots30d: 6,
      recurringBlindSpotsOpen: 2,
      recurringSuggestionsOpen: 4,
      positiveFeedback30d: 7,
      negativeFeedback30d: 2,
      documentsIndexed: 44,
      documentsPending: 6,
      documentStatusBySource: [
        { sourceType: "email_message", indexed: 20, pending: 2 },
        { sourceType: "activity_note", indexed: 14, pending: 3 },
      ],
    });
  });

  it("returns a packet review queue with counts", async () => {
    const tenantDb = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          {
            packet_id: "packet-1",
            deal_id: "deal-1",
            deal_name: "Alpha Plaza",
            deal_number: "D-1001",
            status: "completed",
            summary_text: "Deal needs follow-up.",
            confidence: "0.9000",
            generated_at: "2026-04-15T12:00:00.000Z",
            created_at: "2026-04-15T11:59:00.000Z",
            suggested_count: 3,
            accepted_count: 1,
            dismissed_count: 1,
            open_blind_spot_count: 2,
            positive_feedback_count: 2,
            negative_feedback_count: 0,
          },
        ],
      }),
    };

    const result = await getAiReviewQueue(tenantDb as any, { limit: 10 });

    expect(result).toEqual([
      {
        packetId: "packet-1",
        dealId: "deal-1",
        dealName: "Alpha Plaza",
        dealNumber: "D-1001",
        status: "completed",
        summaryText: "Deal needs follow-up.",
        confidence: 0.9,
        generatedAt: "2026-04-15T12:00:00.000Z",
        createdAt: "2026-04-15T11:59:00.000Z",
        suggestedCount: 3,
        acceptedCount: 1,
        dismissedCount: 1,
        openBlindSpotCount: 2,
        positiveFeedbackCount: 2,
        negativeFeedbackCount: 0,
      },
    ]);
  });

  it("returns a packet review detail bundle", async () => {
    const tenantDb = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          {
            id: "packet-1",
            deal_id: "deal-1",
            status: "completed",
            summary_text: "Deal needs follow-up.",
            deal_name: "Alpha Plaza",
            deal_number: "D-1001",
          },
        ],
      }),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    };

    const result = await getAiReviewPacketDetail(tenantDb as any, "packet-1");

    expect(result.packet).toMatchObject({
      id: "packet-1",
      dealName: "Alpha Plaza",
      dealNumber: "D-1001",
    });
    expect(result.suggestedTasks).toEqual([]);
    expect(result.blindSpotFlags).toEqual([]);
    expect(result.feedback).toEqual([]);
  });

  it("returns a triage-ready AI action queue", async () => {
    const tenantDb = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          {
            entry_type: "blind_spot",
            id: "risk-1",
            deal_id: "deal-1",
            deal_name: "Alpha Plaza",
            deal_number: "D-1001",
            title: "No follow-up task",
            details: "Deal has no next step.",
            severity: "high",
            priority: null,
            status: "open",
            created_at: "2026-04-15T12:00:00.000Z",
            suggested_due_at: null,
            repeat_count: 3,
            last_triage_action: "escalate",
            last_triaged_at: "2026-04-15T12:30:00.000Z",
          },
          {
            entry_type: "task_suggestion",
            id: "suggestion-1",
            deal_id: "deal-2",
            deal_name: "Beta Tower",
            deal_number: "D-1002",
            title: "Call customer",
            details: "Confirm revision scope.",
            severity: null,
            priority: "high",
            status: "suggested",
            created_at: "2026-04-15T11:00:00.000Z",
            suggested_due_at: "2026-04-16T09:00:00.000Z",
            repeat_count: 2,
            last_triage_action: "mark_reviewed",
            last_triaged_at: "2026-04-15T11:30:00.000Z",
          },
        ],
      }),
    };

    const result = await getAiActionQueue(tenantDb as any, { limit: 10 });

    expect(result).toEqual([
      {
        entryType: "blind_spot",
        id: "risk-1",
        dealId: "deal-1",
        dealName: "Alpha Plaza",
        dealNumber: "D-1001",
        title: "No follow-up task",
        details: "Deal has no next step.",
        severity: "high",
        priority: null,
        status: "open",
        createdAt: "2026-04-15T12:00:00.000Z",
        suggestedDueAt: null,
        repeatCount: 3,
        lastTriageAction: "escalate",
        lastTriagedAt: "2026-04-15T12:30:00.000Z",
        escalated: true,
      },
      {
        entryType: "task_suggestion",
        id: "suggestion-1",
        dealId: "deal-2",
        dealName: "Beta Tower",
        dealNumber: "D-1002",
        title: "Call customer",
        details: "Confirm revision scope.",
        severity: null,
        priority: "high",
        status: "suggested",
        createdAt: "2026-04-15T11:00:00.000Z",
        suggestedDueAt: "2026-04-16T09:00:00.000Z",
        repeatCount: 2,
        lastTriageAction: "mark_reviewed",
        lastTriagedAt: "2026-04-15T11:30:00.000Z",
        escalated: false,
      },
    ]);
  });
});
