import { pool } from "../db.js";

type ReportFrequency = "daily" | "weekly" | "biweekly" | "monthly" | "quarterly";

function addMonths(date: Date, months: number) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);

  return new Date(Date.UTC(
    year,
    month,
    clampedDay,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  ));
}

export function nextRunAt(from: Date, frequency: ReportFrequency) {
  const next = new Date(from);
  switch (frequency) {
    case "daily":
      next.setUTCDate(next.getUTCDate() + 1);
      break;
    case "weekly":
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case "biweekly":
      next.setUTCDate(next.getUTCDate() + 14);
      break;
    case "monthly":
      return addMonths(next, 1);
    case "quarterly":
      return addMonths(next, 3);
  }
  return next;
}

export async function enqueueDueReportSchedules(now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<{
      id: string;
      report_id: string;
      frequency: ReportFrequency;
    }>(
      `SELECT id, report_id, frequency
       FROM public.report_schedules
       WHERE is_active = true
         AND next_run_at <= $1
       ORDER BY next_run_at ASC
       LIMIT 50
       FOR UPDATE SKIP LOCKED`,
      [now]
    );

    for (const schedule of due.rows) {
      await client.query(
        `INSERT INTO public.report_runs (report_id, schedule_id, status)
         VALUES ($1, $2, 'queued')`,
        [schedule.report_id, schedule.id]
      );
      await client.query(
        `UPDATE public.report_schedules
         SET last_run_at = $1,
             next_run_at = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [now, nextRunAt(now, schedule.frequency), schedule.id]
      );
    }

    await client.query("COMMIT");
    return due.rows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function runReportExecutionStub(limit = 25) {
  const result = await pool.query<{ id: string }>(
    `WITH claimed AS (
       UPDATE public.report_runs
       SET status = 'running',
           started_at = NOW()
       WHERE id IN (
         SELECT id
         FROM public.report_runs
         WHERE status = 'queued'
         ORDER BY started_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, started_at
     )
     UPDATE public.report_runs AS runs
     SET status = 'not_implemented',
         finished_at = NOW(),
         runtime_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - claimed.started_at)) * 1000)::int),
         error = 'Report execution is not implemented yet'
     FROM claimed
     WHERE runs.id = claimed.id
     RETURNING runs.id`,
    [limit]
  );

  return result.rows.length;
}

export async function runReportsExecutionTick() {
  const scheduled = await enqueueDueReportSchedules();
  const completedAsStub = await runReportExecutionStub();
  if (scheduled > 0 || completedAsStub > 0) {
    console.log(
      `[Worker:reports-execution] Enqueued ${scheduled} scheduled report run(s); marked ${completedAsStub} queued run(s) not_implemented`
    );
  }
  return { scheduled, completedAsStub };
}
