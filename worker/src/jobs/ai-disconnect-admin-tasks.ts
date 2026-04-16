import { pool } from "../db.js";

export async function runAiDisconnectAdminTaskGeneration(): Promise<void> {
  console.log("[Worker:ai-disconnect-admin-tasks] Starting admin task generation...");

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
        console.warn(`[Worker:ai-disconnect-admin-tasks] Skipping office ${office.slug}: schema ${schemaName} does not exist`);
        continue;
      }
      let lockId = 0;
      for (const char of `ai_admin_tasks:${office.id}`) {
        lockId = ((lockId * 31) + char.charCodeAt(0)) >>> 0;
      }
      const lockResult = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [lockId]);
      if (!lockResult.rows[0]?.acquired) continue;

      try {
        await client.query("BEGIN");

        const assignees = await client.query(
          "SELECT id FROM public.users WHERE office_id = $1 AND role IN ('director', 'admin') AND is_active = true ORDER BY role DESC, created_at ASC LIMIT 1",
          [office.id]
        );
        const assigneeId = assignees.rows[0]?.id;
        if (!assigneeId) {
          await client.query("COMMIT");
          continue;
        }

        const rowsRes = await client.query(
          `
            WITH latest_procore_sync AS (
              SELECT DISTINCT ON (pss.crm_entity_id)
                pss.crm_entity_id AS deal_id,
                pss.sync_status,
                pss.updated_at
              FROM public.procore_sync_state pss
              WHERE pss.crm_entity_type = 'deal'
                AND pss.entity_type IN ('project', 'bid')
              ORDER BY pss.crm_entity_id, pss.updated_at DESC
            ),
            disconnect_rows AS (
              SELECT
                d.id AS deal_id,
                d.deal_number,
                d.name AS deal_name,
                'procore_bid_board_drift'::text AS disconnect_type,
                'Bid board sync drift'::text AS disconnect_label,
                FLOOR(EXTRACT(EPOCH FROM (NOW() - lps.updated_at)) / 86400)::int AS age_days
              FROM ${schemaName}.deals d
              JOIN latest_procore_sync lps ON lps.deal_id = d.id
              WHERE d.is_active = TRUE
                AND d.procore_project_id IS NOT NULL
                AND lps.sync_status != 'synced'
                AND FLOOR(EXTRACT(EPOCH FROM (NOW() - lps.updated_at)) / 86400) >= 3

              UNION ALL

              SELECT
                d.id AS deal_id,
                d.deal_number,
                d.name AS deal_name,
                'estimating_gate_gap'::text AS disconnect_type,
                'Estimating gate gap'::text AS disconnect_label,
                FLOOR(EXTRACT(EPOCH FROM (NOW() - d.stage_entered_at)) / 86400)::int AS age_days
              FROM ${schemaName}.deals d
              JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
              WHERE d.is_active = TRUE
                AND COALESCE(jsonb_array_length(psc.required_documents), 0) > (
                  SELECT COUNT(DISTINCT f.category)::int
                  FROM ${schemaName}.files f
                  WHERE f.deal_id = d.id
                    AND f.is_active = TRUE
                )
                AND FLOOR(EXTRACT(EPOCH FROM (NOW() - d.stage_entered_at)) / 86400) >= 3

              UNION ALL

              SELECT
                d.id AS deal_id,
                d.deal_number,
                d.name AS deal_name,
                'inbound_without_followup'::text AS disconnect_type,
                'Inbound with no follow-up'::text AS disconnect_label,
                FLOOR(EXTRACT(EPOCH FROM (NOW() - latest_inbound.latest_customer_email_at)) / 86400)::int AS age_days
              FROM ${schemaName}.deals d
              JOIN LATERAL (
                SELECT MAX(e.sent_at) AS latest_customer_email_at
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
              ) latest_inbound ON latest_inbound.latest_customer_email_at IS NOT NULL
              WHERE d.is_active = TRUE
                AND FLOOR(EXTRACT(EPOCH FROM (NOW() - latest_inbound.latest_customer_email_at)) / 86400) >= 3

              UNION ALL

              SELECT
                d.id AS deal_id,
                d.deal_number,
                d.name AS deal_name,
                'missing_next_task'::text AS disconnect_type,
                'Missing next task'::text AS disconnect_label,
                FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(d.last_activity_at, d.stage_entered_at, d.updated_at))) / 86400)::int AS age_days
              FROM ${schemaName}.deals d
              WHERE d.is_active = TRUE
                AND NOT EXISTS (
                  SELECT 1
                  FROM ${schemaName}.tasks t
                  WHERE t.deal_id = d.id
                    AND t.status IN ('pending', 'in_progress', 'waiting_on', 'blocked')
                )
                AND FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(d.last_activity_at, d.stage_entered_at, d.updated_at))) / 86400) >= 3
            )
            SELECT *
            FROM disconnect_rows
            ORDER BY age_days DESC, deal_number ASC
            LIMIT 10
          `
        );

        for (const row of rowsRes.rows) {
          const title = `Resolve ${row.disconnect_label} for ${row.deal_number}`;
          const description = `${row.deal_name} has an open ${row.disconnect_label.toLowerCase()} for ${row.age_days} day(s).`;
          const dedupeKey = `${row.disconnect_type}:${row.deal_id}`;
          const existingTask = await client.query(
            `SELECT id
             FROM ${schemaName}.tasks
             WHERE origin_rule = $1
               AND dedupe_key = $2
               AND status IN ('scheduled', 'pending', 'in_progress', 'waiting_on', 'blocked')
             LIMIT 1`,
            ["ai_disconnect_admin_task", dedupeKey]
          );
          if (existingTask.rows.length > 0) {
            continue;
          }
          await client.query(
            `INSERT INTO ${schemaName}.tasks
               (title, description, type, priority, status, assigned_to, office_id, origin_rule, source_event, dedupe_key, reason_code, entity_snapshot, deal_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
             RETURNING id`,
            [
              title,
              description,
              "manual",
              "high",
              "pending",
              assigneeId,
              office.id,
              "ai_disconnect_admin_task",
              "cron.ai_disconnect_admin_tasks",
              dedupeKey,
              row.disconnect_type,
              JSON.stringify({
                disconnectType: row.disconnect_type,
                disconnectLabel: row.disconnect_label,
                ageDays: row.age_days,
              }),
              row.deal_id,
            ]
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
