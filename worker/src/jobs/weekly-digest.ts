import { pool } from "../db.js";

/**
 * Generates a weekly digest task for each director/admin in every active office.
 *
 * Runs Monday at 7am CT via cron. Per-office with advisory lock to prevent
 * duplicate runs in multi-worker deployments.
 *
 * Stats included:
 * - Stale deals (stage_entered_at + stale_threshold_days < NOW(), non-terminal)
 * - Deals approaching deadline (expected_close_date within next 7 days)
 * - New deals this week (created_at >= NOW() - 7 days)
 * - Total active pipeline value (SUM of awarded_amount or bid_estimate, non-terminal)
 */
export async function runWeeklyDigest(): Promise<void> {
  console.log("[Worker:weekly-digest] Starting weekly digest generation...");

  const client = await pool.connect();
  try {
    // Get all active offices
    const offices = await client.query(
      "SELECT id, slug, name FROM public.offices WHERE is_active = true"
    );

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:weekly-digest] Invalid office slug: "${office.slug}" — skipping`);
        continue;
      }

      const schemaName = `office_${office.slug}`;

      // Advisory lock per office to prevent duplicate digest runs
      const lockId = Buffer.from(office.id.replace(/-/g, "").slice(0, 8), "hex").readUInt32BE(0);
      const lockResult = await client.query(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [lockId]
      );

      if (!lockResult.rows[0]?.acquired) {
        console.log(`[Worker:weekly-digest] Could not acquire lock for office ${office.slug} — skipping`);
        continue;
      }

      try {
        await client.query("BEGIN");

        // 1. Stale deals count
        const staleRes = await client.query(
          `SELECT COUNT(*) AS count
           FROM ${schemaName}.deals d
           JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
           WHERE d.is_active = true
             AND psc.is_terminal = false
             AND psc.stale_threshold_days IS NOT NULL
             AND d.stage_entered_at < NOW() - (psc.stale_threshold_days || ' days')::interval`
        );
        const staleCount = Number(staleRes.rows[0]?.count ?? 0);

        // 2. Deals approaching deadline (expected_close_date within next 7 days)
        const approachingRes = await client.query(
          `SELECT COUNT(*) AS count
           FROM ${schemaName}.deals d
           JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
           WHERE d.is_active = true
             AND psc.is_terminal = false
             AND d.expected_close_date IS NOT NULL
             AND d.expected_close_date BETWEEN CURRENT_DATE AND CURRENT_DATE + interval '7 days'`
        );
        const approachingCount = Number(approachingRes.rows[0]?.count ?? 0);

        // 3. New deals this week
        const newDealsRes = await client.query(
          `SELECT COUNT(*) AS count
           FROM ${schemaName}.deals d
           WHERE d.is_active = true
             AND d.created_at >= NOW() - interval '7 days'`
        );
        const newDealsCount = Number(newDealsRes.rows[0]?.count ?? 0);

        // 4. Total active pipeline value
        const valueRes = await client.query(
          `SELECT COALESCE(SUM(COALESCE(d.awarded_amount, d.bid_estimate, 0)), 0) AS total_value
           FROM ${schemaName}.deals d
           JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
           WHERE d.is_active = true
             AND psc.is_terminal = false`
        );
        const totalValue = Number(valueRes.rows[0]?.total_value ?? 0);
        const formattedValue = new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
        }).format(totalValue);

        // Build digest content
        const title = `Weekly Digest: ${staleCount} stale, ${approachingCount} approaching deadline, ${newDealsCount} new — ${formattedValue} pipeline`;
        const description = [
          `Weekly Pipeline Digest for ${office.name}`,
          ``,
          `Stale Deals: ${staleCount} deals past their stage threshold`,
          `Approaching Deadline: ${approachingCount} deals with expected close date in the next 7 days`,
          `New This Week: ${newDealsCount} deals created in the past 7 days`,
          `Total Active Pipeline Value: ${formattedValue}`,
          ``,
          `Generated: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`,
        ].join("\n");

        // Find all directors/admins in this office
        const directors = await client.query(
          `SELECT id FROM public.users
           WHERE office_id = $1 AND role IN ('director', 'admin') AND is_active = true`,
          [office.id]
        );

        if (directors.rows.length === 0) {
          console.log(`[Worker:weekly-digest] No directors/admins in office ${office.slug} — skipping`);
          await client.query("COMMIT");
          continue;
        }

        const dueDate = new Date().toISOString().split("T")[0];

        for (const director of directors.rows) {
          // Check if a digest task already exists for today (avoid duplicates)
          const existingTask = await client.query(
            `SELECT id FROM ${schemaName}.tasks
             WHERE type = 'system'
               AND title LIKE 'Weekly Digest:%'
               AND assigned_to = $1
               AND created_at >= CURRENT_DATE
             LIMIT 1`,
            [director.id]
          );

          if (existingTask.rows.length > 0) continue;

          await client.query(
            `INSERT INTO ${schemaName}.tasks
             (title, description, type, priority, status, assigned_to, due_date)
             VALUES ($1, $2, 'system', 'normal', 'pending', $3, $4)`,
            [title, description, director.id, dueDate]
          );
        }

        await client.query("COMMIT");
        console.log(`[Worker:weekly-digest] Digest created for office ${office.slug}: ${directors.rows.length} directors`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`[Worker:weekly-digest] Error for office ${office.slug}:`, err);
      } finally {
        // Release advisory lock
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => {});
      }
    }

    console.log("[Worker:weekly-digest] Weekly digest generation complete.");
  } catch (err) {
    console.error("[Worker:weekly-digest] Fatal error:", err);
    throw err;
  } finally {
    client.release();
  }
}
