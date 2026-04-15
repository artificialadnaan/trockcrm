import crypto from "crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, desc, eq } from "drizzle-orm";
import type * as schema from "@trock-crm/shared/schema";
import {
  aiCopilotPackets,
  aiFeedback,
  aiRiskFlags,
  aiTaskSuggestions,
  deals,
} from "@trock-crm/shared/schema";
import { getDealCopilotContext } from "./context-service.js";
import { getDealBlindSpotSignals } from "./signal-service.js";
import { searchDealKnowledge } from "./retrieval-service.js";
import type { AiCopilotProvider } from "./provider.js";
import type { DealBlindSpotSignal } from "./signal-service.js";
import type { DealCopilotContext } from "./context-service.js";
import type { DealKnowledgeChunk } from "./retrieval-service.js";
import type { DealCopilotPromptOutput } from "./prompt-contract.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface GenerateDealCopilotPacketInput {
  dealId: string;
  forceRegenerate?: boolean;
}

export interface PersistedPacketBundleResult {
  packetId: string;
  generatedAt: string;
}

export interface ExistingFreshPacket {
  packetId: string;
  snapshotHash: string;
  summary: string;
  generatedAt: string;
}

export interface GenerateDealCopilotPacketResult {
  packetId: string;
  snapshotHash: string;
  summary: string;
  generatedAt: string;
}

interface GenerateDealCopilotPacketDeps {
  getDealCopilotContext: (tenantDb: TenantDb, dealId: string) => Promise<DealCopilotContext>;
  getDealBlindSpotSignals: (tenantDb: TenantDb, dealId: string, now?: Date) => Promise<DealBlindSpotSignal[]>;
  searchDealKnowledge: (tenantDb: TenantDb, input: { dealId: string; embedding: number[]; limit?: number }) => Promise<DealKnowledgeChunk[]>;
  provider: AiCopilotProvider;
  persistPacketBundle: (payload: {
    packet: {
      scopeType: "deal";
      scopeId: string;
      dealId: string;
      packetKind: "deal";
      snapshotHash: string;
      summary: string;
      confidence: number;
      evidence: Array<Record<string, unknown>>;
      generatedAt: string;
    };
    suggestedTasks: DealCopilotPromptOutput["suggestedTasks"];
    blindSpotFlags: DealCopilotPromptOutput["blindSpotFlags"];
  }) => Promise<PersistedPacketBundleResult>;
  getExistingFreshPacket: (input: { dealId: string; snapshotHash: string; now: Date }) => Promise<ExistingFreshPacket | null>;
  now: Date;
}

function createSnapshotHash(input: {
  context: DealCopilotContext;
  signals: DealBlindSpotSignal[];
}): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

const DEFAULT_DEPS: GenerateDealCopilotPacketDeps = {
  getDealCopilotContext,
  getDealBlindSpotSignals,
  searchDealKnowledge,
  provider: {
    async generateCopilotPacket() {
      throw new Error("AI copilot provider is not configured yet");
    },
  },
  persistPacketBundle: async (payload) => {
    throw new Error("Packet persistence is not configured yet");
  },
  getExistingFreshPacket: async () => null,
  now: new Date(),
};

export async function generateDealCopilotPacket(
  tenantDb: TenantDb,
  input: GenerateDealCopilotPacketInput,
  overrides: Partial<GenerateDealCopilotPacketDeps> = {}
): Promise<GenerateDealCopilotPacketResult> {
  const deps = { ...DEFAULT_DEPS, ...overrides } as GenerateDealCopilotPacketDeps;
  const context = await deps.getDealCopilotContext(tenantDb, input.dealId);
  const signals = await deps.getDealBlindSpotSignals(tenantDb, input.dealId, deps.now);
  const snapshotHash = createSnapshotHash({ context, signals });

  if (!input.forceRegenerate) {
    const existing = overrides.getExistingFreshPacket
      ? await deps.getExistingFreshPacket({
          dealId: input.dealId,
          snapshotHash,
          now: deps.now,
        })
      : await getExistingFreshPacket({
          tenantDb,
          dealId: input.dealId,
          snapshotHash,
          now: deps.now,
        });
    if (existing) {
      return existing;
    }
  }

  const evidence = await deps.searchDealKnowledge(tenantDb, {
    dealId: input.dealId,
    embedding: Array.from({ length: 1536 }, () => 0),
    limit: 5,
  });

  const generated = await deps.provider.generateCopilotPacket({
    context,
    signals,
    evidence,
  });

  const persistencePayload = {
    packet: {
      scopeType: "deal" as const,
      scopeId: input.dealId,
      dealId: input.dealId,
      packetKind: "deal" as const,
      snapshotHash,
      summary: generated.summary,
      confidence: generated.confidence,
      evidence: generated.evidence,
      generatedAt: deps.now.toISOString(),
    },
    suggestedTasks: generated.suggestedTasks,
    blindSpotFlags: generated.blindSpotFlags,
  };

  const persisted = overrides.persistPacketBundle
    ? await deps.persistPacketBundle(persistencePayload)
    : await persistPacketBundle(tenantDb, persistencePayload);

  return {
    packetId: persisted.packetId,
    snapshotHash,
    summary: generated.summary,
    generatedAt: persisted.generatedAt,
  };
}

export async function getDealCopilotView(tenantDb: TenantDb, dealId: string) {
  const [packet] = await tenantDb
    .select()
    .from(aiCopilotPackets)
    .where(and(eq(aiCopilotPackets.scopeType, "deal"), eq(aiCopilotPackets.scopeId, dealId)))
    .orderBy(desc(aiCopilotPackets.createdAt))
    .limit(1);

  const suggestedTasks = await tenantDb
    .select()
    .from(aiTaskSuggestions)
    .where(and(eq(aiTaskSuggestions.scopeType, "deal"), eq(aiTaskSuggestions.scopeId, dealId)))
    .orderBy(desc(aiTaskSuggestions.createdAt));

  const blindSpotFlags = await tenantDb
    .select()
    .from(aiRiskFlags)
    .where(and(eq(aiRiskFlags.scopeType, "deal"), eq(aiRiskFlags.scopeId, dealId)))
    .orderBy(desc(aiRiskFlags.createdAt));

  return {
    packet: packet ?? null,
    suggestedTasks,
    blindSpotFlags,
  };
}

export async function regenerateDealCopilot(tenantDb: TenantDb, dealId: string) {
  return generateDealCopilotPacket(tenantDb, { dealId, forceRegenerate: true });
}

export async function dismissTaskSuggestion(
  tenantDb: TenantDb,
  suggestionId: string,
  _userId: string
) {
  const [updated] = await tenantDb
    .update(aiTaskSuggestions)
    .set({
      status: "dismissed",
      resolvedAt: new Date(),
    })
    .where(eq(aiTaskSuggestions.id, suggestionId))
    .returning();

  return updated ?? null;
}

export async function recordAiFeedback(
  tenantDb: TenantDb,
  input: {
    targetType: string;
    targetId: string;
    userId: string;
    feedbackType: string;
    feedbackValue: string;
    comment: string | null;
  }
) {
  const [created] = await tenantDb
    .insert(aiFeedback)
    .values({
      targetType: input.targetType,
      targetId: input.targetId,
      userId: input.userId,
      feedbackType: input.feedbackType,
      feedbackValue: input.feedbackValue,
      comment: input.comment,
    })
    .returning();

  return created;
}

export async function getDirectorBlindSpots(tenantDb: TenantDb) {
  const rows = await tenantDb
    .select({
      id: aiRiskFlags.id,
      dealId: aiRiskFlags.dealId,
      title: aiRiskFlags.title,
      severity: aiRiskFlags.severity,
      status: aiRiskFlags.status,
      details: aiRiskFlags.details,
      createdAt: aiRiskFlags.createdAt,
      dealName: deals.name,
      dealNumber: deals.dealNumber,
    })
    .from(aiRiskFlags)
    .leftJoin(deals, eq(aiRiskFlags.dealId, deals.id))
    .where(eq(aiRiskFlags.status, "open"))
    .orderBy(desc(aiRiskFlags.createdAt))
    .limit(25);

  return rows;
}

async function persistPacketBundle(
  tenantDb: TenantDb,
  payload: {
    packet: {
      scopeType: "deal";
      scopeId: string;
      dealId: string;
      packetKind: "deal";
      snapshotHash: string;
      summary: string;
      confidence: number;
      evidence: Array<Record<string, unknown>>;
      generatedAt: string;
    };
    suggestedTasks: DealCopilotPromptOutput["suggestedTasks"];
    blindSpotFlags: DealCopilotPromptOutput["blindSpotFlags"];
  }
): Promise<PersistedPacketBundleResult> {
  const [packet] = await tenantDb
    .insert(aiCopilotPackets)
    .values({
      scopeType: payload.packet.scopeType,
      scopeId: payload.packet.scopeId,
      dealId: payload.packet.dealId,
      packetKind: payload.packet.packetKind,
      snapshotHash: payload.packet.snapshotHash,
      status: "ready",
      summaryText: payload.packet.summary,
      evidenceJson: payload.packet.evidence,
      confidence: String(payload.packet.confidence),
      generatedAt: new Date(payload.packet.generatedAt),
      updatedAt: new Date(),
    })
    .returning();

  if (payload.suggestedTasks.length > 0) {
    await tenantDb.insert(aiTaskSuggestions).values(
      payload.suggestedTasks.map((task) => ({
        packetId: packet.id,
        scopeType: payload.packet.scopeType,
        scopeId: payload.packet.scopeId,
        title: task.title,
        description: task.description,
        suggestedOwnerId: task.suggestedOwnerId,
        priority: task.priority,
        confidence: String(task.confidence),
        evidenceJson: task.evidence,
      }))
    );
  }

  if (payload.blindSpotFlags.length > 0) {
    await tenantDb.insert(aiRiskFlags).values(
      payload.blindSpotFlags.map((flag) => ({
        packetId: packet.id,
        scopeType: payload.packet.scopeType,
        scopeId: payload.packet.scopeId,
        dealId: payload.packet.dealId,
        flagType: flag.flagType,
        severity: flag.severity,
        title: flag.title,
        details: flag.details,
        evidenceJson: flag.evidence,
      }))
    );
  }

  return {
    packetId: packet.id,
    generatedAt: packet.generatedAt?.toISOString() ?? payload.packet.generatedAt,
  };
}

async function getExistingFreshPacket(input: {
  tenantDb: TenantDb;
  dealId: string;
  snapshotHash: string;
  now: Date;
}): Promise<ExistingFreshPacket | null> {
  const [packet] = await input.tenantDb
    .select()
    .from(aiCopilotPackets)
    .where(
      and(
        eq(aiCopilotPackets.scopeType, "deal"),
        eq(aiCopilotPackets.scopeId, input.dealId),
        eq(aiCopilotPackets.snapshotHash, input.snapshotHash),
      )
    )
    .orderBy(desc(aiCopilotPackets.createdAt))
    .limit(1);

  if (!packet) return null;

  return {
    packetId: packet.id,
    snapshotHash: packet.snapshotHash,
    summary: packet.summaryText ?? "",
    generatedAt: packet.generatedAt?.toISOString() ?? packet.createdAt.toISOString(),
  };
}
