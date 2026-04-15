import { describe, expect, it, vi } from "vitest";

const { getAiActionQueue, getAiOpsMetrics, getAiReviewQueue, getAiReviewPacketDetail, getSalesProcessDisconnectDashboard } = await import("../../../src/modules/ai-copilot/service.js");

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

  it("returns a sales process disconnect dashboard", async () => {
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              active_deals: 18,
              total_disconnects: 9,
              stale_stage_count: 3,
              missing_next_task_count: 2,
              inbound_without_followup_count: 1,
              revision_loop_count: 2,
              estimating_gate_gap_count: 1,
              procore_bid_board_drift_count: 2,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              disconnect_type: "stale_stage",
              disconnect_label: "Stalled in stage",
              disconnect_count: 3,
            },
            {
              disconnect_type: "revision_loop",
              disconnect_label: "Revision loop",
              disconnect_count: 2,
            },
            {
              disconnect_type: "procore_bid_board_drift",
              disconnect_label: "Bid board sync drift",
              disconnect_count: 2,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: "deal-1",
              deal_number: "D-1001",
              deal_name: "Alpha Plaza",
              stage_name: "Estimating",
              estimating_substage: "under_review",
              assigned_rep_name: "Morgan Rep",
              disconnect_type: "stale_stage",
              disconnect_label: "Stalled in stage",
              disconnect_severity: "high",
              disconnect_summary: "Estimating has exceeded its stale threshold.",
              disconnect_details: "Deal has been in Estimating for 16 days with no closed-loop movement.",
              age_days: 16,
              open_task_count: 0,
              inbound_without_followup_count: 1,
              last_activity_at: "2026-04-10T10:00:00.000Z",
              latest_customer_email_at: "2026-04-12T12:00:00.000Z",
              proposal_status: "revision_requested",
              procore_sync_status: "conflict",
              procore_sync_direction: "bidirectional",
              procore_last_synced_at: "2026-04-09T10:00:00.000Z",
              procore_sync_updated_at: "2026-04-12T09:00:00.000Z",
              procore_drift_reason: "Bid board stage changed without CRM reconciliation.",
            },
            {
              id: "deal-2",
              deal_number: "D-1002",
              deal_name: "Beta Tower",
              stage_name: "Bid Sent",
              estimating_substage: "sent_to_client",
              assigned_rep_name: "Jordan Rep",
              disconnect_type: "procore_bid_board_drift",
              disconnect_label: "Bid board sync drift",
              disconnect_severity: "critical",
              disconnect_summary: "Procore bid board and CRM stage state are out of sync.",
              disconnect_details: "Bid board recorded a newer project/bid state than CRM currently reflects.",
              age_days: 3,
              open_task_count: 1,
              inbound_without_followup_count: 0,
              last_activity_at: "2026-04-13T11:00:00.000Z",
              latest_customer_email_at: null,
              proposal_status: "sent",
              procore_sync_status: "conflict",
              procore_sync_direction: "bidirectional",
              procore_last_synced_at: "2026-04-11T11:00:00.000Z",
              procore_sync_updated_at: "2026-04-14T08:00:00.000Z",
              procore_drift_reason: "Procore reported a newer update than the CRM stage map.",
              company_id: "company-2",
              company_name: "Beta Holdings",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              deal_id: "deal-1",
              intervention_count_30d: 2,
              latest_intervention_at: "2026-04-14T15:00:00.000Z",
              latest_action: "mark_reviewed",
            },
            {
              deal_id: "deal-3",
              intervention_count_30d: 1,
              latest_intervention_at: "2026-04-13T13:00:00.000Z",
              latest_action: "resolve",
            },
          ],
        }),
    };

    const result = await getSalesProcessDisconnectDashboard(tenantDb as any, { limit: 25 });

    expect(result.summary).toEqual({
      activeDeals: 18,
      totalDisconnects: 11,
      staleStageCount: 3,
      missingNextTaskCount: 2,
      inboundWithoutFollowupCount: 1,
      revisionLoopCount: 2,
      estimatingGateGapCount: 1,
      procoreBidBoardDriftCount: 2,
    });
    expect(result.byType).toEqual([
      {
        disconnectType: "stale_stage",
        label: "Stalled in stage",
        count: 3,
      },
      {
        disconnectType: "revision_loop",
        label: "Revision loop",
        count: 2,
      },
      {
        disconnectType: "procore_bid_board_drift",
        label: "Bid board sync drift",
        count: 2,
      },
    ]);
    expect(result.rows[0]).toMatchObject({
      id: "deal-1",
      dealNumber: "D-1001",
      dealName: "Alpha Plaza",
      stageName: "Estimating",
      disconnectType: "stale_stage",
      disconnectSeverity: "high",
      openTaskCount: 0,
      inboundWithoutFollowupCount: 1,
      procoreSyncStatus: "conflict",
      procoreDriftReason: "Bid board stage changed without CRM reconciliation.",
    });
    expect(result.rows[1]).toMatchObject({
      disconnectType: "procore_bid_board_drift",
      procoreSyncStatus: "conflict",
      procoreSyncDirection: "bidirectional",
      companyName: "Beta Holdings",
    });
    expect(result.clusters).toEqual([
      expect.objectContaining({
        clusterKey: "bid_board_sync_break",
        title: "Bid board / CRM stage drift",
        dealCount: 1,
        disconnectCount: 1,
        includesProcoreBidBoard: true,
      }),
      expect.objectContaining({
        clusterKey: "execution_stall",
        dealCount: 1,
      }),
    ]);
    expect(result.trends.reps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "Morgan Rep",
        disconnectCount: 1,
        recentInterventionCount: 1,
      }),
      expect.objectContaining({
        key: "Jordan Rep",
        disconnectCount: 1,
      }),
    ]));
    expect(result.trends.companies).toEqual([
      expect.objectContaining({
        key: "company-2",
        label: "Beta Holdings",
        disconnectCount: 1,
      }),
    ]);
    expect(result.outcomes).toEqual({
      interventionDeals30d: 2,
      clearedAfterIntervention30d: 1,
      stillOpenAfterIntervention30d: 1,
      unresolvedEscalationsOpen: 0,
      repeatIssueDealsOpen: 0,
      repeatClusterDealsOpen: 0,
      interventionCoverageRate: 0.5,
      clearanceRate30d: 0.5,
    });
  });
});
