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
  companies,
  contacts,
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
  triageActions30d: number;
  escalations30d: number;
  resolvedBlindSpots30d: number;
  recurringBlindSpotsOpen: number;
  recurringSuggestionsOpen: number;
  aiSearchInteractions30d: number;
  aiSearchQueriesWithClick30d: number;
  aiSearchWorkflowExecutions30d: number;
  aiSearchQueriesWithWorkflow30d: number;
  aiSearchQueriesServed30d: number;
  aiSearchWorkflowConversionRate30d: number | null;
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

export interface CompanyCopilotView {
  company: {
    id: string;
    name: string;
    contactCount: number;
    dealCount: number;
  };
  summaryText: string;
  relatedDeals: Array<{
    id: string;
    dealNumber: string;
    name: string;
    lastActivityAt: Date | null;
    updatedAt: Date;
    latestPacketSummary: string | null;
    latestPacketConfidence: number | null;
  }>;
  suggestedTasks: Array<typeof aiTaskSuggestions.$inferSelect>;
  blindSpotFlags: Array<typeof aiRiskFlags.$inferSelect>;
}

export interface AiActionQueueEntry {
  entryType: "blind_spot" | "task_suggestion";
  id: string;
  dealId: string | null;
  dealName: string | null;
  dealNumber: string | null;
  title: string;
  details: string | null;
  severity: string | null;
  priority: string | null;
  status: string;
  createdAt: string;
  suggestedDueAt: string | null;
  repeatCount: number;
  lastTriageAction: string | null;
  lastTriagedAt: string | null;
  escalated: boolean;
}

export interface SalesProcessDisconnectSummary {
  activeDeals: number;
  totalDisconnects: number;
  staleStageCount: number;
  missingNextTaskCount: number;
  inboundWithoutFollowupCount: number;
  revisionLoopCount: number;
  estimatingGateGapCount: number;
  procoreBidBoardDriftCount: number;
}

export interface SalesProcessDisconnectTypeSummary {
  disconnectType: string;
  label: string;
  count: number;
}

export interface SalesProcessDisconnectRow {
  id: string;
  dealNumber: string;
  dealName: string;
  companyId: string | null;
  companyName: string | null;
  stageName: string | null;
  estimatingSubstage: string | null;
  assignedRepName: string | null;
  disconnectType: string;
  disconnectLabel: string;
  disconnectSeverity: string;
  disconnectSummary: string;
  disconnectDetails: string | null;
  ageDays: number | null;
  openTaskCount: number;
  inboundWithoutFollowupCount: number;
  lastActivityAt: string | null;
  latestCustomerEmailAt: string | null;
  proposalStatus: string | null;
  procoreSyncStatus: string | null;
  procoreSyncDirection: string | null;
  procoreLastSyncedAt: string | null;
  procoreSyncUpdatedAt: string | null;
  procoreDriftReason: string | null;
}

export interface SalesProcessDisconnectTrendEntry {
  key: string;
  label: string;
  disconnectCount: number;
  dealCount: number;
  criticalCount: number;
  recentInterventionCount: number;
  clusterKeys: string[];
}

export interface SalesProcessDisconnectOutcomes {
  interventionDeals30d: number;
  clearedAfterIntervention30d: number;
  stillOpenAfterIntervention30d: number;
  unresolvedEscalationsOpen: number;
  repeatIssueDealsOpen: number;
  repeatClusterDealsOpen: number;
  interventionCoverageRate: number | null;
  clearanceRate30d: number | null;
}

export interface SalesProcessDisconnectActionSummary {
  markReviewed30d: number;
  resolve30d: number;
  dismiss30d: number;
  escalate30d: number;
  bestOverallAction: "mark_reviewed" | "resolve" | "dismiss" | "escalate" | null;
  bestOverallClearanceRate: number | null;
}

export interface SalesProcessDisconnectPlaybookAction {
  action: "mark_reviewed" | "resolve" | "dismiss" | "escalate";
  interventionDeals30d: number;
  clearedDeals30d: number;
  stillOpenDeals30d: number;
  clearanceRate30d: number | null;
}

export interface SalesProcessDisconnectPlaybook {
  clusterKey: string;
  title: string;
  bestAction: "mark_reviewed" | "resolve" | "dismiss" | "escalate" | null;
  recommendedAction: "mark_reviewed" | "resolve" | "dismiss" | "escalate" | null;
  interventionDeals30d: number;
  stillOpenDeals30d: number;
  actions: SalesProcessDisconnectPlaybookAction[];
}

export interface SalesProcessDisconnectCluster {
  clusterKey: string;
  title: string;
  summary: string;
  likelyRootCause: string;
  recommendedAction: string;
  severity: string;
  dealCount: number;
  disconnectCount: number;
  disconnectTypes: string[];
  stages: string[];
  reps: string[];
  includesProcoreBidBoard: boolean;
}

export interface SalesProcessDisconnectAutomationStatus {
  digestNotifications7d: number;
  escalationNotifications7d: number;
  adminTasksCreated7d: number;
  adminTasksOpen: number;
  latestDigestAt: string | null;
  latestEscalationAt: string | null;
  latestAdminTaskCreatedAt: string | null;
}

export interface SalesProcessDisconnectDashboard {
  summary: SalesProcessDisconnectSummary;
  automation: SalesProcessDisconnectAutomationStatus;
  byType: SalesProcessDisconnectTypeSummary[];
  clusters: SalesProcessDisconnectCluster[];
  trends: {
    reps: SalesProcessDisconnectTrendEntry[];
    stages: SalesProcessDisconnectTrendEntry[];
    companies: SalesProcessDisconnectTrendEntry[];
  };
  outcomes: SalesProcessDisconnectOutcomes;
  actionSummary: SalesProcessDisconnectActionSummary;
  playbooks: SalesProcessDisconnectPlaybook[];
  rows: SalesProcessDisconnectRow[];
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

function severityRank(value: string | null | undefined) {
  switch (value) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function getDisconnectClusterKey(disconnectType: string) {
  if (disconnectType === "procore_bid_board_drift") return "bid_board_sync_break";
  if (disconnectType === "revision_loop" || disconnectType === "estimating_gate_gap") {
    return "estimating_handoff_break";
  }
  if (disconnectType === "missing_next_task" || disconnectType === "inbound_without_followup") {
    return "follow_through_gap";
  }
  return "execution_stall";
}

function buildSalesProcessDisconnectClusters(rows: SalesProcessDisconnectRow[]): SalesProcessDisconnectCluster[] {
  const clusterMeta: Record<
    string,
    Pick<SalesProcessDisconnectCluster, "title" | "summary" | "likelyRootCause" | "recommendedAction">
  > = {
    bid_board_sync_break: {
      title: "Bid board / CRM stage drift",
      summary:
        "Procore bid-board or project sync state shows newer or conflicting stage movement than the CRM currently reflects.",
      likelyRootCause:
        "Bid-board updates are landing, but the CRM stage map or manual reconciliation step is lagging behind.",
      recommendedAction:
        "Review Procore sync conflicts first, reconcile the stage owner, and confirm the CRM stage mirrors the latest bid-board outcome.",
    },
    estimating_handoff_break: {
      title: "Estimating handoff break",
      summary:
        "Revision requests or missing required artifacts suggest sales and estimating are not closing the loop cleanly.",
      likelyRootCause:
        "Estimating requests are being handed off without the required files, ownership, or task coverage to move the deal forward.",
      recommendedAction:
        "Assign a clear estimator owner, attach the missing estimating artifacts, and create an explicit next-step task for the rep.",
    },
    follow_through_gap: {
      title: "Customer follow-through gap",
      summary:
        "Customer communication arrived or the deal changed state, but no logged next step exists to continue the conversation.",
      likelyRootCause:
        "Inbound customer activity is not consistently turning into follow-up tasks or logged outreach from sales/admin staff.",
      recommendedAction:
        "Create the next customer-response task immediately and verify the rep or office owner is accountable for the follow-up window.",
    },
    execution_stall: {
      title: "Execution stall",
      summary:
        "Deals are sitting in-stage beyond expected thresholds, which usually means work is happening off-system or not happening at all.",
      likelyRootCause:
        "The current stage has no active execution owner, or status changes are occurring without corresponding CRM activity updates.",
      recommendedAction:
        "Review stage owner coverage, confirm what work is actually pending, and either progress the deal or create the missing task trail.",
    },
  };

  const grouped = new Map<
    string,
    {
      rows: SalesProcessDisconnectRow[];
      severity: string;
      severityRank: number;
      disconnectTypes: Set<string>;
      stages: Set<string>;
      reps: Set<string>;
      dealIds: Set<string>;
      includesProcoreBidBoard: boolean;
    }
  >();

  for (const row of rows) {
    const clusterKey = getDisconnectClusterKey(row.disconnectType);
    const existing = grouped.get(clusterKey);
    const rank = severityRank(row.disconnectSeverity);
    if (!existing) {
      grouped.set(clusterKey, {
        rows: [row],
        severity: row.disconnectSeverity,
        severityRank: rank,
        disconnectTypes: new Set([row.disconnectType]),
        stages: new Set(row.stageName ? [row.stageName] : []),
        reps: new Set(row.assignedRepName ? [row.assignedRepName] : []),
        dealIds: new Set([row.id]),
        includesProcoreBidBoard: row.disconnectType === "procore_bid_board_drift",
      });
      continue;
    }

    existing.rows.push(row);
    existing.disconnectTypes.add(row.disconnectType);
    if (row.stageName) existing.stages.add(row.stageName);
    if (row.assignedRepName) existing.reps.add(row.assignedRepName);
    existing.dealIds.add(row.id);
    if (row.disconnectType === "procore_bid_board_drift") {
      existing.includesProcoreBidBoard = true;
    }
    if (rank > existing.severityRank) {
      existing.severityRank = rank;
      existing.severity = row.disconnectSeverity;
    }
  }

  return Array.from(grouped.entries())
    .map(([clusterKey, group]) => {
      const meta = clusterMeta[clusterKey];
      return {
        clusterKey,
        title: meta.title,
        summary: meta.summary,
        likelyRootCause: meta.likelyRootCause,
        recommendedAction: meta.recommendedAction,
        severity: group.severity,
        dealCount: group.dealIds.size,
        disconnectCount: group.rows.length,
        disconnectTypes: Array.from(group.disconnectTypes).sort(),
        stages: Array.from(group.stages).sort(),
        reps: Array.from(group.reps).sort(),
        includesProcoreBidBoard: group.includesProcoreBidBoard,
      };
    })
    .sort((a, b) => {
      const severityDelta = severityRank(b.severity) - severityRank(a.severity);
      if (severityDelta !== 0) return severityDelta;
      if (b.dealCount !== a.dealCount) return b.dealCount - a.dealCount;
      if (b.disconnectCount !== a.disconnectCount) return b.disconnectCount - a.disconnectCount;
      return a.title.localeCompare(b.title);
    });
}

function buildSalesProcessDisconnectTrends(
  rows: SalesProcessDisconnectRow[],
  interventionsByDeal: Map<string, { interventionCount30d: number }>
) {
  const buildDimension = (
    getKey: (row: SalesProcessDisconnectRow) => string | null,
    getLabel: (row: SalesProcessDisconnectRow) => string | null
  ): SalesProcessDisconnectTrendEntry[] => {
    const grouped = new Map<
      string,
      {
        label: string;
        disconnectCount: number;
        dealIds: Set<string>;
        criticalCount: number;
        interventionDealIds: Set<string>;
        clusterKeys: Set<string>;
      }
    >();

    for (const row of rows) {
      const key = getKey(row);
      const label = getLabel(row);
      if (!key || !label) continue;
      const existing = grouped.get(key);
      if (!existing) {
        const intervention = interventionsByDeal.has(row.id);
        grouped.set(key, {
          label,
          disconnectCount: 1,
          dealIds: new Set([row.id]),
          criticalCount: row.disconnectSeverity === "critical" ? 1 : 0,
          interventionDealIds: intervention ? new Set([row.id]) : new Set(),
          clusterKeys: new Set([getDisconnectClusterKey(row.disconnectType)]),
        });
        continue;
      }

      existing.disconnectCount += 1;
      existing.dealIds.add(row.id);
      if (row.disconnectSeverity === "critical") existing.criticalCount += 1;
      if (interventionsByDeal.has(row.id)) existing.interventionDealIds.add(row.id);
      existing.clusterKeys.add(getDisconnectClusterKey(row.disconnectType));
    }

    return Array.from(grouped.entries())
      .map(([key, value]) => ({
        key,
        label: value.label,
        disconnectCount: value.disconnectCount,
        dealCount: value.dealIds.size,
        criticalCount: value.criticalCount,
        recentInterventionCount: value.interventionDealIds.size,
        clusterKeys: Array.from(value.clusterKeys).sort(),
      }))
      .sort((a, b) => {
        if (b.disconnectCount !== a.disconnectCount) return b.disconnectCount - a.disconnectCount;
        if (b.criticalCount !== a.criticalCount) return b.criticalCount - a.criticalCount;
        return a.label.localeCompare(b.label);
      })
      .slice(0, 5);
  };

  return {
    reps: buildDimension(
      (row) => row.assignedRepName,
      (row) => row.assignedRepName
    ),
    stages: buildDimension(
      (row) => row.stageName,
      (row) => row.stageName
    ),
    companies: buildDimension(
      (row) => row.companyId,
      (row) => row.companyName
    ),
  };
}

function buildSalesProcessDisconnectOutcomes(
  rows: SalesProcessDisconnectRow[],
  interventionsByDeal: Map<string, { interventionCount30d: number; latestAction: string | null }>
): SalesProcessDisconnectOutcomes {
  const openDealIds = new Set(rows.map((row) => row.id));
  const interventionDealIds = Array.from(interventionsByDeal.keys());
  const clearedAfterIntervention = interventionDealIds.filter((dealId) => !openDealIds.has(dealId)).length;
  const stillOpenAfterIntervention = interventionDealIds.filter((dealId) => openDealIds.has(dealId)).length;
  const unresolvedEscalationsOpen = interventionDealIds.filter((dealId) => {
    const intervention = interventionsByDeal.get(dealId);
    return intervention?.latestAction === "escalate" && openDealIds.has(dealId);
  }).length;

  const disconnectCountsByDeal = new Map<string, number>();
  const clusterCountsByDeal = new Map<string, Set<string>>();
  for (const row of rows) {
    disconnectCountsByDeal.set(row.id, (disconnectCountsByDeal.get(row.id) ?? 0) + 1);
    const clusters = clusterCountsByDeal.get(row.id) ?? new Set<string>();
    clusters.add(getDisconnectClusterKey(row.disconnectType));
    clusterCountsByDeal.set(row.id, clusters);
  }

  const repeatIssueDealsOpen = Array.from(disconnectCountsByDeal.values()).filter((count) => count > 1).length;
  const repeatClusterDealsOpen = Array.from(clusterCountsByDeal.values()).filter((clusters) => clusters.size > 1).length;

  return {
    interventionDeals30d: interventionDealIds.length,
    clearedAfterIntervention30d: clearedAfterIntervention,
    stillOpenAfterIntervention30d: stillOpenAfterIntervention,
    unresolvedEscalationsOpen,
    repeatIssueDealsOpen,
    repeatClusterDealsOpen,
    interventionCoverageRate: openDealIds.size === 0 ? null : Number((stillOpenAfterIntervention / openDealIds.size).toFixed(4)),
    clearanceRate30d:
      interventionDealIds.length === 0 ? null : Number((clearedAfterIntervention / interventionDealIds.length).toFixed(4)),
  };
}

function parseTriageMetadata(commentText: string | null | undefined) {
  if (!commentText) return null;
  try {
    const parsed = JSON.parse(commentText) as {
      note?: unknown;
      clusterKeys?: unknown;
      disconnectTypes?: unknown;
    };
    const note = typeof parsed.note === "string" ? parsed.note : null;
    const clusterKeys = Array.isArray(parsed.clusterKeys)
      ? parsed.clusterKeys.filter((value): value is string => typeof value === "string")
      : [];
    const disconnectTypes = Array.isArray(parsed.disconnectTypes)
      ? parsed.disconnectTypes.filter((value): value is string => typeof value === "string")
      : [];
    return {
      note,
      clusterKeys,
      disconnectTypes,
    };
  } catch {
    return null;
  }
}

async function getCurrentDisconnectMetadataForDeal(tenantDb: TenantDb, dealId: string) {
  const rows = getRows(await tenantDb.execute(sql`
    WITH base AS (
      SELECT
        d.id,
        d.procore_project_id,
        d.stage_entered_at,
        d.last_activity_at,
        d.proposal_status,
        psc.stale_threshold_days,
        COALESCE(jsonb_array_length(psc.required_documents), 0) AS required_document_count,
        COALESCE((
          SELECT COUNT(DISTINCT f.category)::int
          FROM files f
          WHERE f.deal_id = d.id
            AND f.is_active = TRUE
        ), 0) AS present_document_count,
        COALESCE((
          SELECT COUNT(*)::int
          FROM tasks t
          WHERE t.deal_id = d.id
            AND t.status IN ('pending', 'in_progress', 'waiting_on', 'blocked')
        ), 0) AS open_task_count,
        COALESCE((
          SELECT COUNT(*)::int
          FROM emails e
          WHERE e.deal_id = d.id
            AND e.direction = 'inbound'
            AND NOT EXISTS (
              SELECT 1
              FROM activities a
              WHERE a.deal_id = e.deal_id
                AND a.occurred_at >= e.sent_at
                AND a.type IN ('call', 'email', 'meeting', 'note')
            )
        ), 0) AS inbound_without_followup_count,
        pss.sync_status AS procore_sync_status
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      LEFT JOIN LATERAL (
        SELECT sync_status
        FROM public.procore_sync_state
        WHERE crm_entity_type = 'deal'
          AND crm_entity_id = d.id
          AND entity_type IN ('project', 'bid')
        ORDER BY updated_at DESC
        LIMIT 1
      ) pss ON TRUE
      WHERE d.id = ${dealId}
        AND d.is_active = TRUE
    ),
    disconnect_rows AS (
      SELECT 'stale_stage'::text AS disconnect_type
      FROM base
      WHERE stale_threshold_days > 0
        AND stage_entered_at IS NOT NULL
        AND EXTRACT(EPOCH FROM (NOW() - stage_entered_at)) / 86400 > stale_threshold_days

      UNION ALL

      SELECT 'missing_next_task'::text AS disconnect_type
      FROM base
      WHERE open_task_count = 0

      UNION ALL

      SELECT 'inbound_without_followup'::text AS disconnect_type
      FROM base
      WHERE inbound_without_followup_count > 0

      UNION ALL

      SELECT 'revision_loop'::text AS disconnect_type
      FROM base
      WHERE proposal_status = 'revision_requested'

      UNION ALL

      SELECT 'estimating_gate_gap'::text AS disconnect_type
      FROM base
      WHERE required_document_count > present_document_count

      UNION ALL

      SELECT 'procore_bid_board_drift'::text AS disconnect_type
      FROM base
      WHERE procore_project_id IS NOT NULL
        AND procore_sync_status IS NOT NULL
        AND procore_sync_status != 'synced'
    )
    SELECT disconnect_type
    FROM disconnect_rows
  `));

  const disconnectTypes = rows.map((row) => String(row.disconnect_type));
  const clusterKeys = Array.from(new Set(disconnectTypes.map((disconnectType) => getDisconnectClusterKey(disconnectType))));
  return { disconnectTypes, clusterKeys };
}

function buildSalesProcessDisconnectActionSummary(
  interventionEvents: Array<{ dealId: string; action: "mark_reviewed" | "resolve" | "dismiss" | "escalate" }>,
  openDealIds: Set<string>
): SalesProcessDisconnectActionSummary {
  const actions: Array<"mark_reviewed" | "resolve" | "dismiss" | "escalate"> = [
    "mark_reviewed",
    "resolve",
    "dismiss",
    "escalate",
  ];
  const summary = {
    markReviewed30d: 0,
    resolve30d: 0,
    dismiss30d: 0,
    escalate30d: 0,
    bestOverallAction: null,
    bestOverallClearanceRate: null,
  } as SalesProcessDisconnectActionSummary;

  let bestAction: SalesProcessDisconnectActionSummary["bestOverallAction"] = null;
  let bestRate: number | null = null;
  let bestCount = -1;

  for (const action of actions) {
    const dealIds = new Set(interventionEvents.filter((event) => event.action === action).map((event) => event.dealId));
    const total = dealIds.size;
    const cleared = Array.from(dealIds).filter((dealId) => !openDealIds.has(dealId)).length;
    const rate = total === 0 ? null : Number((cleared / total).toFixed(4));

    if (action === "mark_reviewed") summary.markReviewed30d = total;
    if (action === "resolve") summary.resolve30d = total;
    if (action === "dismiss") summary.dismiss30d = total;
    if (action === "escalate") summary.escalate30d = total;

    if (
      rate != null &&
      (bestRate == null || rate > bestRate || (rate === bestRate && total > bestCount))
    ) {
      bestAction = action;
      bestRate = rate;
      bestCount = total;
    }
  }

  summary.bestOverallAction = bestAction;
  summary.bestOverallClearanceRate = bestRate;
  return summary;
}

function buildSalesProcessDisconnectPlaybooks(
  rows: SalesProcessDisconnectRow[],
  clusters: SalesProcessDisconnectCluster[],
  interventionEvents: Array<{
    dealId: string;
    action: "mark_reviewed" | "resolve" | "dismiss" | "escalate";
    clusterKeys: string[];
  }>
): SalesProcessDisconnectPlaybook[] {
  const openClusterDealIds = new Map<string, Set<string>>();
  for (const row of rows) {
    const clusterKey = getDisconnectClusterKey(row.disconnectType);
    const existing = openClusterDealIds.get(clusterKey) ?? new Set<string>();
    existing.add(row.id);
    openClusterDealIds.set(clusterKey, existing);
  }

  return clusters.map((cluster) => {
    const clusterEvents = interventionEvents.filter((event) => event.clusterKeys.includes(cluster.clusterKey));
    const actions: Array<"mark_reviewed" | "resolve" | "dismiss" | "escalate"> = [
      "mark_reviewed",
      "resolve",
      "dismiss",
      "escalate",
    ];
    const openDealIds = openClusterDealIds.get(cluster.clusterKey) ?? new Set<string>();

    const actionRows: SalesProcessDisconnectPlaybookAction[] = actions
      .map((action) => {
        const dealIds = new Set(clusterEvents.filter((event) => event.action === action).map((event) => event.dealId));
        const interventionDeals30d = dealIds.size;
        const stillOpenDeals30d = Array.from(dealIds).filter((dealId) => openDealIds.has(dealId)).length;
        const clearedDeals30d = interventionDeals30d - stillOpenDeals30d;
        return {
          action,
          interventionDeals30d,
          clearedDeals30d,
          stillOpenDeals30d,
          clearanceRate30d:
            interventionDeals30d === 0 ? null : Number((clearedDeals30d / interventionDeals30d).toFixed(4)),
        };
      })
      .filter((row) => row.interventionDeals30d > 0)
      .sort((a, b) => {
        const rateA = a.clearanceRate30d ?? -1;
        const rateB = b.clearanceRate30d ?? -1;
        if (rateB !== rateA) return rateB - rateA;
        if (a.stillOpenDeals30d !== b.stillOpenDeals30d) return a.stillOpenDeals30d - b.stillOpenDeals30d;
        return b.interventionDeals30d - a.interventionDeals30d;
      });

    const bestAction = actionRows[0]?.action ?? null;
    return {
      clusterKey: cluster.clusterKey,
      title: cluster.title,
      bestAction,
      recommendedAction: bestAction ?? null,
      interventionDeals30d: new Set(clusterEvents.map((event) => event.dealId)).size,
      stillOpenDeals30d: Array.from(new Set(clusterEvents.map((event) => event.dealId))).filter((dealId) =>
        openDealIds.has(dealId)
      ).length,
      actions: actionRows,
    };
  });
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

export async function getCompanyCopilotView(
  tenantDb: TenantDb,
  company: { id: string; name: string }
): Promise<CompanyCopilotView> {
  const [contactCountResult, companyDeals] = await Promise.all([
    tenantDb
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(and(eq(contacts.companyId, company.id), eq(contacts.isActive, true))),
    tenantDb
      .select({
        id: deals.id,
        dealNumber: deals.dealNumber,
        name: deals.name,
        lastActivityAt: deals.lastActivityAt,
        updatedAt: deals.updatedAt,
      })
      .from(deals)
      .where(and(eq(deals.companyId, company.id), eq(deals.isActive, true)))
      .orderBy(desc(deals.updatedAt))
      .limit(10),
  ]);

  const dealIds = companyDeals.map((deal) => deal.id);
  const latestPacketRows = dealIds.length
    ? getRows(await tenantDb.execute(sql`
        SELECT DISTINCT ON (deal_id)
          id,
          deal_id,
          summary_text,
          confidence,
          generated_at,
          created_at
        FROM ai_copilot_packets
        WHERE scope_type = 'deal'
          AND deal_id IN (${sql.join(dealIds.map((id) => sql`${id}`), sql`, `)})
        ORDER BY deal_id, created_at DESC
      `))
    : [];
  const latestPacketByDealId = new Map<string, { summaryText: string | null; confidence: number | null }>();
  for (const row of latestPacketRows) {
    latestPacketByDealId.set(String(row.deal_id), {
      summaryText: (row.summary_text as string | null) ?? null,
      confidence: row.confidence == null ? null : Number(row.confidence),
    });
  }

  const [suggestedTasks, blindSpotFlags] = await Promise.all([
    dealIds.length
      ? tenantDb
          .select()
          .from(aiTaskSuggestions)
          .where(
            and(
              eq(aiTaskSuggestions.scopeType, "deal"),
              sql`${aiTaskSuggestions.scopeId} IN (${sql.join(dealIds.map((id) => sql`${id}`), sql`, `)})`,
              eq(aiTaskSuggestions.status, "suggested")
            )
          )
          .orderBy(desc(aiTaskSuggestions.createdAt))
          .limit(8)
      : Promise.resolve([]),
    dealIds.length
      ? tenantDb
          .select()
          .from(aiRiskFlags)
          .where(
            and(
              sql`${aiRiskFlags.dealId} IN (${sql.join(dealIds.map((id) => sql`${id}`), sql`, `)})`,
              eq(aiRiskFlags.status, "open")
            )
          )
          .orderBy(desc(aiRiskFlags.createdAt))
          .limit(8)
      : Promise.resolve([]),
  ]);

  const relatedDeals = companyDeals.map((deal) => ({
    ...deal,
    latestPacketSummary: latestPacketByDealId.get(deal.id)?.summaryText ?? null,
    latestPacketConfidence: latestPacketByDealId.get(deal.id)?.confidence ?? null,
  }));

  const summaryParts = [
    `${company.name} has ${companyDeals.length} active deal${companyDeals.length === 1 ? "" : "s"} and ${Number(contactCountResult[0]?.count ?? 0)} active contact${Number(contactCountResult[0]?.count ?? 0) === 1 ? "" : "s"}.`,
    suggestedTasks.length > 0
      ? `${suggestedTasks.length} unresolved AI task suggestion${suggestedTasks.length === 1 ? "" : "s"} are open across the account.`
      : "No unresolved AI task suggestions are open across the account.",
    blindSpotFlags.length > 0
      ? `Top blind spots: ${blindSpotFlags.slice(0, 2).map((flag) => flag.title).join("; ")}.`
      : "No open blind spots are currently attached to this account's active deals.",
  ];

  return {
    company: {
      id: company.id,
      name: company.name,
      contactCount: Number(contactCountResult[0]?.count ?? 0),
      dealCount: companyDeals.length,
    },
    summaryText: summaryParts.join(" "),
    relatedDeals,
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

export async function getAiActionQueue(
  tenantDb: TenantDb,
  options: { limit?: number } = {}
): Promise<AiActionQueueEntry[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const rows = getRows(await tenantDb.execute(sql`
    SELECT *
    FROM (
      SELECT
        'blind_spot'::text AS entry_type,
        rf.id::text AS id,
        rf.deal_id::text AS deal_id,
        d.name::text AS deal_name,
        d.deal_number::text AS deal_number,
        rf.title::text AS title,
        rf.details::text AS details,
        rf.severity::text AS severity,
        NULL::text AS priority,
        rf.status::text AS status,
        rf.created_at AS created_at,
        NULL::timestamptz AS suggested_due_at,
        (
          SELECT COUNT(*)
          FROM ai_risk_flags rf_repeat
          WHERE rf_repeat.deal_id = rf.deal_id
            AND rf_repeat.flag_type = rf.flag_type
        )::int AS repeat_count,
        (
          SELECT f.feedback_value
          FROM ai_feedback f
          WHERE f.target_type = 'risk_flag'
            AND f.target_id = rf.id
            AND f.feedback_type = 'triage_action'
          ORDER BY f.created_at DESC
          LIMIT 1
        )::text AS last_triage_action,
        (
          SELECT f.created_at
          FROM ai_feedback f
          WHERE f.target_type = 'risk_flag'
            AND f.target_id = rf.id
            AND f.feedback_type = 'triage_action'
          ORDER BY f.created_at DESC
          LIMIT 1
        ) AS last_triaged_at
      FROM ai_risk_flags rf
      LEFT JOIN deals d ON d.id = rf.deal_id
      WHERE rf.status = 'open'

      UNION ALL

      SELECT
        'task_suggestion'::text AS entry_type,
        ts.id::text AS id,
        ts.scope_id::text AS deal_id,
        d.name::text AS deal_name,
        d.deal_number::text AS deal_number,
        ts.title::text AS title,
        ts.description::text AS details,
        NULL::text AS severity,
        ts.priority::text AS priority,
        ts.status::text AS status,
        ts.created_at AS created_at,
        ts.suggested_due_at AS suggested_due_at,
        (
          SELECT COUNT(*)
          FROM ai_task_suggestions ts_repeat
          WHERE ts_repeat.scope_type = 'deal'
            AND ts_repeat.scope_id = ts.scope_id
            AND ts_repeat.title = ts.title
        )::int AS repeat_count,
        (
          SELECT f.feedback_value
          FROM ai_feedback f
          WHERE f.target_type = 'task_suggestion'
            AND f.target_id = ts.id
            AND f.feedback_type = 'triage_action'
          ORDER BY f.created_at DESC
          LIMIT 1
        )::text AS last_triage_action,
        (
          SELECT f.created_at
          FROM ai_feedback f
          WHERE f.target_type = 'task_suggestion'
            AND f.target_id = ts.id
            AND f.feedback_type = 'triage_action'
          ORDER BY f.created_at DESC
          LIMIT 1
        ) AS last_triaged_at
      FROM ai_task_suggestions ts
      LEFT JOIN deals d ON d.id = ts.scope_id
      WHERE ts.scope_type = 'deal'
        AND ts.status = 'suggested'
    ) queue
    ORDER BY created_at DESC
    LIMIT ${limit}
  `));

  return rows.map((row) => ({
    entryType: row.entry_type === "blind_spot" ? "blind_spot" : "task_suggestion",
    id: String(row.id),
    dealId: row.deal_id ? String(row.deal_id) : null,
    dealName: row.deal_name ? String(row.deal_name) : null,
    dealNumber: row.deal_number ? String(row.deal_number) : null,
    title: String(row.title),
    details: row.details ? String(row.details) : null,
    severity: row.severity ? String(row.severity) : null,
    priority: row.priority ? String(row.priority) : null,
    status: String(row.status),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    suggestedDueAt:
      row.suggested_due_at instanceof Date
        ? row.suggested_due_at.toISOString()
        : row.suggested_due_at
          ? String(row.suggested_due_at)
          : null,
    repeatCount: Number(row.repeat_count ?? 0),
    lastTriageAction: row.last_triage_action ? String(row.last_triage_action) : null,
    lastTriagedAt:
      row.last_triaged_at instanceof Date
        ? row.last_triaged_at.toISOString()
        : row.last_triaged_at
          ? String(row.last_triaged_at)
          : null,
    escalated: row.last_triage_action === "escalate",
  }));
}

export async function getSalesProcessDisconnectDashboard(
  tenantDb: TenantDb,
  input: { limit?: number } = {}
): Promise<SalesProcessDisconnectDashboard> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));

  const [summaryResult, byTypeResult, rowsResult, interventionsResult, interventionEventsResult, automationResult] = await Promise.all([
    tenantDb.execute(sql`
      WITH scoped_deals AS (
        SELECT
          d.id,
          d.stage_entered_at,
          d.proposal_status,
          psc.stale_threshold_days,
          COALESCE(jsonb_array_length(psc.required_documents), 0) AS required_document_count
        FROM deals d
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE d.is_active = TRUE
      ),
      deal_task_counts AS (
        SELECT
          t.deal_id,
          COUNT(*) FILTER (WHERE t.status IN ('pending', 'in_progress', 'waiting_on', 'blocked'))::int AS open_task_count
        FROM tasks t
        WHERE t.deal_id IS NOT NULL
        GROUP BY t.deal_id
      ),
      deal_inbound_counts AS (
        SELECT
          e.deal_id,
          COUNT(*) FILTER (
            WHERE e.direction = 'inbound'
              AND NOT EXISTS (
                SELECT 1
                FROM activities a
                WHERE a.deal_id = e.deal_id
                  AND a.occurred_at >= e.sent_at
                  AND a.type IN ('call', 'email', 'meeting', 'note')
              )
          )::int AS inbound_without_followup_count
        FROM emails e
        WHERE e.deal_id IS NOT NULL
        GROUP BY e.deal_id
      ),
      deal_file_counts AS (
        SELECT
          f.deal_id,
          COUNT(DISTINCT f.category)::int AS present_document_count
        FROM files f
        WHERE f.deal_id IS NOT NULL
          AND f.is_active = TRUE
        GROUP BY f.deal_id
      ),
      latest_procore_sync AS (
        SELECT DISTINCT ON (pss.crm_entity_id)
          pss.crm_entity_id AS deal_id,
          pss.sync_status
        FROM public.procore_sync_state pss
        WHERE pss.crm_entity_type = 'deal'
          AND pss.entity_type IN ('project', 'bid')
        ORDER BY pss.crm_entity_id, pss.updated_at DESC
      ),
      deal_procore_drift AS (
        SELECT
          lps.deal_id,
          CASE WHEN lps.sync_status != 'synced' THEN 1 ELSE 0 END::int AS procore_bid_board_drift_count
        FROM latest_procore_sync lps
      )
      SELECT
        COUNT(*)::int AS active_deals,
        COUNT(*) FILTER (
          WHERE stale_threshold_days > 0
            AND stage_entered_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (NOW() - stage_entered_at)) / 86400 > stale_threshold_days
        )::int AS stale_stage_count,
        COUNT(*) FILTER (WHERE COALESCE(open_task_count, 0) = 0)::int AS missing_next_task_count,
        COUNT(*) FILTER (WHERE COALESCE(inbound_without_followup_count, 0) > 0)::int AS inbound_without_followup_count,
        COUNT(*) FILTER (WHERE proposal_status = 'revision_requested')::int AS revision_loop_count,
        COUNT(*) FILTER (
          WHERE required_document_count > COALESCE(present_document_count, 0)
        )::int AS estimating_gate_gap_count,
        COUNT(*) FILTER (
          WHERE COALESCE(procore_bid_board_drift_count, 0) > 0
        )::int AS procore_bid_board_drift_count
      FROM scoped_deals sd
      LEFT JOIN deal_task_counts dtc ON dtc.deal_id = sd.id
      LEFT JOIN deal_inbound_counts dic ON dic.deal_id = sd.id
      LEFT JOIN deal_file_counts dfc ON dfc.deal_id = sd.id
      LEFT JOIN deal_procore_drift dpd ON dpd.deal_id = sd.id
    `),
    tenantDb.execute(sql`
      WITH latest_procore_sync AS (
        SELECT DISTINCT ON (pss.crm_entity_id)
          pss.crm_entity_id AS deal_id,
          pss.sync_status
        FROM public.procore_sync_state pss
        WHERE pss.crm_entity_type = 'deal'
          AND pss.entity_type IN ('project', 'bid')
        ORDER BY pss.crm_entity_id, pss.updated_at DESC
      ),
      disconnect_rows AS (
        SELECT
          d.id AS deal_id,
          'stale_stage'::text AS disconnect_type,
          'Stalled in stage'::text AS disconnect_label
        FROM deals d
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE d.is_active = TRUE
          AND psc.stale_threshold_days > 0
          AND d.stage_entered_at IS NOT NULL
          AND EXTRACT(EPOCH FROM (NOW() - d.stage_entered_at)) / 86400 > psc.stale_threshold_days

        UNION ALL

        SELECT
          d.id AS deal_id,
          'missing_next_task'::text AS disconnect_type,
          'Missing next task'::text AS disconnect_label
        FROM deals d
        WHERE d.is_active = TRUE
          AND NOT EXISTS (
            SELECT 1
            FROM tasks t
            WHERE t.deal_id = d.id
              AND t.status IN ('pending', 'in_progress', 'waiting_on', 'blocked')
          )

        UNION ALL

        SELECT
          d.id AS deal_id,
          'inbound_without_followup'::text AS disconnect_type,
          'Inbound with no follow-up'::text AS disconnect_label
        FROM deals d
        WHERE d.is_active = TRUE
          AND EXISTS (
            SELECT 1
            FROM emails e
            WHERE e.deal_id = d.id
              AND e.direction = 'inbound'
              AND NOT EXISTS (
                SELECT 1
                FROM activities a
                WHERE a.deal_id = e.deal_id
                  AND a.occurred_at >= e.sent_at
                  AND a.type IN ('call', 'email', 'meeting', 'note')
              )
          )

        UNION ALL

        SELECT
          d.id AS deal_id,
          'revision_loop'::text AS disconnect_type,
          'Revision loop'::text AS disconnect_label
        FROM deals d
        WHERE d.is_active = TRUE
          AND d.proposal_status = 'revision_requested'

        UNION ALL

        SELECT
          d.id AS deal_id,
          'estimating_gate_gap'::text AS disconnect_type,
          'Estimating gate gap'::text AS disconnect_label
        FROM deals d
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE d.is_active = TRUE
          AND COALESCE(jsonb_array_length(psc.required_documents), 0) > (
            SELECT COUNT(DISTINCT f.category)::int
            FROM files f
            WHERE f.deal_id = d.id
              AND f.is_active = TRUE
          )

        UNION ALL

        SELECT
          d.id AS deal_id,
          'procore_bid_board_drift'::text AS disconnect_type,
          'Bid board sync drift'::text AS disconnect_label
        FROM deals d
        JOIN latest_procore_sync lps ON lps.deal_id = d.id
        WHERE d.is_active = TRUE
          AND d.procore_project_id IS NOT NULL
          AND lps.sync_status != 'synced'
      )
      SELECT
        disconnect_type,
        disconnect_label,
        COUNT(*)::int AS disconnect_count
      FROM disconnect_rows
      GROUP BY disconnect_type, disconnect_label
      ORDER BY disconnect_count DESC, disconnect_label ASC
    `),
    tenantDb.execute(sql`
      WITH base AS (
        SELECT
          d.id,
          d.deal_number,
          d.name AS deal_name,
          c.id AS company_id,
          c.name AS company_name,
          psc.name AS stage_name,
          d.estimating_substage,
          u.display_name AS assigned_rep_name,
          d.stage_entered_at,
          d.last_activity_at,
          d.proposal_status,
          d.procore_project_id,
          d.procore_last_synced_at,
          COALESCE((
            SELECT COUNT(*)::int
            FROM tasks t
            WHERE t.deal_id = d.id
              AND t.status IN ('pending', 'in_progress', 'waiting_on', 'blocked')
          ), 0) AS open_task_count,
          COALESCE((
            SELECT COUNT(*)::int
            FROM emails e
            WHERE e.deal_id = d.id
              AND e.direction = 'inbound'
              AND NOT EXISTS (
                SELECT 1
                FROM activities a
                WHERE a.deal_id = e.deal_id
                  AND a.occurred_at >= e.sent_at
                  AND a.type IN ('call', 'email', 'meeting', 'note')
              )
          ), 0) AS inbound_without_followup_count,
          (
            SELECT MAX(e.sent_at)
            FROM emails e
            WHERE e.deal_id = d.id
              AND e.direction = 'inbound'
          ) AS latest_customer_email_at,
          COALESCE(jsonb_array_length(psc.required_documents), 0) AS required_document_count,
          COALESCE((
            SELECT COUNT(DISTINCT f.category)::int
            FROM files f
            WHERE f.deal_id = d.id
              AND f.is_active = TRUE
          ), 0) AS present_document_count,
          psc.stale_threshold_days,
          pss.sync_status AS procore_sync_status,
          pss.sync_direction AS procore_sync_direction,
          pss.updated_at AS procore_sync_updated_at,
          CASE
            WHEN pss.sync_status = 'conflict' THEN COALESCE(pss.conflict_data ->> 'summary', pss.error_message, 'Procore sync conflict requires reconciliation.')
            WHEN pss.sync_status = 'error' THEN COALESCE(pss.error_message, 'Procore sync error blocked CRM reconciliation.')
            WHEN pss.sync_status = 'pending' THEN 'Bid board update is pending sync into CRM.'
            WHEN pss.last_procore_updated_at IS NOT NULL
              AND (
                pss.last_crm_updated_at IS NULL
                OR pss.last_procore_updated_at > pss.last_crm_updated_at
              )
              THEN 'Procore reported a newer update than the CRM stage map.'
            ELSE NULL
          END AS procore_drift_reason
        FROM deals d
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        LEFT JOIN companies c ON c.id = d.company_id
        LEFT JOIN public.users u ON u.id = d.assigned_rep_id
        LEFT JOIN LATERAL (
          SELECT
            sync_status,
            sync_direction,
            last_synced_at,
            last_procore_updated_at,
            last_crm_updated_at,
            updated_at,
            conflict_data,
            error_message
          FROM public.procore_sync_state
          WHERE crm_entity_type = 'deal'
            AND crm_entity_id = d.id
            AND entity_type IN ('project', 'bid')
          ORDER BY updated_at DESC
          LIMIT 1
        ) pss ON TRUE
        WHERE d.is_active = TRUE
      ),
      disconnect_rows AS (
        SELECT
          id,
          deal_number,
          deal_name,
          stage_name,
          estimating_substage,
          assigned_rep_name,
          'stale_stage'::text AS disconnect_type,
          'Stalled in stage'::text AS disconnect_label,
          'high'::text AS disconnect_severity,
          'Deal has exceeded its configured stale threshold.'::text AS disconnect_summary,
          CONCAT(stage_name, ' has been inactive for ', FLOOR(EXTRACT(EPOCH FROM (NOW() - stage_entered_at)) / 86400), ' days.')::text AS disconnect_details,
          FLOOR(EXTRACT(EPOCH FROM (NOW() - stage_entered_at)) / 86400)::int AS age_days,
          open_task_count,
          inbound_without_followup_count,
          last_activity_at,
          latest_customer_email_at,
          proposal_status,
          procore_sync_status,
          procore_sync_direction,
          procore_last_synced_at,
          procore_sync_updated_at,
          procore_drift_reason
        FROM base
        WHERE stale_threshold_days > 0
          AND stage_entered_at IS NOT NULL
          AND EXTRACT(EPOCH FROM (NOW() - stage_entered_at)) / 86400 > stale_threshold_days

        UNION ALL

        SELECT
          id,
          deal_number,
          deal_name,
          stage_name,
          estimating_substage,
          assigned_rep_name,
          'missing_next_task'::text AS disconnect_type,
          'Missing next task'::text AS disconnect_label,
          'high'::text AS disconnect_severity,
          'Deal has no open next-step task.'::text AS disconnect_summary,
          'No pending or in-progress task exists to drive the next customer or internal step.'::text AS disconnect_details,
          CASE
            WHEN last_activity_at IS NULL THEN NULL
            ELSE FLOOR(EXTRACT(EPOCH FROM (NOW() - last_activity_at)) / 86400)::int
          END AS age_days,
          open_task_count,
          inbound_without_followup_count,
          last_activity_at,
          latest_customer_email_at,
          proposal_status,
          procore_sync_status,
          procore_sync_direction,
          procore_last_synced_at,
          procore_sync_updated_at,
          procore_drift_reason
        FROM base
        WHERE open_task_count = 0

        UNION ALL

        SELECT
          id,
          deal_number,
          deal_name,
          stage_name,
          estimating_substage,
          assigned_rep_name,
          'inbound_without_followup'::text AS disconnect_type,
          'Inbound with no follow-up'::text AS disconnect_label,
          'critical'::text AS disconnect_severity,
          'Customer emailed without a recorded follow-up.'::text AS disconnect_summary,
          'Inbound customer communication exists with no later call, email, meeting, or note logged.'::text AS disconnect_details,
          CASE
            WHEN latest_customer_email_at IS NULL THEN NULL
            ELSE FLOOR(EXTRACT(EPOCH FROM (NOW() - latest_customer_email_at)) / 86400)::int
          END AS age_days,
          open_task_count,
          inbound_without_followup_count,
          last_activity_at,
          latest_customer_email_at,
          proposal_status,
          procore_sync_status,
          procore_sync_direction,
          procore_last_synced_at,
          procore_sync_updated_at,
          procore_drift_reason
        FROM base
        WHERE inbound_without_followup_count > 0

        UNION ALL

        SELECT
          id,
          deal_number,
          deal_name,
          stage_name,
          estimating_substage,
          assigned_rep_name,
          'revision_loop'::text AS disconnect_type,
          'Revision loop'::text AS disconnect_label,
          'critical'::text AS disconnect_severity,
          'Proposal revision requested with no clear closed-loop ownership.'::text AS disconnect_summary,
          'The deal remains in revision_requested, which often signals a stalled handoff between sales and estimating.'::text AS disconnect_details,
          CASE
            WHEN latest_customer_email_at IS NULL THEN NULL
            ELSE FLOOR(EXTRACT(EPOCH FROM (NOW() - latest_customer_email_at)) / 86400)::int
          END AS age_days,
          open_task_count,
          inbound_without_followup_count,
          last_activity_at,
          latest_customer_email_at,
          proposal_status,
          procore_sync_status,
          procore_sync_direction,
          procore_last_synced_at,
          procore_sync_updated_at,
          procore_drift_reason
        FROM base
        WHERE proposal_status = 'revision_requested'

        UNION ALL

        SELECT
          id,
          deal_number,
          deal_name,
          stage_name,
          estimating_substage,
          assigned_rep_name,
          'estimating_gate_gap'::text AS disconnect_type,
          'Estimating gate gap'::text AS disconnect_label,
          'critical'::text AS disconnect_severity,
          'Required estimating artifacts are missing.'::text AS disconnect_summary,
          'Stage requirements indicate missing supporting documents or files for the current phase.'::text AS disconnect_details,
          CASE
            WHEN stage_entered_at IS NULL THEN NULL
            ELSE FLOOR(EXTRACT(EPOCH FROM (NOW() - stage_entered_at)) / 86400)::int
          END AS age_days,
          open_task_count,
          inbound_without_followup_count,
          last_activity_at,
          latest_customer_email_at,
          proposal_status,
          procore_sync_status,
          procore_sync_direction,
          procore_last_synced_at,
          procore_sync_updated_at,
          procore_drift_reason
        FROM base
        WHERE required_document_count > present_document_count

        UNION ALL

        SELECT
          id,
          deal_number,
          deal_name,
          stage_name,
          estimating_substage,
          assigned_rep_name,
          'procore_bid_board_drift'::text AS disconnect_type,
          'Bid board sync drift'::text AS disconnect_label,
          'critical'::text AS disconnect_severity,
          'Procore bid board and CRM stage state are out of sync.'::text AS disconnect_summary,
          COALESCE(
            procore_drift_reason,
            'Bid board recorded a newer or conflicting update than the CRM currently reflects.'
          )::text AS disconnect_details,
          CASE
            WHEN procore_sync_updated_at IS NULL THEN NULL
            ELSE FLOOR(EXTRACT(EPOCH FROM (NOW() - procore_sync_updated_at)) / 86400)::int
          END AS age_days,
          open_task_count,
          inbound_without_followup_count,
          last_activity_at,
          latest_customer_email_at,
          proposal_status,
          procore_sync_status,
          procore_sync_direction,
          procore_last_synced_at,
          procore_sync_updated_at,
          procore_drift_reason
        FROM base
        WHERE procore_project_id IS NOT NULL
          AND procore_sync_status IS NOT NULL
          AND procore_sync_status != 'synced'
      )
      SELECT *
      FROM disconnect_rows
      ORDER BY
        CASE disconnect_severity
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          ELSE 3
        END ASC,
        COALESCE(age_days, 0) DESC,
        deal_number ASC
      LIMIT ${limit}
    `),
    tenantDb.execute(sql`
      WITH triage_feedback AS (
        SELECT
          rf.deal_id AS deal_id,
          f.feedback_value,
          f.created_at
        FROM ai_feedback f
        JOIN ai_risk_flags rf
          ON f.target_type = 'risk_flag'
         AND f.target_id = rf.id
        WHERE f.feedback_type = 'triage_action'
          AND f.created_at >= NOW() - INTERVAL '30 days'
          AND rf.deal_id IS NOT NULL

        UNION ALL

        SELECT
          ts.scope_id AS deal_id,
          f.feedback_value,
          f.created_at
        FROM ai_feedback f
        JOIN ai_task_suggestions ts
          ON f.target_type = 'task_suggestion'
         AND f.target_id = ts.id
        WHERE f.feedback_type = 'triage_action'
          AND f.created_at >= NOW() - INTERVAL '30 days'
          AND ts.scope_type = 'deal'
          AND ts.scope_id IS NOT NULL
      )
      SELECT
        deal_id,
        COUNT(*)::int AS intervention_count_30d,
        MAX(created_at) AS latest_intervention_at,
        (
          ARRAY_AGG(feedback_value ORDER BY created_at DESC)
        )[1]::text AS latest_action
      FROM triage_feedback
      GROUP BY deal_id
    `),
    tenantDb.execute(sql`
      WITH triage_feedback AS (
        SELECT
          rf.deal_id AS deal_id,
          f.feedback_value AS action,
          f.created_at,
          f.comment_text
        FROM ai_feedback f
        JOIN ai_risk_flags rf
          ON f.target_type = 'risk_flag'
         AND f.target_id = rf.id
        WHERE f.feedback_type = 'triage_action'
          AND f.created_at >= NOW() - INTERVAL '30 days'
          AND rf.deal_id IS NOT NULL

        UNION ALL

        SELECT
          ts.scope_id AS deal_id,
          f.feedback_value AS action,
          f.created_at,
          f.comment_text
        FROM ai_feedback f
        JOIN ai_task_suggestions ts
          ON f.target_type = 'task_suggestion'
         AND f.target_id = ts.id
        WHERE f.feedback_type = 'triage_action'
          AND f.created_at >= NOW() - INTERVAL '30 days'
          AND ts.scope_type = 'deal'
          AND ts.scope_id IS NOT NULL
      )
      SELECT
        deal_id,
        action,
        created_at,
        comment_text
      FROM triage_feedback
    `),
    tenantDb.execute(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE title LIKE 'AI Disconnect Digest:%'
            AND created_at >= NOW() - INTERVAL '7 days'
        )::int AS digest_notifications_7d,
        COUNT(*) FILTER (
          WHERE title LIKE 'AI Escalation:%'
            AND created_at >= NOW() - INTERVAL '7 days'
        )::int AS escalation_notifications_7d,
        MAX(created_at) FILTER (WHERE title LIKE 'AI Disconnect Digest:%') AS latest_digest_at,
        MAX(created_at) FILTER (WHERE title LIKE 'AI Escalation:%') AS latest_escalation_at,
        (
          SELECT COUNT(*)::int
          FROM tasks t
          WHERE t.origin_rule = 'ai_disconnect_admin_task'
            AND t.created_at >= NOW() - INTERVAL '7 days'
        ) AS admin_tasks_created_7d,
        (
          SELECT COUNT(*)::int
          FROM tasks t
          WHERE t.origin_rule = 'ai_disconnect_admin_task'
            AND t.status IN ('pending', 'in_progress', 'waiting_on', 'blocked')
        ) AS admin_tasks_open,
        (
          SELECT MAX(t.created_at)
          FROM tasks t
          WHERE t.origin_rule = 'ai_disconnect_admin_task'
        ) AS latest_admin_task_created_at
      FROM notifications
    `),
  ]);

  const summaryRow = getRows(summaryResult)[0] ?? {};
  const summary: SalesProcessDisconnectSummary = {
    activeDeals: Number(summaryRow.active_deals ?? 0),
    staleStageCount: Number(summaryRow.stale_stage_count ?? 0),
    missingNextTaskCount: Number(summaryRow.missing_next_task_count ?? 0),
    inboundWithoutFollowupCount: Number(summaryRow.inbound_without_followup_count ?? 0),
    revisionLoopCount: Number(summaryRow.revision_loop_count ?? 0),
    estimatingGateGapCount: Number(summaryRow.estimating_gate_gap_count ?? 0),
    procoreBidBoardDriftCount: Number(summaryRow.procore_bid_board_drift_count ?? 0),
    totalDisconnects:
      Number(summaryRow.stale_stage_count ?? 0) +
      Number(summaryRow.missing_next_task_count ?? 0) +
      Number(summaryRow.inbound_without_followup_count ?? 0) +
      Number(summaryRow.revision_loop_count ?? 0) +
      Number(summaryRow.estimating_gate_gap_count ?? 0) +
      Number(summaryRow.procore_bid_board_drift_count ?? 0),
  };
  const automationRow = getRows(automationResult)[0] ?? {};
  const automation: SalesProcessDisconnectAutomationStatus = {
    digestNotifications7d: Number(automationRow.digest_notifications_7d ?? 0),
    escalationNotifications7d: Number(automationRow.escalation_notifications_7d ?? 0),
    adminTasksCreated7d: Number(automationRow.admin_tasks_created_7d ?? 0),
    adminTasksOpen: Number(automationRow.admin_tasks_open ?? 0),
    latestDigestAt:
      automationRow.latest_digest_at instanceof Date
        ? automationRow.latest_digest_at.toISOString()
        : automationRow.latest_digest_at
          ? String(automationRow.latest_digest_at)
          : null,
    latestEscalationAt:
      automationRow.latest_escalation_at instanceof Date
        ? automationRow.latest_escalation_at.toISOString()
        : automationRow.latest_escalation_at
          ? String(automationRow.latest_escalation_at)
          : null,
    latestAdminTaskCreatedAt:
      automationRow.latest_admin_task_created_at instanceof Date
        ? automationRow.latest_admin_task_created_at.toISOString()
        : automationRow.latest_admin_task_created_at
          ? String(automationRow.latest_admin_task_created_at)
          : null,
  };

  const rows: SalesProcessDisconnectRow[] = getRows(rowsResult).map((row) => ({
    id: row.id,
    dealNumber: row.deal_number,
    dealName: row.deal_name,
    companyId: row.company_id ?? null,
    companyName: row.company_name ?? null,
    stageName: row.stage_name ?? null,
    estimatingSubstage: row.estimating_substage ?? null,
    assignedRepName: row.assigned_rep_name ?? null,
    disconnectType: row.disconnect_type,
    disconnectLabel: row.disconnect_label,
    disconnectSeverity: row.disconnect_severity,
    disconnectSummary: row.disconnect_summary,
    disconnectDetails: row.disconnect_details ?? null,
    ageDays: row.age_days == null ? null : Number(row.age_days),
    openTaskCount: Number(row.open_task_count ?? 0),
    inboundWithoutFollowupCount: Number(row.inbound_without_followup_count ?? 0),
    lastActivityAt: row.last_activity_at ?? null,
    latestCustomerEmailAt: row.latest_customer_email_at ?? null,
    proposalStatus: row.proposal_status ?? null,
    procoreSyncStatus: row.procore_sync_status ?? null,
    procoreSyncDirection: row.procore_sync_direction ?? null,
    procoreLastSyncedAt: row.procore_last_synced_at ?? null,
    procoreSyncUpdatedAt: row.procore_sync_updated_at ?? null,
    procoreDriftReason: row.procore_drift_reason ?? null,
  }));

  const interventionsByDeal = new Map(
    getRows(interventionsResult).map((row) => [
      String(row.deal_id),
      {
        interventionCount30d: Number(row.intervention_count_30d ?? 0),
        latestInterventionAt:
          row.latest_intervention_at instanceof Date
            ? row.latest_intervention_at.toISOString()
            : row.latest_intervention_at
              ? String(row.latest_intervention_at)
              : null,
        latestAction: row.latest_action ? String(row.latest_action) : null,
      },
    ])
  );
  const openDealIds = new Set(rows.map((row) => row.id));
  const currentClusterKeysByDeal = new Map<string, string[]>();
  for (const row of rows) {
    const clusterKey = getDisconnectClusterKey(row.disconnectType);
    const existing = currentClusterKeysByDeal.get(row.id) ?? [];
    if (!existing.includes(clusterKey)) existing.push(clusterKey);
    currentClusterKeysByDeal.set(row.id, existing);
  }
  const interventionEvents = getRows(interventionEventsResult).flatMap((row) => {
    const action = row.action as "mark_reviewed" | "resolve" | "dismiss" | "escalate" | null;
    if (!action || !["mark_reviewed", "resolve", "dismiss", "escalate"].includes(action)) {
      return [];
    }
    const metadata = parseTriageMetadata(row.comment_text);
    const clusterKeys =
      metadata?.clusterKeys?.length
        ? metadata.clusterKeys
        : currentClusterKeysByDeal.get(String(row.deal_id)) ?? [];
    return [
      {
        dealId: String(row.deal_id),
        action,
        clusterKeys,
      },
    ];
  });
  const clusters = buildSalesProcessDisconnectClusters(rows);

  return {
    summary,
    automation,
    byType: getRows(byTypeResult).map((row) => ({
      disconnectType: row.disconnect_type,
      label: row.disconnect_label,
      count: Number(row.disconnect_count ?? 0),
    })),
    clusters,
    trends: buildSalesProcessDisconnectTrends(rows, interventionsByDeal),
    outcomes: buildSalesProcessDisconnectOutcomes(rows, interventionsByDeal),
    actionSummary: buildSalesProcessDisconnectActionSummary(interventionEvents, openDealIds),
    playbooks: buildSalesProcessDisconnectPlaybooks(rows, clusters, interventionEvents),
    rows,
  };
}

export async function triageAiActionQueueEntry(
  tenantDb: TenantDb,
  input: {
    entryType: "blind_spot" | "task_suggestion";
    id: string;
    action: "mark_reviewed" | "resolve" | "dismiss" | "escalate";
    userId: string;
    comment?: string | null;
  }
) {
  if (input.entryType === "blind_spot") {
    const [riskFlag] = await tenantDb
      .select({ dealId: aiRiskFlags.dealId })
      .from(aiRiskFlags)
      .where(eq(aiRiskFlags.id, input.id))
      .limit(1);
    const disconnectMetadata = riskFlag?.dealId
      ? await getCurrentDisconnectMetadataForDeal(tenantDb, riskFlag.dealId)
      : { disconnectTypes: [], clusterKeys: [] };

    if (input.action === "resolve" || input.action === "dismiss") {
      await tenantDb
        .update(aiRiskFlags)
        .set({
          status: "resolved",
          resolvedAt: new Date(),
        })
        .where(eq(aiRiskFlags.id, input.id));
    }

    const feedback = await recordAiFeedback(tenantDb, {
      targetType: "risk_flag",
      targetId: input.id,
      userId: input.userId,
      feedbackType: "triage_action",
      feedbackValue: input.action,
      comment: JSON.stringify({
        note: input.comment ?? null,
        dealId: riskFlag?.dealId ?? null,
        clusterKeys: disconnectMetadata.clusterKeys,
        disconnectTypes: disconnectMetadata.disconnectTypes,
      }),
    });

    return {
      entryType: input.entryType,
      id: input.id,
      action: input.action,
      feedbackId: feedback.id,
      targetStatus: input.action === "resolve" || input.action === "dismiss" ? "resolved" : "open",
    };
  }

  if (input.action === "dismiss" || input.action === "resolve") {
    await tenantDb
      .update(aiTaskSuggestions)
      .set({
        status: "dismissed",
        resolvedAt: new Date(),
      })
      .where(eq(aiTaskSuggestions.id, input.id));
  }

  const [suggestion] = await tenantDb
    .select({ dealId: aiTaskSuggestions.scopeId, scopeType: aiTaskSuggestions.scopeType })
    .from(aiTaskSuggestions)
    .where(eq(aiTaskSuggestions.id, input.id))
    .limit(1);
  const disconnectMetadata =
    suggestion?.scopeType === "deal" && suggestion.dealId
      ? await getCurrentDisconnectMetadataForDeal(tenantDb, suggestion.dealId)
      : { disconnectTypes: [], clusterKeys: [] };

  const feedback = await recordAiFeedback(tenantDb, {
    targetType: "task_suggestion",
    targetId: input.id,
    userId: input.userId,
    feedbackType: "triage_action",
    feedbackValue: input.action,
    comment: JSON.stringify({
      note: input.comment ?? null,
      dealId: suggestion?.scopeType === "deal" ? suggestion.dealId ?? null : null,
      clusterKeys: disconnectMetadata.clusterKeys,
      disconnectTypes: disconnectMetadata.disconnectTypes,
    }),
  });

  return {
    entryType: input.entryType,
    id: input.id,
    action: input.action,
    feedbackId: feedback.id,
    targetStatus: input.action === "dismiss" || input.action === "resolve" ? "dismissed" : "suggested",
  };
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
      triage_counts AS (
        SELECT
          COUNT(*) FILTER (WHERE feedback_type = 'triage_action' AND created_at >= NOW() - INTERVAL '30 days')::int AS triage_actions_30d,
          COUNT(*) FILTER (WHERE feedback_type = 'triage_action' AND feedback_value = 'escalate' AND created_at >= NOW() - INTERVAL '30 days')::int AS escalations_30d
        FROM ai_feedback
      ),
      search_interaction_counts AS (
        SELECT
          COUNT(*) FILTER (
            WHERE target_type = 'search_query'
              AND feedback_type = 'search_interaction'
              AND created_at >= NOW() - INTERVAL '30 days'
          )::int AS ai_search_interactions_30d,
          COUNT(DISTINCT target_id) FILTER (
            WHERE target_type = 'search_query'
              AND feedback_type = 'search_interaction'
              AND created_at >= NOW() - INTERVAL '30 days'
          )::int AS ai_search_queries_with_click_30d,
          COUNT(DISTINCT target_id) FILTER (
            WHERE target_type = 'search_query'
              AND feedback_type = 'search_interaction'
              AND feedback_value = 'search_impression'
              AND created_at >= NOW() - INTERVAL '30 days'
          )::int AS ai_search_queries_served_30d,
          COUNT(*) FILTER (
            WHERE target_type = 'search_query'
              AND feedback_type = 'search_interaction'
              AND feedback_value = 'recommended_action_executed'
              AND created_at >= NOW() - INTERVAL '30 days'
          )::int AS ai_search_workflow_executions_30d,
          COUNT(DISTINCT target_id) FILTER (
            WHERE target_type = 'search_query'
              AND feedback_type = 'search_interaction'
              AND feedback_value = 'recommended_action_executed'
              AND created_at >= NOW() - INTERVAL '30 days'
          )::int AS ai_search_queries_with_workflow_30d,
          COALESCE(
            COUNT(DISTINCT target_id) FILTER (
              WHERE target_type = 'search_query'
                AND feedback_type = 'search_interaction'
                AND feedback_value = 'recommended_action_executed'
                AND created_at >= NOW() - INTERVAL '30 days'
            )::numeric
            /
            NULLIF(
              COUNT(DISTINCT target_id) FILTER (
                WHERE target_type = 'search_query'
                  AND feedback_type = 'search_interaction'
                  AND feedback_value = 'search_impression'
                  AND created_at >= NOW() - INTERVAL '30 days'
              )::numeric,
              0
            ),
            NULL
          ) AS ai_search_workflow_conversion_rate_30d
        FROM ai_feedback
      ),
      risk_resolution_counts AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'resolved' AND resolved_at >= NOW() - INTERVAL '30 days')::int AS resolved_blind_spots_30d,
          COUNT(*) FILTER (
            WHERE status = 'open'
              AND EXISTS (
                SELECT 1
                FROM ai_risk_flags rf_prev
                WHERE rf_prev.deal_id = ai_risk_flags.deal_id
                  AND rf_prev.flag_type = ai_risk_flags.flag_type
                  AND rf_prev.id <> ai_risk_flags.id
                  AND rf_prev.status = 'resolved'
              )
          )::int AS recurring_blind_spots_open
        FROM ai_risk_flags
      ),
      recurring_suggestion_counts AS (
        SELECT
          COUNT(*) FILTER (
            WHERE status = 'suggested'
              AND EXISTS (
                SELECT 1
                FROM ai_task_suggestions ts_prev
                WHERE ts_prev.scope_type = ai_task_suggestions.scope_type
                  AND ts_prev.scope_id = ai_task_suggestions.scope_id
                  AND ts_prev.title = ai_task_suggestions.title
                  AND ts_prev.id <> ai_task_suggestions.id
                  AND ts_prev.status IN ('dismissed', 'accepted')
              )
          )::int AS recurring_suggestions_open
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
        triage_counts.triage_actions_30d,
        triage_counts.escalations_30d,
        search_interaction_counts.ai_search_interactions_30d,
        search_interaction_counts.ai_search_queries_with_click_30d,
        search_interaction_counts.ai_search_queries_served_30d,
        search_interaction_counts.ai_search_workflow_executions_30d,
        search_interaction_counts.ai_search_queries_with_workflow_30d,
        search_interaction_counts.ai_search_workflow_conversion_rate_30d,
        risk_resolution_counts.resolved_blind_spots_30d,
        risk_resolution_counts.recurring_blind_spots_open,
        recurring_suggestion_counts.recurring_suggestions_open,
        feedback_counts.positive_feedback_30d,
        feedback_counts.negative_feedback_30d,
        document_counts.documents_indexed,
        document_counts.documents_pending
      FROM packet_counts, risk_counts, suggestion_counts, triage_counts, search_interaction_counts, risk_resolution_counts, recurring_suggestion_counts, feedback_counts, document_counts
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
    triageActions30d: Number(summaryRow.triage_actions_30d ?? 0),
    escalations30d: Number(summaryRow.escalations_30d ?? 0),
    aiSearchInteractions30d: Number(summaryRow.ai_search_interactions_30d ?? 0),
    aiSearchQueriesWithClick30d: Number(summaryRow.ai_search_queries_with_click_30d ?? 0),
    aiSearchQueriesServed30d: Number(summaryRow.ai_search_queries_served_30d ?? 0),
    aiSearchWorkflowExecutions30d: Number(summaryRow.ai_search_workflow_executions_30d ?? 0),
    aiSearchQueriesWithWorkflow30d: Number(summaryRow.ai_search_queries_with_workflow_30d ?? 0),
    aiSearchWorkflowConversionRate30d:
      summaryRow.ai_search_workflow_conversion_rate_30d == null
        ? null
        : Number(summaryRow.ai_search_workflow_conversion_rate_30d),
    resolvedBlindSpots30d: Number(summaryRow.resolved_blind_spots_30d ?? 0),
    recurringBlindSpotsOpen: Number(summaryRow.recurring_blind_spots_open ?? 0),
    recurringSuggestionsOpen: Number(summaryRow.recurring_suggestions_open ?? 0),
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
