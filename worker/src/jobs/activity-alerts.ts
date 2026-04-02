import { pool } from "../db.js";

/**
 * Activity drop detection job.
 *
 * Runs daily at 7:00 AM CT. For each active office:
 * 1. Calculate each rep's 90-day rolling average activity count (per week)
 * 2. Calculate their last 7 days of activity
 * 3. If last 7 days < (rolling_avg - 1 standard deviation), flag as activity drop
 * 4. Create notification for all directors/admins in the rep's office
 *
 * Activity types counted: call, meeting, email (not notes or task_completed,
 * which are passive activities).
 */
export async function runActivityDropDetection(): Promise<void> {
  console.log("[Worker:activity-alerts] Starting activity drop detection...");

  const client = await pool.connect();
  try {
    const offices = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    let totalAlerts = 0;

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:activity-alerts] Invalid office slug: "${office.slug}" -- skipping`);
        continue;
      }
      const schemaName = `office_${office.slug}`;

      // Acquire advisory lock per office to prevent concurrent runs from racing
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('activity_drop_detection_' || $1))`,
        [office.id]
      );

      // Get all active reps in this office
      const reps = await client.query(
        `SELECT id, display_name FROM public.users
         WHERE office_id = $1 AND role = 'rep' AND is_active = true`,
        [office.id]
      );

      for (const rep of reps.rows) {
        // Calculate 90-day rolling weekly averages for outreach activities.
        // Generate ALL 13 weeks in the window via generate_series and LEFT JOIN
        // actual counts, so weeks with zero activity show as 0 (not excluded).
        const statsResult = await client.query(
          `WITH weeks AS (
            SELECT generate_series(
              date_trunc('week', NOW() - interval '90 days'),
              date_trunc('week', NOW()),
              interval '1 week'
            ) AS week_start
          ),
          weekly_counts AS (
            SELECT w.week_start, COALESCE(COUNT(a.id), 0) AS activity_count
            FROM weeks w
            LEFT JOIN ${schemaName}.activities a
              ON date_trunc('week', a.occurred_at) = w.week_start
              AND a.user_id = $1
              AND a.type IN ('call', 'meeting', 'email')
            GROUP BY w.week_start
          )
          SELECT
            COALESCE(AVG(activity_count), 0)::numeric(10,2) AS avg_weekly,
            COALESCE(STDDEV_POP(activity_count), 0)::numeric(10,2) AS stddev_weekly,
            COUNT(*)::int AS weeks_with_data
          FROM weekly_counts`,
          [rep.id]
        );

        const stats = statsResult.rows[0];
        const avgWeekly = parseFloat(stats.avg_weekly);
        const stddevWeekly = parseFloat(stats.stddev_weekly);
        const weeksWithData = parseInt(stats.weeks_with_data, 10);

        // Need at least 4 weeks of data for a meaningful baseline
        if (weeksWithData < 4) continue;

        // Count last 7 days of activity
        const recentResult = await client.query(
          `SELECT COUNT(*)::int AS recent_count
           FROM ${schemaName}.activities
           WHERE user_id = $1
             AND type IN ('call', 'meeting', 'email')
             AND occurred_at >= NOW() - INTERVAL '7 days'`,
          [rep.id]
        );

        const recentCount = recentResult.rows[0].recent_count;
        const threshold = avgWeekly - stddevWeekly;

        // Flag if below threshold
        if (recentCount < threshold && threshold > 0) {
          // Check if already notified today (dedup)
          const existingNotification = await client.query(
            `SELECT id FROM ${schemaName}.notifications
             WHERE type = 'activity_drop'
               AND body LIKE $1
               AND created_at >= CURRENT_DATE
             LIMIT 1`,
            [`%${rep.display_name}%`]
          );

          if (existingNotification.rows.length > 0) continue;

          const title = `Activity drop: ${rep.display_name}`;
          const body = `${rep.display_name} logged ${recentCount} activities in the last 7 days (avg: ${avgWeekly.toFixed(1)}/week, threshold: ${threshold.toFixed(1)}). This is below their 90-day baseline.`;

          // Notify all directors/admins in this office
          const directors = await client.query(
            `SELECT id FROM public.users
             WHERE office_id = $1 AND role IN ('director', 'admin') AND is_active = true`,
            [office.id]
          );

          for (const director of directors.rows) {
            await client.query(
              `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
               VALUES ($1, 'activity_drop', $2, $3, $4)`,
              [director.id, title, body, `/director`]
            );
            totalAlerts++;
          }

          console.log(`[Worker:activity-alerts] Activity drop detected for ${rep.display_name} in ${office.slug}: ${recentCount} vs avg ${avgWeekly.toFixed(1)}`);
        }
      }

      // Release the advisory lock by committing the transaction for this office
      await client.query("COMMIT");
    }

    console.log(`[Worker:activity-alerts] Complete. Created ${totalAlerts} alerts`);
  } catch (err) {
    console.error("[Worker:activity-alerts] Failed:", err);
    throw err;
  } finally {
    client.release();
  }
}
