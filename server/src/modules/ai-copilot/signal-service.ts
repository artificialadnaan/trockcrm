import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

type QueryResultRow = Record<string, any>;

function getRows(result: unknown): QueryResultRow[] {
  if (Array.isArray(result)) return result as QueryResultRow[];
  if (result && typeof result === "object" && "rows" in result) {
    return ((result as { rows?: QueryResultRow[] }).rows ?? []) as QueryResultRow[];
  }
  return [];
}

export interface DealBlindSpotSignal {
  signalType: string;
  severity: string;
  summary: string;
  evidence: Array<Record<string, unknown>>;
  isBlocking: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function getDealBlindSpotSignals(
  tenantDb: TenantDb,
  dealId: string,
  now = new Date()
): Promise<DealBlindSpotSignal[]> {
  const [dealResult, openTaskResult, inboundResult, revisionResult, gateGapResult] = await Promise.all([
    tenantDb.execute(sql`
      SELECT
        d.id AS deal_id,
        d.stage_id,
        psc.name AS stage_name,
        d.stage_entered_at,
        psc.stale_threshold_days,
        d.proposal_status,
        psc.required_documents
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.id = ${dealId}
      LIMIT 1
    `),
    tenantDb.execute(sql`
      SELECT COUNT(*)::int AS open_task_count
      FROM tasks
      WHERE deal_id = ${dealId}
        AND status IN ('pending', 'in_progress', 'waiting_on', 'blocked')
    `),
    tenantDb.execute(sql`
      SELECT COUNT(*)::int AS inbound_without_followup_count
      FROM emails e
      WHERE e.deal_id = ${dealId}
        AND e.direction = 'inbound'
        AND NOT EXISTS (
          SELECT 1
          FROM activities a
          WHERE a.deal_id = e.deal_id
            AND a.occurred_at >= e.sent_at
            AND a.type IN ('call', 'email', 'meeting', 'note')
        )
    `),
    tenantDb.execute(sql`
      SELECT COUNT(*)::int AS revision_owner_movement_count
      FROM deal_stage_history dsh
      JOIN deals d ON d.id = dsh.deal_id
      WHERE dsh.deal_id = ${dealId}
        AND d.proposal_status = 'revision_requested'
        AND dsh.created_at >= NOW() - INTERVAL '30 days'
    `),
    tenantDb.execute(sql`
      SELECT COUNT(*)::int AS missing_required_document_count
      FROM (
        SELECT jsonb_array_length(COALESCE(psc.required_documents, '[]'::jsonb)) AS required_count
        FROM deals d
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE d.id = ${dealId}
      ) required_docs
      LEFT JOIN (
        SELECT COUNT(DISTINCT category)::int AS present_count
        FROM files
        WHERE deal_id = ${dealId}
          AND is_active = TRUE
      ) present_docs ON TRUE
    `),
  ]);

  const dealRow = getRows(dealResult)[0];
  if (!dealRow) return [];

  const signals: DealBlindSpotSignal[] = [];
  const stageEnteredAt = dealRow.stage_entered_at ? new Date(dealRow.stage_entered_at) : null;
  const staleThresholdDays = Number(dealRow.stale_threshold_days ?? 0);
  const daysInStage = stageEnteredAt ? Math.floor((now.getTime() - stageEnteredAt.getTime()) / MS_PER_DAY) : 0;

  if (staleThresholdDays > 0 && daysInStage > staleThresholdDays) {
    signals.push({
      signalType: "stale_stage",
      severity: "warning",
      summary: `${dealRow.stage_name} has exceeded its stale threshold`,
      evidence: [{ dealId, stageName: dealRow.stage_name, daysInStage, staleThresholdDays }],
      isBlocking: false,
    });
  }

  const openTaskCount = Number(getRows(openTaskResult)[0]?.open_task_count ?? 0);
  if (openTaskCount === 0) {
    signals.push({
      signalType: "missing_next_task",
      severity: "warning",
      summary: "Deal has no open next-step task",
      evidence: [{ dealId, openTaskCount }],
      isBlocking: false,
    });
  }

  const inboundWithoutFollowupCount = Number(getRows(inboundResult)[0]?.inbound_without_followup_count ?? 0);
  if (inboundWithoutFollowupCount > 0) {
    signals.push({
      signalType: "recent_inbound_no_followup",
      severity: "warning",
      summary: "Inbound customer communication has no follow-up activity",
      evidence: [{ dealId, inboundWithoutFollowupCount }],
      isBlocking: false,
    });
  }

  const revisionOwnerMovementCount = Number(getRows(revisionResult)[0]?.revision_owner_movement_count ?? 0);
  if (dealRow.proposal_status === "revision_requested" && revisionOwnerMovementCount === 0) {
    signals.push({
      signalType: "revision_without_owner_movement",
      severity: "critical",
      summary: "Revision requested without visible ownership or workflow movement",
      evidence: [{ dealId, proposalStatus: dealRow.proposal_status, revisionOwnerMovementCount }],
      isBlocking: true,
    });
  }

  const missingRequiredDocumentCount = Number(getRows(gateGapResult)[0]?.missing_required_document_count ?? 0);
  if (missingRequiredDocumentCount > 0) {
    signals.push({
      signalType: "estimating_gate_gap",
      severity: "critical",
      summary: "Estimating gate requirements appear incomplete",
      evidence: [{ dealId, missingRequiredDocumentCount }],
      isBlocking: true,
    });
  }

  return signals;
}
