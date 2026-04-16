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

export interface DealCopilotContext {
  deal: {
    id: string;
    dealNumber: string;
    name: string;
    stageId: string;
    stageName: string;
    assignedRepId: string;
    ddEstimate: string | null;
    bidEstimate: string | null;
    awardedAmount: string | null;
    proposalStatus: string | null;
    lastActivityAt: string | null;
    expectedCloseDate: string | null;
    staleThresholdDays: number | null;
  };
  recentActivities: Array<{
    id: string;
    type: string;
    subject: string | null;
    body: string | null;
    occurredAt: string;
  }>;
  recentEmails: Array<{
    id: string;
    subject: string | null;
    bodyPreview: string | null;
    direction: string;
    sentAt: string;
    fromAddress: string;
    toAddresses: string[];
  }>;
  taskSummary: {
    openTaskCount: number;
    overdueTaskCount: number;
  };
}

export async function getDealCopilotContext(
  tenantDb: TenantDb,
  dealId: string
): Promise<DealCopilotContext> {
  const [dealResult, activitiesResult, emailsResult, taskSummaryResult] = await Promise.all([
    tenantDb.execute(sql`
      SELECT
        d.id,
        d.deal_number,
        d.name,
        d.stage_id,
        psc.name AS stage_name,
        d.assigned_rep_id,
        d.dd_estimate,
        d.bid_estimate,
        d.awarded_amount,
        d.proposal_status,
        d.last_activity_at,
        d.expected_close_date,
        psc.stale_threshold_days
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.id = ${dealId}
      LIMIT 1
    `),
    tenantDb.execute(sql`
      SELECT id, type, subject, body, occurred_at
      FROM activities
      WHERE deal_id = ${dealId}
      ORDER BY occurred_at DESC
      LIMIT 10
    `),
    tenantDb.execute(sql`
      SELECT id, subject, body_preview, direction, sent_at, from_address, to_addresses
      FROM emails
      WHERE deal_id = ${dealId}
      ORDER BY sent_at DESC
      LIMIT 10
    `),
    tenantDb.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('pending', 'in_progress', 'waiting_on', 'blocked'))::int AS open_task_count,
        COUNT(*) FILTER (WHERE status IN ('pending', 'in_progress', 'waiting_on', 'blocked') AND due_date < CURRENT_DATE)::int AS overdue_task_count
      FROM tasks
      WHERE deal_id = ${dealId}
    `),
  ]);

  const dealRow = getRows(dealResult)[0];
  if (!dealRow) {
    throw new Error(`Deal ${dealId} not found`);
  }

  const activities = getRows(activitiesResult).map((row) => ({
    id: row.id,
    type: row.type,
    subject: row.subject ?? null,
    body: row.body ?? null,
    occurredAt: row.occurred_at,
  }));

  const emails = getRows(emailsResult).map((row) => ({
    id: row.id,
    subject: row.subject ?? null,
    bodyPreview: row.body_preview ?? null,
    direction: row.direction,
    sentAt: row.sent_at,
    fromAddress: row.from_address,
    toAddresses: row.to_addresses ?? [],
  }));

  const taskSummaryRow = getRows(taskSummaryResult)[0] ?? {};

  return {
    deal: {
      id: dealRow.id,
      dealNumber: dealRow.deal_number,
      name: dealRow.name,
      stageId: dealRow.stage_id,
      stageName: dealRow.stage_name,
      assignedRepId: dealRow.assigned_rep_id,
      ddEstimate: dealRow.dd_estimate ?? null,
      bidEstimate: dealRow.bid_estimate ?? null,
      awardedAmount: dealRow.awarded_amount ?? null,
      proposalStatus: dealRow.proposal_status ?? null,
      lastActivityAt: dealRow.last_activity_at ?? null,
      expectedCloseDate: dealRow.expected_close_date ?? null,
      staleThresholdDays: dealRow.stale_threshold_days ?? null,
    },
    recentActivities: activities,
    recentEmails: emails,
    taskSummary: {
      openTaskCount: Number(taskSummaryRow.open_task_count ?? 0),
      overdueTaskCount: Number(taskSummaryRow.overdue_task_count ?? 0),
    },
  };
}
