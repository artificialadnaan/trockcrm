import { pool } from "../db.js";

type ReportFrequency = "daily" | "weekly" | "biweekly" | "monthly" | "quarterly";

function normalizeAnchorDay(anchorDay: number | string | null | undefined, fallbackDate: Date) {
  const numericAnchorDay = Number(anchorDay);
  if (Number.isInteger(numericAnchorDay) && numericAnchorDay >= 1 && numericAnchorDay <= 31) {
    return numericAnchorDay;
  }
  return fallbackDate.getUTCDate();
}

function addMonths(date: Date, months: number, anchorDay = date.getUTCDate()) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const clampedDay = Math.min(anchorDay, lastDayOfTargetMonth);

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

export function nextRunAt(from: Date, frequency: ReportFrequency, anchorDay?: number | null) {
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
      return addMonths(next, 1, normalizeAnchorDay(anchorDay, from));
    case "quarterly":
      return addMonths(next, 3, normalizeAnchorDay(anchorDay, from));
  }
  return next;
}

export function advanceNextRunAt(
  previousNextRunAt: Date,
  frequency: ReportFrequency,
  now: Date,
  anchorDay?: number | string | null
) {
  const normalizedAnchorDay = normalizeAnchorDay(anchorDay, previousNextRunAt);
  let next = nextRunAt(previousNextRunAt, frequency, normalizedAnchorDay);
  while (next <= now) {
    next = nextRunAt(next, frequency, normalizedAnchorDay);
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
      next_run_at: Date | string;
      anchor_day: number | string | null;
    }>(
      `SELECT id, report_id, frequency, next_run_at, anchor_day
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
        [
          now,
          advanceNextRunAt(
            new Date(schedule.next_run_at),
            schedule.frequency,
            now,
            schedule.anchor_day
          ),
          schedule.id,
        ]
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
