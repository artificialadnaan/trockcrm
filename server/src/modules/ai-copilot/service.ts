import crypto from "crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
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
import { buildDealRetrievalQuery } from "./document-service.js";
import type { AiCopilotProvider } from "./provider.js";
import { getAiCopilotProvider } from "./provider.js";
import type { DealBlindSpotSignal } from "./signal-service.js";
import type { DealCopilotContext } from "./context-service.js";
import type { DealKnowledgeChunk } from "./retrieval-service.js";
import type { DealCopilotPromptOutput } from "./prompt-contract.js";

type TenantDb = NodePgDatabase<typeof schema>;
const PACKET_TTL_MS = 30 * 60 * 1000;

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

export interface AiOpsMetrics {
  packetsGenerated24h: number;
  packetsPending: number;
  avgConfidence7d: number | null;
  openBlindSpots: number;
  suggestionsAccepted30d: number;
  suggestionsDismissed30d: number;
  positiveFeedback30d: number;
  negativeFeedback30d: number;
  documentsIndexed: number;
  documentsPending: number;
  documentStatusBySource: Array<{
    sourceType: string;
    indexed: number;
    pending: number;
  }>;
}

export interface AiReviewQueueEntry {
  packetId: string;
  dealId: string | null;
  dealName: string | null;
  dealNumber: string | null;
  status: string;
  summaryText: string | null;
  confidence: number | null;
  generatedAt: string | null;
  createdAt: string;
  suggestedCount: number;
  acceptedCount: number;
  dismissedCount: number;
  openBlindSpotCount: number;
  positiveFeedbackCount: number;
  negativeFeedbackCount: number;
}

export interface AiReviewPacketDetail {
  packet: ({
    id: string;
    createdAt: Date;
    updatedAt: Date;
    dealId: string | null;
    status: string;
    expiresAt: Date | null;
    scopeType: string;
    scopeId: string;
    packetKind: string;
    snapshotHash: string;
    summaryText: string | null;
    summaryData: unknown;
    confidence: string | number | null;
    evidenceJson: unknown;
    providerName: string | null;
    modelName: string | null;
    generatedAt: Date | null;
    dealName: string | null;
    dealNumber: string | null;
  } & {
    dealName: string | null;
    dealNumber: string | null;
  }) | null;
  suggestedTasks: Array<typeof aiTaskSuggestions.$inferSelect>;
  blindSpotFlags: Array<typeof aiRiskFlags.$inferSelect>;
  feedback: Array<typeof aiFeedback.$inferSelect>;
}

interface GenerateDealCopilotPacketDeps {
  getDealCopilotContext: (tenantDb: TenantDb, dealId: string) => Promise<DealCopilotContext>;
  getDealBlindSpotSignals: (tenantDb: TenantDb, dealId: string, now?: Date) => Promise<DealBlindSpotSignal[]>;
  searchDealKnowledge: (
    tenantDb: TenantDb,
    input: { dealId: string; embedding: number[]; queryText?: string; limit?: number }
  ) => Promise<DealKnowledgeChunk[]>;
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
      expiresAt: string;
    };
    suggestedTasks: DealCopilotPromptOutput["suggestedTasks"];
    blindSpotFlags: DealCopilotPromptOutput["blindSpotFlags"];
  }) => Promise<PersistedPacketBundleResult>;
  getExistingFreshPacket: (input: { dealId: string; snapshotHash: string; now: Date }) => Promise<ExistingFreshPacket | null>;
  now: Date;
}

type QueryResultRow = Record<string, any>;

function getRows(result: unknown): QueryResultRow[] {
  if (Array.isArray(result)) return result as QueryResultRow[];
  if (result && typeof result === "object" && "rows" in result) {
    return ((result as { rows?: QueryResultRow[] }).rows ?? []) as QueryResultRow[];
  }
  return [];
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
  provider: getAiCopilotProvider(),
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
    queryText: buildDealRetrievalQuery({ context, signals }),
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
      expiresAt: new Date(deps.now.getTime() + PACKET_TTL_MS).toISOString(),
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

  const suggestedTasks = packet
    ? await tenantDb
        .select()
        .from(aiTaskSuggestions)
        .where(eq(aiTaskSuggestions.packetId, packet.id))
        .orderBy(desc(aiTaskSuggestions.createdAt))
    : [];

  const blindSpotFlags = packet
    ? await tenantDb
        .select()
        .from(aiRiskFlags)
        .where(eq(aiRiskFlags.packetId, packet.id))
        .orderBy(desc(aiRiskFlags.createdAt))
    : [];

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

export async function getAiOpsMetrics(tenantDb: TenantDb): Promise<AiOpsMetrics> {
  const [summaryResult, documentResult] = await Promise.all([
    tenantDb.execute(sql`
      WITH packet_counts AS (
        SELECT
          COUNT(*) FILTER (WHERE generated_at >= NOW() - INTERVAL '24 hours')::int AS packets_generated_24h,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS packets_pending,
          AVG(confidence) FILTER (WHERE generated_at >= NOW() - INTERVAL '7 days' AND confidence IS NOT NULL) AS avg_confidence_7d
        FROM ai_copilot_packets
      ),
      risk_counts AS (
        SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open_blind_spots
        FROM ai_risk_flags
      ),
      suggestion_counts AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'accepted' AND resolved_at >= NOW() - INTERVAL '30 days')::int AS suggestions_accepted_30d,
          COUNT(*) FILTER (WHERE status = 'dismissed' AND resolved_at >= NOW() - INTERVAL '30 days')::int AS suggestions_dismissed_30d
        FROM ai_task_suggestions
      ),
      feedback_counts AS (
        SELECT
          COUNT(*) FILTER (WHERE feedback_value IN ('useful', 'thumbs_up') AND created_at >= NOW() - INTERVAL '30 days')::int AS positive_feedback_30d,
          COUNT(*) FILTER (WHERE feedback_value IN ('not_useful', 'thumbs_down', 'wrong') AND created_at >= NOW() - INTERVAL '30 days')::int AS negative_feedback_30d
        FROM ai_feedback
      ),
      document_counts AS (
        SELECT
          COUNT(*) FILTER (WHERE index_status = 'indexed')::int AS documents_indexed,
          COUNT(*) FILTER (WHERE index_status <> 'indexed')::int AS documents_pending
        FROM ai_document_index
      )
      SELECT
        packet_counts.packets_generated_24h,
        packet_counts.packets_pending,
        packet_counts.avg_confidence_7d,
        risk_counts.open_blind_spots,
        suggestion_counts.suggestions_accepted_30d,
        suggestion_counts.suggestions_dismissed_30d,
        feedback_counts.positive_feedback_30d,
        feedback_counts.negative_feedback_30d,
        document_counts.documents_indexed,
        document_counts.documents_pending
      FROM packet_counts, risk_counts, suggestion_counts, feedback_counts, document_counts
    `),
    tenantDb.execute(sql`
      SELECT
        source_type,
        COUNT(*) FILTER (WHERE index_status = 'indexed')::int AS indexed,
        COUNT(*) FILTER (WHERE index_status <> 'indexed')::int AS pending
      FROM ai_document_index
      GROUP BY source_type
      ORDER BY source_type ASC
    `),
  ]);

  const summaryRow = getRows(summaryResult)[0] ?? {};

  return {
    packetsGenerated24h: Number(summaryRow.packets_generated_24h ?? 0),
    packetsPending: Number(summaryRow.packets_pending ?? 0),
    avgConfidence7d: summaryRow.avg_confidence_7d == null ? null : Number(summaryRow.avg_confidence_7d),
    openBlindSpots: Number(summaryRow.open_blind_spots ?? 0),
    suggestionsAccepted30d: Number(summaryRow.suggestions_accepted_30d ?? 0),
    suggestionsDismissed30d: Number(summaryRow.suggestions_dismissed_30d ?? 0),
    positiveFeedback30d: Number(summaryRow.positive_feedback_30d ?? 0),
    negativeFeedback30d: Number(summaryRow.negative_feedback_30d ?? 0),
    documentsIndexed: Number(summaryRow.documents_indexed ?? 0),
    documentsPending: Number(summaryRow.documents_pending ?? 0),
    documentStatusBySource: getRows(documentResult).map((row) => ({
      sourceType: row.source_type,
      indexed: Number(row.indexed ?? 0),
      pending: Number(row.pending ?? 0),
    })),
  };
}

export async function getAiReviewQueue(
  tenantDb: TenantDb,
  input: { limit?: number } = {}
): Promise<AiReviewQueueEntry[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const result = await tenantDb.execute(sql`
    SELECT
      p.id AS packet_id,
      p.deal_id,
      d.name AS deal_name,
      d.deal_number,
      p.status,
      p.summary_text,
      p.confidence,
      p.generated_at,
      p.created_at,
      COUNT(DISTINCT s.id)::int AS suggested_count,
      COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'accepted')::int AS accepted_count,
      COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'dismissed')::int AS dismissed_count,
      COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'open')::int AS open_blind_spot_count,
      COUNT(DISTINCT f.id) FILTER (WHERE f.feedback_value IN ('useful', 'thumbs_up'))::int AS positive_feedback_count,
      COUNT(DISTINCT f.id) FILTER (WHERE f.feedback_value IN ('not_useful', 'thumbs_down', 'wrong'))::int AS negative_feedback_count
    FROM ai_copilot_packets p
    LEFT JOIN deals d ON d.id = p.deal_id
    LEFT JOIN ai_task_suggestions s ON s.packet_id = p.id
    LEFT JOIN ai_risk_flags r ON r.packet_id = p.id
    LEFT JOIN ai_feedback f ON f.target_type = 'packet' AND f.target_id = p.id
    GROUP BY p.id, d.name, d.deal_number
    ORDER BY COALESCE(p.generated_at, p.created_at) DESC
    LIMIT ${limit}
  `);

  return getRows(result).map((row) => ({
    packetId: row.packet_id,
    dealId: row.deal_id ?? null,
    dealName: row.deal_name ?? null,
    dealNumber: row.deal_number ?? null,
    status: row.status,
    summaryText: row.summary_text ?? null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    generatedAt: row.generated_at ?? null,
    createdAt: row.created_at,
    suggestedCount: Number(row.suggested_count ?? 0),
    acceptedCount: Number(row.accepted_count ?? 0),
    dismissedCount: Number(row.dismissed_count ?? 0),
    openBlindSpotCount: Number(row.open_blind_spot_count ?? 0),
    positiveFeedbackCount: Number(row.positive_feedback_count ?? 0),
    negativeFeedbackCount: Number(row.negative_feedback_count ?? 0),
  }));
}

export async function getAiReviewPacketDetail(
  tenantDb: TenantDb,
  packetId: string
): Promise<AiReviewPacketDetail> {
  const [packetResult, suggestedTasks, blindSpotFlags, feedback] = await Promise.all([
    tenantDb.execute(sql`
      SELECT
        p.*,
        d.name AS deal_name,
        d.deal_number
      FROM ai_copilot_packets p
      LEFT JOIN deals d ON d.id = p.deal_id
      WHERE p.id = ${packetId}
      LIMIT 1
    `),
    tenantDb
      .select()
      .from(aiTaskSuggestions)
      .where(eq(aiTaskSuggestions.packetId, packetId))
      .orderBy(desc(aiTaskSuggestions.createdAt)),
    tenantDb
      .select()
      .from(aiRiskFlags)
      .where(eq(aiRiskFlags.packetId, packetId))
      .orderBy(desc(aiRiskFlags.createdAt)),
    tenantDb
      .select()
      .from(aiFeedback)
      .where(and(eq(aiFeedback.targetType, "packet"), eq(aiFeedback.targetId, packetId)))
      .orderBy(desc(aiFeedback.createdAt)),
  ]);

  const packetRow = getRows(packetResult)[0];

  return {
    packet: packetRow
      ? {
          id: String(packetRow.id),
          createdAt: packetRow.created_at as Date,
          updatedAt: packetRow.updated_at as Date,
          dealId: packetRow.deal_id ? String(packetRow.deal_id) : null,
          status: String(packetRow.status),
          expiresAt: (packetRow.expires_at as Date | null) ?? null,
          scopeType: String(packetRow.scope_type),
          scopeId: String(packetRow.scope_id),
          packetKind: String(packetRow.packet_kind),
          snapshotHash: String(packetRow.snapshot_hash),
          summaryText: (packetRow.summary_text as string | null) ?? null,
          summaryData: packetRow.summary_data,
          confidence: (packetRow.confidence as string | number | null) ?? null,
          evidenceJson: packetRow.evidence_json,
          providerName: (packetRow.provider_name as string | null) ?? null,
          modelName: (packetRow.model_name as string | null) ?? null,
          generatedAt: (packetRow.generated_at as Date | null) ?? null,
          ...packetRow,
          dealName: packetRow.deal_name ?? null,
          dealNumber: packetRow.deal_number ?? null,
        }
      : null,
    suggestedTasks,
    blindSpotFlags,
    feedback,
  };
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
      expiresAt: string;
    };
    suggestedTasks: DealCopilotPromptOutput["suggestedTasks"];
    blindSpotFlags: DealCopilotPromptOutput["blindSpotFlags"];
  }
): Promise<PersistedPacketBundleResult> {
  const supersededAt = new Date(payload.packet.generatedAt);

  await tenantDb
    .update(aiTaskSuggestions)
    .set({
      status: "dismissed",
      resolvedAt: supersededAt,
    })
    .where(
      and(
        eq(aiTaskSuggestions.scopeType, payload.packet.scopeType),
        eq(aiTaskSuggestions.scopeId, payload.packet.scopeId),
        eq(aiTaskSuggestions.status, "suggested"),
      )
    );

  await tenantDb
    .update(aiRiskFlags)
    .set({
      status: "resolved",
      resolvedAt: supersededAt,
    })
    .where(
      and(
        eq(aiRiskFlags.scopeType, payload.packet.scopeType),
        eq(aiRiskFlags.scopeId, payload.packet.scopeId),
        eq(aiRiskFlags.status, "open"),
      )
    );

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
      nextStepJson: payload.suggestedTasks[0]
        ? {
            title: payload.suggestedTasks[0].title,
            description: payload.suggestedTasks[0].description,
            suggestedOwnerId: payload.suggestedTasks[0].suggestedOwnerId,
            priority: payload.suggestedTasks[0].priority,
          }
        : null,
      blindSpotsJson: payload.blindSpotFlags,
      evidenceJson: payload.packet.evidence,
      confidence: String(payload.packet.confidence),
      generatedAt: new Date(payload.packet.generatedAt),
      expiresAt: new Date(payload.packet.expiresAt),
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
  if (packet.expiresAt && packet.expiresAt.getTime() <= input.now.getTime()) {
    return null;
  }

  return {
    packetId: packet.id,
    snapshotHash: packet.snapshotHash,
    summary: packet.summaryText ?? "",
    generatedAt: packet.generatedAt?.toISOString() ?? packet.createdAt.toISOString(),
  };
}
