import { pool } from "../db.js";

/**
 * Scans all active deals across all offices for stale deals.
 *
 * A deal is "stale" when:
 * - It's in a non-terminal stage
 * - The stage has a stale_threshold_days configured
 * - stage_entered_at is older than NOW() - threshold days
 *
 * Tiered escalation based on stale_escalation_tiers JSONB on pipeline_stage_config:
 * - warning tier:    notify assigned rep only
 * - escalation tier: notify rep + their manager (reports_to)
 * - critical tier:   notify rep + manager + all admins/directors in the office
 *
 * Notification title includes the tier severity.
 * Dedup: skip if a stale_deal notification already exists for this deal today.
 * A stale_deal task is created for the rep if none is active.
 *
 * This job runs daily at 6am via node-cron.
 */

interface EscalationTier {
  days: number;
  severity: "warning" | "escalation" | "critical";
}

function determineTier(daysInStage: number, tiers: EscalationTier[]): EscalationTier | null {
  // Sort descending by days so we find the highest applicable tier
  const sorted = [...tiers].sort((a, b) => b.days - a.days);
  return sorted.find((t) => daysInStage >= t.days) ?? null;
}

async function sendNotification(
  client: any,
  schemaName: string,
  userId: string,
  type: string,
  title: string,
  body: string,
  link: string
): Promise<void> {
  const result = await client.query(
    `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, type, title, body, link]
  );
  await client.query(
    `SELECT pg_notify('crm_events', $1)`,
    [JSON.stringify({
      eventName: "notification.created",
      userId,
      notificationId: result.rows[0]?.id,
    })]
  );
}

export async function runStaleDealScan(): Promise<void> {
  console.log("[Worker:stale-deals] Starting stale deal scan...");

  const client = await pool.connect();
  try {
    // Get all active offices
    const offices = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    let totalStale = 0;

    for (const office of offices.rows) {
      // Validate office slug before using in SQL to prevent injection.
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:stale-deals] Invalid office slug: "${office.slug}" — skipping`);
        continue;
      }
      const schemaName = `office_${office.slug}`;

      // Find stale deals: join deals with pipeline config, check threshold.
      // Also fetch stale_escalation_tiers for tier logic.
      const staleDeals = await client.query(
        `SELECT
           d.id AS deal_id,
           d.name AS deal_name,
           d.deal_number,
           d.assigned_rep_id,
           d.stage_entered_at,
           psc.name AS stage_name,
           psc.stale_threshold_days,
           psc.stale_escalation_tiers,
           EXTRACT(DAY FROM NOW() - d.stage_entered_at)::int AS days_in_stage
         FROM ${schemaName}.deals d
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         WHERE d.is_active = true
           AND psc.is_terminal = false
           AND psc.stale_threshold_days IS NOT NULL
           AND d.stage_entered_at < NOW() - (psc.stale_threshold_days || ' days')::interval`
      );

      if (staleDeals.rows.length === 0) {
        continue;
      }

      console.log(`[Worker:stale-deals] Found ${staleDeals.rows.length} stale deals in office ${office.slug}`);
      totalStale += staleDeals.rows.length;

      for (const staleDeal of staleDeals.rows) {
        // Check if a stale_deal notification already exists for this deal today
        const existingNotification = await client.query(
          `SELECT id FROM ${schemaName}.notifications
           WHERE type = 'stale_deal'
             AND link = $1
             AND created_at >= CURRENT_DATE
           LIMIT 1`,
          [`/deals/${staleDeal.deal_id}`]
        );

        if (existingNotification.rows.length > 0) {
          continue; // Already notified today
        }

        const daysInStage: number = staleDeal.days_in_stage;
        const rawTiers = staleDeal.stale_escalation_tiers as EscalationTier[] | null;
        const tiers: EscalationTier[] = Array.isArray(rawTiers) ? rawTiers : [];

        const tier = determineTier(daysInStage, tiers);
        const severity = tier?.severity ?? "warning";
        const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);

        const title = `[${severityLabel}] Stale Deal: ${staleDeal.deal_name}`;
        const body = `${staleDeal.deal_number} has been in "${staleDeal.stage_name}" for ${daysInStage} days (threshold: ${staleDeal.stale_threshold_days} days)`;
        const link = `/deals/${staleDeal.deal_id}`;

        // Always notify the assigned rep
        if (staleDeal.assigned_rep_id) {
          await sendNotification(client, schemaName, staleDeal.assigned_rep_id, "stale_deal", title, body, link);
        }

        // Escalation tier: also notify the rep's manager (reports_to)
        if (severity === "escalation" || severity === "critical") {
          if (staleDeal.assigned_rep_id) {
            const managerRes = await client.query(
              `SELECT reports_to FROM public.users WHERE id = $1 AND is_active = true`,
              [staleDeal.assigned_rep_id]
            );
            const managerId: string | null = managerRes.rows[0]?.reports_to ?? null;
            if (managerId && managerId !== staleDeal.assigned_rep_id) {
              await sendNotification(client, schemaName, managerId, "stale_deal", title, body, link);
            }
          }
        }

        // Critical tier: also notify all directors/admins in the office
        if (severity === "critical") {
          const admins = await client.query(
            `SELECT id FROM public.users
             WHERE office_id = $1 AND role IN ('director', 'admin') AND is_active = true`,
            [office.id]
          );

          for (const admin of admins.rows) {
            // Skip if already notified as manager above
            if (admin.id === staleDeal.assigned_rep_id) continue;
            await sendNotification(client, schemaName, admin.id, "stale_deal", title, body, link);
          }
        }

        // Create a stale_deal task for the rep (if one doesn't exist for this deal already)
        const existingTask = await client.query(
          `SELECT id FROM ${schemaName}.tasks
           WHERE type = 'stale_deal'
             AND deal_id = $1
             AND status IN ('pending', 'in_progress')
           LIMIT 1`,
          [staleDeal.deal_id]
        );

        if (existingTask.rows.length === 0) {
          await client.query(
            `INSERT INTO ${schemaName}.tasks
             (title, description, type, priority, status, assigned_to, deal_id, due_date)
             VALUES ($1, $2, 'stale_deal', 'high', 'pending', $3, $4, CURRENT_DATE)`,
            [
              `Follow up on stale deal: ${staleDeal.deal_number}`,
              body,
              staleDeal.assigned_rep_id,
              staleDeal.deal_id,
            ]
          );
        }
      }
    }

    console.log(`[Worker:stale-deals] Scan complete. Total stale deals: ${totalStale}`);
  } catch (err) {
    console.error("[Worker:stale-deals] Scan failed:", err);
    throw err;
  } finally {
    client.release();
  }
}
