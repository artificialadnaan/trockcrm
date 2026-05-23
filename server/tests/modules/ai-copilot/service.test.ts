import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

const {
  generateDealCopilotPacket,
  getDealCopilotView,
  getSalesProcessDisconnectDashboard,
  listCurrentSalesProcessDisconnectRows,
  regenerateDealCopilot,
} = await import(
  "../../../src/modules/ai-copilot/service.js"
);

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

describe("AI copilot service", () => {
  it("assembles context, signals, retrieval evidence, and persists one packet bundle", async () => {
    const callOrder: string[] = [];
    const tenantDb = {} as any;
    const persistedAt = new Date("2026-04-15T12:00:00.000Z");

    const result = await generateDealCopilotPacket(
      tenantDb,
      { dealId: "deal-1", forceRegenerate: true, viewerUserId: "user-1" },
      {
        getDealCopilotContext: vi.fn(async () => {
          callOrder.push("context");
          return {
            deal: { id: "deal-1", name: "Alpha Plaza", stageName: "Estimating", proposalStatus: "revision_requested" },
            recentActivities: [],
            recentEmails: [],
            taskSummary: { openTaskCount: 0, overdueTaskCount: 0 },
          };
        }),
        getDealBlindSpotSignals: vi.fn(async () => {
          callOrder.push("signals");
          return [{ signalType: "missing_next_task", severity: "warning", summary: "Deal has no open next-step task", evidence: [], isBlocking: false }];
        }),
        searchDealKnowledge: vi.fn(async () => {
          callOrder.push("retrieval");
          return [{ id: "chunk-1", text: "Customer asked for a revision", metadata: { sourceType: "email_message" }, distance: 0.11 }];
        }),
        provider: {
          generateCopilotPacket: vi.fn(async (promptInput) => {
            callOrder.push("provider");
            expect(promptInput.signals).toHaveLength(1);
            expect(promptInput.context.deal.id).toBe("deal-1");
            expect(promptInput.evidence).toHaveLength(1);
            return {
              summary: "Deal needs a revision follow-up.",
              recommendedNextStep: {
                action: "Call the customer and confirm the revision scope.",
                ownerId: "user-1",
                dueLabel: "today",
                rationale: "The deal has no follow-up task after a revision request.",
              },
              suggestedTasks: [
                {
                  title: "Call customer about revision scope",
                  description: "Clarify requested changes and confirm timeline.",
                  suggestedOwnerId: "user-1",
                  priority: "high",
                  confidence: 0.91,
                  evidence: [],
                },
              ],
              blindSpotFlags: [
                {
                  flagType: "missing_next_task",
                  severity: "warning",
                  title: "No follow-up task",
                  details: "The deal has no active follow-up work item.",
                  evidence: [],
                },
              ],
              confidence: 0.88,
              evidence: [{ sourceType: "email_message", sourceId: "email-1" }],
            };
          }),
          generateInterventionCopilotPacket: vi.fn(async () => ({
            summary: "Intervention summary",
            recommendedAction: {
              action: "assign",
              rationale: "Owner alignment is required.",
              suggestedOwner: null,
              suggestedOwnerId: null,
            },
            rootCause: null,
            blockerOwner: null,
            reopenRisk: null,
            blindSpotFlags: [],
            evidence: [],
            confidence: 0.5,
          })),
        },
        persistPacketBundle: vi.fn(async (payload) => {
          callOrder.push("persist");
          expect(payload.packet.scopeId).toBe("deal-1");
          expect(payload.packet.expiresAt).toBe("2026-04-15T12:30:00.000Z");
          expect(payload.suggestedTasks).toHaveLength(1);
          expect(payload.blindSpotFlags).toHaveLength(1);
          return {
            packetId: "packet-1",
            generatedAt: persistedAt.toISOString(),
          };
        }),
        getExistingFreshPacket: vi.fn(async () => null),
        now: persistedAt,
      }
    );

    expect(callOrder).toEqual(["context", "signals", "retrieval", "provider", "persist"]);
    expect(result.packetId).toBe("packet-1");
    expect(result.summary).toBe("Deal needs a revision follow-up.");
  });

  it("passes a text retrieval query built from context and signals into knowledge search", async () => {
    const searchDealKnowledge = vi.fn(async () => []);

    await generateDealCopilotPacket(
      {} as any,
      { dealId: "deal-1", forceRegenerate: true, viewerUserId: "user-1" },
      {
        getDealCopilotContext: vi.fn(async () => ({
          deal: {
            id: "deal-1",
            name: "Alpha Plaza",
            stageName: "Estimating",
            proposalStatus: "revision_requested",
            assignedRepId: "user-1",
          },
          recentActivities: [{ subject: "Estimator follow-up", body: "Need updated site photos." }],
          recentEmails: [{ subject: "Pricing revision", bodyPreview: "Please revise the allowance." }],
          taskSummary: { openTaskCount: 0, overdueTaskCount: 0 },
        })),
        getDealBlindSpotSignals: vi.fn(async () => [
          { signalType: "missing_next_task", severity: "warning", summary: "Deal has no active follow-up task", evidence: [], isBlocking: false },
        ]),
        searchDealKnowledge,
        provider: {
          generateCopilotPacket: vi.fn(async () => ({
            summary: "Summary",
            recommendedNextStep: { action: "Action", ownerId: null, dueLabel: null, rationale: "Why" },
            suggestedTasks: [],
            blindSpotFlags: [],
            confidence: 0.5,
            evidence: [],
          })),
          generateInterventionCopilotPacket: vi.fn(async () => ({
            summary: "Intervention summary",
            recommendedAction: {
              action: "investigate",
              rationale: "Review the case context.",
              suggestedOwner: null,
              suggestedOwnerId: null,
            },
            rootCause: null,
            blockerOwner: null,
            reopenRisk: null,
            blindSpotFlags: [],
            evidence: [],
            confidence: 0.5,
          })),
        },
        persistPacketBundle: vi.fn(async () => ({
          packetId: "packet-1",
          generatedAt: "2026-04-15T12:00:00.000Z",
        })),
        getExistingFreshPacket: vi.fn(async () => null),
        now: new Date("2026-04-15T12:00:00.000Z"),
      }
    );

    expect(searchDealKnowledge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        dealId: "deal-1",
        queryText: expect.stringContaining("Alpha Plaza"),
      })
    );
    expect(searchDealKnowledge.mock.calls[0]?.[1]?.queryText).toContain("missing next task");
  });

  it("reuses a fresh packet when the snapshot hash is unchanged", async () => {
    const result = await generateDealCopilotPacket(
      {} as any,
      { dealId: "deal-1", forceRegenerate: false, viewerUserId: "user-1" },
      {
        getDealCopilotContext: vi.fn(async () => ({
          deal: { id: "deal-1", name: "Alpha Plaza", stageName: "Estimating", proposalStatus: "drafting" },
          recentActivities: [],
          recentEmails: [],
          taskSummary: { openTaskCount: 1, overdueTaskCount: 0 },
        })),
        getDealBlindSpotSignals: vi.fn(async () => []),
        searchDealKnowledge: vi.fn(async () => []),
        provider: {
          generateCopilotPacket: vi.fn(),
          generateInterventionCopilotPacket: vi.fn(async () => ({
            summary: "Intervention summary",
            recommendedAction: {
              action: "investigate",
              rationale: "Review the case context.",
              suggestedOwner: null,
              suggestedOwnerId: null,
            },
            rootCause: null,
            blockerOwner: null,
            reopenRisk: null,
            blindSpotFlags: [],
            evidence: [],
            confidence: 0.5,
          })),
        },
        getExistingFreshPacket: vi.fn(async ({ snapshotHash }) => ({
          packetId: "packet-existing",
          snapshotHash,
          summary: "Existing summary",
          generatedAt: "2026-04-15T12:00:00.000Z",
        })),
        persistPacketBundle: vi.fn(),
        now: new Date("2026-04-15T12:00:00.000Z"),
      }
    );

    expect(result).toEqual({
      packetId: "packet-existing",
      snapshotHash: expect.any(String),
      summary: "Existing summary",
      generatedAt: "2026-04-15T12:00:00.000Z",
    });
  });

  it("regenerates when the existing packet is expired", async () => {
    const persistedAt = new Date("2026-04-15T12:45:00.000Z");

    const result = await generateDealCopilotPacket(
      {} as any,
      { dealId: "deal-1", forceRegenerate: false, viewerUserId: "user-1" },
      {
        getDealCopilotContext: vi.fn(async () => ({
          deal: { id: "deal-1", name: "Alpha Plaza", stageName: "Estimating", proposalStatus: "drafting" },
          recentActivities: [],
          recentEmails: [],
          taskSummary: { openTaskCount: 1, overdueTaskCount: 0 },
        })),
        getDealBlindSpotSignals: vi.fn(async () => []),
        searchDealKnowledge: vi.fn(async () => []),
        provider: {
          generateCopilotPacket: vi.fn(async () => ({
            summary: "Fresh summary",
            recommendedNextStep: {
              action: "Refresh packet",
              ownerId: null,
              dueLabel: null,
              rationale: "Old packet expired.",
            },
            suggestedTasks: [],
            blindSpotFlags: [],
            confidence: 0.7,
            evidence: [],
          })),
          generateInterventionCopilotPacket: vi.fn(async () => ({
            summary: "Intervention summary",
            recommendedAction: {
              action: "escalate",
              rationale: "This case shows repeated reopen pressure.",
              suggestedOwner: null,
              suggestedOwnerId: null,
            },
            rootCause: null,
            blockerOwner: null,
            reopenRisk: null,
            blindSpotFlags: [],
            evidence: [],
            confidence: 0.5,
          })),
        },
        getExistingFreshPacket: vi.fn(async () => null),
        persistPacketBundle: vi.fn(async () => ({
          packetId: "packet-fresh",
          generatedAt: persistedAt.toISOString(),
        })),
        now: persistedAt,
      }
    );

    expect(result).toEqual({
      packetId: "packet-fresh",
      snapshotHash: expect.any(String),
      summary: "Fresh summary",
      generatedAt: "2026-04-15T12:45:00.000Z",
    });
  });

  it("rejects packet generation when viewerUserId is omitted", async () => {
    await expect(
      generateDealCopilotPacket({} as any, { dealId: "deal-1", forceRegenerate: true })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "viewerUserId required to generate copilot packet",
    } satisfies Partial<AppError>);
  });

  it("threads viewer identity, role, and timestamp through forced regeneration", async () => {
    const getDealCopilotContext = vi.fn(async () => ({
      deal: { id: "deal-1", name: "Alpha Plaza", stageName: "Estimating", proposalStatus: "drafting" },
      recentActivities: [],
      recentEmails: [],
      taskSummary: { openTaskCount: 0, overdueTaskCount: 0 },
    }));
    const getDealBlindSpotSignals = vi.fn(async () => []);
    const now = new Date("2026-04-15T12:00:00.000Z");

    await regenerateDealCopilot(
      {} as any,
      { dealId: "deal-1", viewerUserId: "user-99", viewerRole: "director" },
      {
        getDealCopilotContext,
        getDealBlindSpotSignals,
        searchDealKnowledge: vi.fn(async () => []),
        provider: {
          generateCopilotPacket: vi.fn(async () => ({
            summary: "Summary",
            recommendedNextStep: { action: "Action", ownerId: null, dueLabel: null, rationale: "Why" },
            suggestedTasks: [],
            blindSpotFlags: [],
            confidence: 0.5,
            evidence: [],
          })),
          generateInterventionCopilotPacket: vi.fn(async () => ({
            summary: "Intervention summary",
            recommendedAction: {
              action: "investigate",
              rationale: "Review the case context.",
              suggestedOwner: null,
              suggestedOwnerId: null,
            },
            rootCause: null,
            blockerOwner: null,
            reopenRisk: null,
            blindSpotFlags: [],
            evidence: [],
            confidence: 0.5,
          })),
        },
        getExistingFreshPacket: vi.fn(async () => null),
        persistPacketBundle: vi.fn(async () => ({
          packetId: "packet-1",
          generatedAt: "2026-04-15T12:00:00.000Z",
        })),
        now,
      }
    );

    expect(getDealCopilotContext).toHaveBeenCalledWith(expect.anything(), "deal-1", "user-99", {
      viewerRole: "director",
      now,
    });
    expect(getDealBlindSpotSignals).toHaveBeenCalledWith(expect.anything(), "deal-1", {
      viewerRole: "director",
      now,
    });
  });

  it("does not hide the deal copilot packet when the deal includes another user's assigned emails", async () => {
    const tenantDb = {
      execute: vi.fn(async () => ({ rows: [] })),
      select: vi.fn(() => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          orderBy: vi.fn(() => chain),
          limit: vi.fn(async () => []),
          then(resolve: (value: any[]) => void) {
            resolve([]);
          },
        };
        return chain;
      }),
    } as any;

    const view = await getDealCopilotView(tenantDb, "deal-1", "user-1");

    expect(view).toEqual({
      packet: null,
      suggestedTasks: [],
      blindSpotFlags: [],
    });
    expect(tenantDb.select).toHaveBeenCalled();
    const guardQuerySql = flattenQueryChunks(tenantDb.execute.mock.calls[0]?.[0]).map((chunk) => String(chunk)).join(" ");
    expect(guardQuerySql).toContain("deal");
    expect(guardQuerySql).toContain("assigned_entity_type");
    expect(guardQuerySql).toContain("assigned_entity_id");
    expect(guardQuerySql).toContain("ignored");
    expect(guardQuerySql).not.toContain("user_id <>");
  });

  it("builds stale-stage disconnect rows from the hold-aware At Risk engine", async () => {
    const now = new Date("2026-04-15T00:00:00.000Z");
    const tenantDb = {
      execute: vi.fn(async () => ({
        rows: [
          {
            id: "deal-held",
            deal_number: "D-1001",
            deal_name: "Held Plaza",
            company_id: "company-1",
            company_name: "Acme",
            stage_key: "estimating",
            stage_slug: "estimating",
            workflow_route: "normal",
            stage_name: "Estimating",
            estimating_substage: null,
            assigned_rep_id: "rep-1",
            assigned_rep_name: "Rep One",
            stage_entered_at: "2026-03-01T00:00:00.000Z",
            on_hold: true,
            on_hold_started_at: "2026-04-10T00:00:00.000Z",
            on_hold_accumulated_seconds: 0,
            on_hold_accumulated_seconds_at_stage_entry: 0,
            last_activity_at: null,
            proposal_status: null,
            procore_project_id: null,
            procore_last_synced_at: null,
            open_task_count: 1,
            inbound_without_followup_count: 0,
            latest_customer_email_at: null,
            required_document_count: 0,
            present_document_count: 0,
            procore_sync_status: null,
            procore_sync_direction: null,
            procore_sync_updated_at: null,
            procore_drift_reason: null,
          },
          {
            id: "deal-risk",
            deal_number: "D-1002",
            deal_name: "Risk Tower",
            company_id: "company-1",
            company_name: "Acme",
            stage_key: "estimating",
            stage_slug: "estimating",
            workflow_route: "normal",
            stage_name: "Estimating",
            estimating_substage: null,
            assigned_rep_id: "rep-1",
            assigned_rep_name: "Rep One",
            stage_entered_at: "2026-03-01T00:00:00.000Z",
            on_hold: false,
            on_hold_started_at: null,
            on_hold_accumulated_seconds: 0,
            on_hold_accumulated_seconds_at_stage_entry: 0,
            last_activity_at: null,
            proposal_status: null,
            procore_project_id: null,
            procore_last_synced_at: null,
            open_task_count: 1,
            inbound_without_followup_count: 0,
            latest_customer_email_at: null,
            required_document_count: 0,
            present_document_count: 0,
            procore_sync_status: null,
            procore_sync_direction: null,
            procore_sync_updated_at: null,
            procore_drift_reason: null,
          },
        ],
      })),
    };

    const rows = await listCurrentSalesProcessDisconnectRows(tenantDb as any, { now } as any);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "deal-risk",
      disconnectType: "stale_stage",
      ageDays: 45,
    });
    const querySql = flattenQueryChunks(tenantDb.execute.mock.calls[0]?.[0]).map((chunk) => String(chunk)).join(" ");
    expect(querySql).toContain("on_hold");
    expect(querySql).toContain("bid_board_stage_slug");
    expect(querySql).not.toContain("stale_threshold_days");
  });

  it("uses the same engine-driven disconnect population for dashboard counts and rows", async () => {
    const now = new Date("2026-04-15T00:00:00.000Z");
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ active_deals: 2 }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: "deal-held",
              deal_number: "D-1001",
              deal_name: "Held Plaza",
              company_id: null,
              company_name: null,
              stage_key: "estimating",
              stage_slug: "estimating",
              workflow_route: "normal",
              stage_name: "Estimating",
              estimating_substage: null,
              assigned_rep_id: "rep-1",
              assigned_rep_name: "Rep One",
              stage_entered_at: "2026-03-01T00:00:00.000Z",
              on_hold: true,
              on_hold_started_at: "2026-04-10T00:00:00.000Z",
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
              last_activity_at: null,
              proposal_status: null,
              procore_project_id: null,
              procore_last_synced_at: null,
              open_task_count: 1,
              inbound_without_followup_count: 0,
              latest_customer_email_at: null,
              required_document_count: 0,
              present_document_count: 0,
              procore_sync_status: null,
              procore_sync_direction: null,
              procore_sync_updated_at: null,
              procore_drift_reason: null,
            },
            {
              id: "deal-risk",
              deal_number: "D-1002",
              deal_name: "Risk Tower",
              company_id: null,
              company_name: null,
              stage_key: "estimating",
              stage_slug: "estimating",
              workflow_route: "normal",
              stage_name: "Estimating",
              estimating_substage: null,
              assigned_rep_id: "rep-1",
              assigned_rep_name: "Rep One",
              stage_entered_at: "2026-03-01T00:00:00.000Z",
              on_hold: false,
              on_hold_started_at: null,
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
              last_activity_at: null,
              proposal_status: null,
              procore_project_id: null,
              procore_last_synced_at: null,
              open_task_count: 1,
              inbound_without_followup_count: 0,
              latest_customer_email_at: null,
              required_document_count: 0,
              present_document_count: 0,
              procore_sync_status: null,
              procore_sync_direction: null,
              procore_sync_updated_at: null,
              procore_drift_reason: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ digest_notifications_7d: 0, escalation_notifications_7d: 0, admin_tasks_created_7d: 0, admin_tasks_open: 0 }] }),
    };

    const dashboard = await getSalesProcessDisconnectDashboard(tenantDb as any, { now } as any);

    expect(dashboard.summary.activeDeals).toBe(2);
    expect(dashboard.summary.staleStageCount).toBe(1);
    expect(dashboard.byType).toEqual([
      { disconnectType: "stale_stage", label: "Stalled in stage", count: 1 },
    ]);
    expect(dashboard.rows.map((row) => row.id)).toEqual(["deal-risk"]);
  });
});
