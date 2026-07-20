import { getDealAtRiskResult, type WorkflowRoute } from "@trock-crm/shared/types";
import { pool } from "../db.js";

type AiDigestAtRiskRow = {
  id: string;
  assigned_rep_name: string | null;
  stage_slug: string | null;
  workflow_route: string | null;
  stage_entered_at: string | Date | null;
  expected_close_date: string | Date | null;
  on_hold: boolean | null;
  on_hold_started_at: string | Date | null;
  on_hold_accumulated_seconds: string | number | bigint | null;
  on_hold_accumulated_seconds_at_stage_entry: string | number | bigint | null;
};

type DigestClusterRow = {
  cluster_key?: string | null;
  title: string;
  deal_count: string | number | null;
};

type DigestHotspotRow = {
  hotspot_key?: string | null;
  hotspot_label: string;
  disconnect_count: string | number | null;
  critical_count: string | number | null;
};

function normalizeWorkflowRoute(value: string | null | undefined): WorkflowRoute {
  return value === "service" ? "service" : "normal";
}

function numberOrNull(value: string | number | bigint | null | undefined): number | null {
  if (value == null) return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function numberValue(value: string | number | bigint | null | undefined): number {
  return numberOrNull(value) ?? 0;
}

function getDigestAtRiskRows(rows: AiDigestAtRiskRow[], now: Date): AiDigestAtRiskRow[] {
  return rows.filter((row) =>
    getDealAtRiskResult(
      {
        stageSlug: row.stage_slug,
        workflowRoute: normalizeWorkflowRoute(row.workflow_route),
        stageEnteredAt: row.stage_entered_at,
        // Match the app's at-risk (applyCloseTargetSuppression:true): a postponement (near today-or-future
        // close target) quiets the nag too, so the AI disconnect digest mirrors the deals
        // list/dashboard/detail — plus the 90+ day auto-held exclusion.
        expectedCloseDate: row.expected_close_date,
        applyCloseTargetSuppression: true,
        onHold: row.on_hold,
        onHoldStartedAt: row.on_hold_started_at,
        onHoldAccumulatedSeconds: numberOrNull(row.on_hold_accumulated_seconds),
        onHoldAccumulatedSecondsAtStageEntry: numberOrNull(
          row.on_hold_accumulated_seconds_at_stage_entry
        ),
      },
      "director",
      now
    ).isAtRisk
  );
}

function getStaleStageCluster(rows: AiDigestAtRiskRow[]): DigestClusterRow | null {
  return rows.length > 0
    ? { cluster_key: "execution_stall", title: "SLA / stage momentum", deal_count: rows.length }
    : null;
}

function getTopCluster(rows: Array<DigestClusterRow | null | undefined>): DigestClusterRow | null {
  return (
    rows
      .filter((row): row is DigestClusterRow => Boolean(row))
      .sort(
        (left, right) =>
          numberValue(right.deal_count) - numberValue(left.deal_count) ||
          left.title.localeCompare(right.title)
      )[0] ?? null
  );
}

function getTopAtRiskHotspot(rows: AiDigestAtRiskRow[]): DigestHotspotRow | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = row.assigned_rep_name ?? "Unassigned";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const [label, count] =
    Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
  return label ? { hotspot_label: label, disconnect_count: count, critical_count: 0 } : null;
}

function getTopHotspot(rows: Array<DigestHotspotRow | null | undefined>): DigestHotspotRow | null {
  return (
    rows
      .filter((row): row is DigestHotspotRow => Boolean(row))
      .sort(
        (left, right) =>
          numberValue(right.critical_count) - numberValue(left.critical_count) ||
          numberValue(right.disconnect_count) - numberValue(left.disconnect_count) ||
          left.hotspot_label.localeCompare(right.hotspot_label)
      )[0] ?? null
  );
}

export async function runAiDisconnectDigest(): Promise<void> {
  console.log("[Worker:ai-disconnect-digest] Starting digest generation...");

  const client = await pool.connect();
  try {
    const offices = await client.query("SELECT id, slug, name FROM public.offices WHERE is_active = true");

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) continue;

      const schemaName = `office_${office.slug}`;
      const schemaCheck = await client.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1",
        [schemaName]
      );
      if (schemaCheck.rows.length === 0) {
        console.warn(`[Worker:ai-disconnect-digest] Skipping office ${office.slug}: schema ${schemaName} does not exist`);
        continue;
      }
      let lockId = 0;
      for (const char of String(office.id)) {
        lockId = ((lockId * 31) + char.charCodeAt(0)) >>> 0;
      }
      const lockResult = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [lockId]);
      if (!lockResult.rows[0]?.acquired) continue;

      try {
        await client.query("BEGIN");
        const clockResult = await client.query("SELECT NOW() AS digest_now");
        const digestNow = new Date(clockResult.rows[0]?.digest_now ?? Date.now());

        const atRiskCandidateRes = await client.query(
          `
            SELECT
              d.id,
              COALESCE(u.display_name, 'Unassigned')::text AS assigned_rep_name,
              COALESCE(d.bid_board_stage_slug, psc.slug) AS stage_slug,
              d.workflow_route,
              COALESCE(
                d.bid_board_stage_entered_at,
                d.stage_entered_at,
                latest_current_stage_entered_at.entered_at
              ) AS stage_entered_at,
              d.expected_close_date,
              d.on_hold,
              d.on_hold_started_at,
              d.on_hold_accumulated_seconds,
              d.on_hold_accumulated_seconds_at_stage_entry
            FROM ${schemaName}.deals d
            JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
            LEFT JOIN public.users u ON u.id = d.assigned_rep_id
            LEFT JOIN LATERAL (
              SELECT entered_at
              FROM ${schemaName}.deal_stage_history dsh
              WHERE dsh.deal_id = d.id
                AND dsh.stage_id = d.stage_id
                AND dsh.exited_at IS NULL
              ORDER BY dsh.entered_at DESC
              LIMIT 1
            ) latest_current_stage_entered_at ON TRUE
            WHERE d.is_active = TRUE
              AND psc.is_terminal = FALSE
              AND COALESCE(d.is_test_data, false) = false
          `
        );
        const staleStageRows = getDigestAtRiskRows(atRiskCandidateRes.rows, digestNow);
        const staleStageCount = staleStageRows.length;

        const summaryRes = await client.query(
          `
            WITH latest_procore_sync AS (
              SELECT DISTINCT ON (pss.crm_entity_id)
                pss.crm_entity_id AS deal_id,
                pss.sync_status
              FROM public.procore_sync_state pss
              WHERE pss.crm_entity_type = 'deal'
                AND pss.entity_type IN ('project', 'bid')
              ORDER BY pss.crm_entity_id, pss.updated_at DESC
            ),
            base AS (
              SELECT
                d.id,
                d.proposal_status,
                COALESCE(jsonb_array_length(psc.required_documents), 0) AS required_document_count,
                COALESCE((
                  SELECT COUNT(DISTINCT f.category)::int
                  FROM ${schemaName}.files f
                  WHERE f.deal_id = d.id
                    AND f.is_active = TRUE
                ), 0) AS present_document_count,
                COALESCE((
                  SELECT COUNT(*)::int
                  FROM ${schemaName}.tasks t
                  WHERE t.deal_id = d.id
                    AND t.status IN ('pending', 'in_progress', 'waiting_on', 'blocked')
                ), 0) AS open_task_count,
                COALESCE((
                  SELECT COUNT(*)::int
                  FROM ${schemaName}.emails e
                  WHERE e.deal_id = d.id
                    AND e.direction = 'inbound'
                    AND NOT EXISTS (
                      SELECT 1
                      FROM ${schemaName}.activities a
                      WHERE a.deal_id = e.deal_id
                        AND a.occurred_at >= e.sent_at
                        AND a.type IN ('call', 'email', 'meeting', 'note')
                    )
                ), 0) AS inbound_without_followup_count,
                lps.sync_status AS procore_sync_status
              FROM ${schemaName}.deals d
              JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
              LEFT JOIN latest_procore_sync lps ON lps.deal_id = d.id
              WHERE d.is_active = TRUE
            )
            SELECT
              (
                COUNT(*) FILTER (WHERE open_task_count = 0) +
                COUNT(*) FILTER (WHERE inbound_without_followup_count > 0) +
                COUNT(*) FILTER (WHERE proposal_status = 'revision_requested') +
                COUNT(*) FILTER (WHERE required_document_count > present_document_count) +
                COUNT(*) FILTER (WHERE procore_sync_status IS NOT NULL AND procore_sync_status != 'synced')
              )::int AS total_disconnects,
              (
                COUNT(*) FILTER (WHERE inbound_without_followup_count > 0) +
                COUNT(*) FILTER (WHERE proposal_status = 'revision_requested') +
                COUNT(*) FILTER (WHERE required_document_count > present_document_count) +
                COUNT(*) FILTER (WHERE procore_sync_status IS NOT NULL AND procore_sync_status != 'synced')
              )::int AS critical_disconnects,
              COUNT(*) FILTER (WHERE procore_sync_status IS NOT NULL AND procore_sync_status != 'synced')::int AS bid_board_sync_drifts,
              COUNT(*) FILTER (WHERE inbound_without_followup_count > 0 OR open_task_count = 0)::int AS follow_through_gaps
            FROM base
          `
        );

        const summary = summaryRes.rows[0];
        const totalDisconnects = Number(summary?.total_disconnects ?? 0) + staleStageCount;
        if (!summary || totalDisconnects === 0) {
          await client.query("COMMIT");
          continue;
        }

        const clusterRes = await client.query(
          `
            WITH latest_procore_sync AS (
              SELECT DISTINCT ON (pss.crm_entity_id)
                pss.crm_entity_id AS deal_id,
                pss.sync_status
              FROM public.procore_sync_state pss
              WHERE pss.crm_entity_type = 'deal'
                AND pss.entity_type IN ('project', 'bid')
              ORDER BY pss.crm_entity_id, pss.updated_at DESC
            ),
            cluster_rows AS (
              SELECT 'bid_board_sync_break'::text AS cluster_key, 'Bid board / CRM stage drift'::text AS title, d.id
              FROM ${schemaName}.deals d
              JOIN latest_procore_sync lps ON lps.deal_id = d.id
              WHERE d.is_active = TRUE
                AND d.procore_project_id IS NOT NULL
                AND lps.sync_status != 'synced'

              UNION ALL

              SELECT 'follow_through_gap'::text AS cluster_key, 'Customer follow-through gap'::text AS title, d.id
              FROM ${schemaName}.deals d
              WHERE d.is_active = TRUE
                AND (
                  NOT EXISTS (
                    SELECT 1
                    FROM ${schemaName}.tasks t
                    WHERE t.deal_id = d.id
                      AND t.status IN ('pending', 'in_progress', 'waiting_on', 'blocked')
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM ${schemaName}.emails e
                    WHERE e.deal_id = d.id
                      AND e.direction = 'inbound'
                      AND NOT EXISTS (
                        SELECT 1
                        FROM ${schemaName}.activities a
                        WHERE a.deal_id = e.deal_id
                          AND a.occurred_at >= e.sent_at
                          AND a.type IN ('call', 'email', 'meeting', 'note')
                      )
                  )
                )
            )
            SELECT cluster_key, title, COUNT(DISTINCT id)::int AS deal_count
            FROM cluster_rows
            GROUP BY cluster_key, title
            ORDER BY deal_count DESC, title ASC
            LIMIT 1
          `
        );

        const hotspotRes = await client.query(
          `
            WITH latest_procore_sync AS (
              SELECT DISTINCT ON (pss.crm_entity_id)
                pss.crm_entity_id AS deal_id,
                pss.sync_status
              FROM public.procore_sync_state pss
              WHERE pss.crm_entity_type = 'deal'
                AND pss.entity_type IN ('project', 'bid')
              ORDER BY pss.crm_entity_id, pss.updated_at DESC
            ),
            base AS (
              SELECT
                COALESCE(u.display_name, 'Unassigned')::text AS hotspot_key,
                COALESCE(u.display_name, 'Unassigned')::text AS hotspot_label,
                d.proposal_status,
                COALESCE((
                  SELECT COUNT(*)::int
                  FROM ${schemaName}.tasks t
                  WHERE t.deal_id = d.id
                    AND t.status IN ('pending', 'in_progress', 'waiting_on', 'blocked')
                ), 0) AS open_task_count,
                COALESCE((
                  SELECT COUNT(*)::int
                  FROM ${schemaName}.emails e
                  WHERE e.deal_id = d.id
                    AND e.direction = 'inbound'
                    AND NOT EXISTS (
                      SELECT 1
                      FROM ${schemaName}.activities a
                      WHERE a.deal_id = e.deal_id
                        AND a.occurred_at >= e.sent_at
                        AND a.type IN ('call', 'email', 'meeting', 'note')
                    )
                ), 0) AS inbound_without_followup_count,
                COALESCE(jsonb_array_length(psc.required_documents), 0) AS required_document_count,
                COALESCE((
                  SELECT COUNT(DISTINCT f.category)::int
                  FROM ${schemaName}.files f
                  WHERE f.deal_id = d.id
                    AND f.is_active = TRUE
                ), 0) AS present_document_count,
                lps.sync_status AS procore_sync_status
              FROM ${schemaName}.deals d
              JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
              LEFT JOIN public.users u ON u.id = d.assigned_rep_id
              LEFT JOIN latest_procore_sync lps ON lps.deal_id = d.id
              WHERE d.is_active = TRUE
            ),
            disconnect_rows AS (
              SELECT
                hotspot_key,
                hotspot_label,
                (
                  CASE WHEN open_task_count = 0 THEN 1 ELSE 0 END +
                  CASE WHEN inbound_without_followup_count > 0 THEN 1 ELSE 0 END +
                  CASE WHEN proposal_status = 'revision_requested' THEN 1 ELSE 0 END +
                  CASE WHEN required_document_count > present_document_count THEN 1 ELSE 0 END +
                  CASE WHEN COALESCE(procore_sync_status, 'synced') != 'synced' THEN 1 ELSE 0 END
                )::int AS disconnect_count,
                (
                  CASE
                    WHEN proposal_status = 'revision_requested'
                      OR inbound_without_followup_count > 0
                      OR required_document_count > present_document_count
                      OR COALESCE(procore_sync_status, 'synced') != 'synced'
                    THEN 1 ELSE 0
                  END
                )::int AS critical_count
              FROM base
            )
            SELECT
              hotspot_key,
              hotspot_label,
              SUM(disconnect_count)::int AS disconnect_count,
              SUM(critical_count)::int AS critical_count
            FROM disconnect_rows
            GROUP BY hotspot_key, hotspot_label
            ORDER BY critical_count DESC, disconnect_count DESC, hotspot_label ASC
            LIMIT 1
          `
        );

        const topCluster = getTopCluster([
          clusterRes.rows[0] as DigestClusterRow | undefined,
          getStaleStageCluster(staleStageRows),
        ]);
        const engineHotspot = getTopAtRiskHotspot(staleStageRows);
        const hotspot = getTopHotspot([
          hotspotRes.rows[0] as DigestHotspotRow | undefined,
          engineHotspot,
        ]);
        const recipients = await client.query(
          "SELECT id FROM public.users WHERE office_id = $1 AND role IN ('director', 'admin') AND is_active = true",
          [office.id]
        );

        const title = `AI Disconnect Digest: ${totalDisconnects} open issues in ${office.name}`;
        const focus =
          Number(summary.bid_board_sync_drifts ?? 0) > 0
            ? "prioritize bid board reconciliation before follow-through gaps spread"
            : "prioritize follow-through gaps and missing next steps first";
        const recommendedAction =
          Number(summary.bid_board_sync_drifts ?? 0) > 0
            ? "escalate bid board drift items first, then clear missing-next-step follow-through gaps"
            : "clear missing-next-step follow-through gaps first, then resolve stale-stage execution stalls";
        const body = `${Number(summary.critical_disconnects)} critical disconnects. Top cluster: ${topCluster?.title ?? "No dominant cluster"} (${Number(topCluster?.deal_count ?? 0)} deals). Main hotspot: ${hotspot?.hotspot_label ?? "No hotspot"} (${Number(hotspot?.disconnect_count ?? 0)} disconnects, ${Number(hotspot?.critical_count ?? 0)} critical). Admin focus: ${focus}. Recommended action: ${recommendedAction}. Bid board drifts: ${Number(summary.bid_board_sync_drifts ?? 0)}. Follow-through gaps: ${Number(summary.follow_through_gaps ?? 0)}.`;

        for (const recipient of recipients.rows) {
          const existing = await client.query(
            `SELECT id
             FROM ${schemaName}.notifications
             WHERE user_id = $1
               AND title LIKE 'AI Disconnect Digest:%'
               AND created_at >= date_trunc('day', NOW())
             LIMIT 1`,
            [recipient.id]
          );
          if (existing.rows.length > 0) continue;

          await client.query(
            `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [recipient.id, "system", title, body, "/admin/sales-process-disconnects"]
          );
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => {});
      }
    }
  } finally {
    client.release();
  }
}
