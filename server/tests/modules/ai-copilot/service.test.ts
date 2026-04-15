import { describe, expect, it, vi } from "vitest";

const { generateDealCopilotPacket } = await import("../../../src/modules/ai-copilot/service.js");

describe("AI copilot service", () => {
  it("assembles context, signals, retrieval evidence, and persists one packet bundle", async () => {
    const callOrder: string[] = [];
    const tenantDb = {} as any;
    const persistedAt = new Date("2026-04-15T12:00:00.000Z");

    const result = await generateDealCopilotPacket(
      tenantDb,
      { dealId: "deal-1", forceRegenerate: true },
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

  it("reuses a fresh packet when the snapshot hash is unchanged", async () => {
    const result = await generateDealCopilotPacket(
      {} as any,
      { dealId: "deal-1", forceRegenerate: false },
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
      { dealId: "deal-1", forceRegenerate: false },
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
});
