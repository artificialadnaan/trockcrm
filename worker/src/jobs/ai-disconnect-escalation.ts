import { pool } from "../db.js";

export async function runAiDisconnectEscalationScan(): Promise<void> {
  console.log("[Worker:ai-disconnect-escalation] Starting escalation scan...");

  const client = await pool.connect();
  try {
    const offices = await client.query("SELECT id, slug, name FROM public.offices WHERE is_active = true");

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) continue;

      const schemaName = `office_${office.slug}`;
      let lockId = 0;
      for (const char of `ai_escalation:${office.id}`) {
        lockId = ((lockId * 31) + char.charCodeAt(0)) >>> 0;
      }

      const lockResult = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [lockId]);
      if (!lockResult.rows[0]?.acquired) continue;

      try {
        await client.query("BEGIN");

        const criticalRowsRes = await client.query(
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
            critical_disconnects AS (
              SELECT
                d.id AS deal_id,
                d.deal_number,
                d.name AS deal_name,
                'procore_bid_board_drift'::text AS disconnect_type,
                'Bid board sync drift'::text AS disconnect_label,
                FLOOR(EXTRACT(EPOCH FROM (NOW() - pss.updated_at)) / 86400)::int AS age_days
              FROM ${schemaName}.deals d
              JOIN public.procore_sync_state pss
                ON pss.crm_entity_type = 'deal'
               AND pss.crm_entity_id = d.id
               AND pss.entity_type IN ('project', 'bid')
              WHERE d.is_active = TRUE
                AND d.procore_project_id IS NOT NULL
                AND pss.sync_status != 'synced'
                AND FLOOR(EXTRACT(EPOCH FROM (NOW() - pss.updated_at)) / 86400) >= 3

              UNION ALL

              SELECT
                d.id AS deal_id,
                d.deal_number,
                d.name AS deal_name,
                'inbound_without_followup'::text AS disconnect_type,
                'Inbound with no follow-up'::text AS disconnect_label,
                FLOOR(EXTRACT(EPOCH FROM (NOW() - latest_email.sent_at)) / 86400)::int AS age_days
              FROM ${schemaName}.deals d
              JOIN LATERAL (
                SELECT e.sent_at
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
                ORDER BY e.sent_at DESC
                LIMIT 1
              ) latest_email ON TRUE
              WHERE d.is_active = TRUE
                AND FLOOR(EXTRACT(EPOCH FROM (NOW() - latest_email.sent_at)) / 86400) >= 3
            )
            SELECT
              deal_id,
              deal_number,
              deal_name,
              disconnect_type,
              disconnect_label,
              age_days
            FROM critical_disconnects
            ORDER BY age_days DESC, deal_number ASC
            LIMIT 5
          `
        );

        const criticalRows = criticalRowsRes.rows;
        if (criticalRows.length === 0) {
          await client.query("COMMIT");
          continue;
        }

        const recipients = await client.query(
          "SELECT id FROM public.users WHERE office_id = $1 AND role IN ('director', 'admin') AND is_active = true",
          [office.id]
        );

        const title = `AI Escalation: ${criticalRows.length} critical disconnects need intervention`;
        const body = criticalRows
          .map((row) => `${row.disconnect_label}: ${row.deal_number} ${row.deal_name} (${row.age_days}d)`)
          .join("; ");

        for (const recipient of recipients.rows) {
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
