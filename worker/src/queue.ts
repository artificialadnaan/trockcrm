import { pool } from "./db.js";

type JobHandler = (payload: any, officeId: string | null) => Promise<void>;

const jobHandlers = new Map<string, JobHandler>();

export function registerJobHandler(jobType: string, handler: JobHandler) {
  jobHandlers.set(jobType, handler);
}

export async function pollJobs() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Grab the next pending job (FOR UPDATE SKIP LOCKED prevents double-processing)
    const result = await client.query(
      `SELECT * FROM public.job_queue
       WHERE status = 'pending' AND run_after <= NOW()
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );

    if (result.rows.length === 0) {
      await client.query("COMMIT");
      return;
    }

    const job = result.rows[0];
    const handler = jobHandlers.get(job.job_type);

    if (!handler) {
      console.warn(`[Worker] No handler for job type: ${job.job_type}`);
      await client.query(
        "UPDATE public.job_queue SET status = 'dead', last_error = $1 WHERE id = $2",
        [`No handler registered for job type: ${job.job_type}`, job.id]
      );
      await client.query("COMMIT");
      return;
    }

    // Mark as processing with timestamp
    await client.query(
      "UPDATE public.job_queue SET status = 'processing', attempts = attempts + 1, started_processing_at = NOW() WHERE id = $1",
      [job.id]
    );
    await client.query("COMMIT");

    // Execute handler
    try {
      await handler(job.payload, job.office_id);
      await pool.query(
        "UPDATE public.job_queue SET status = 'completed', completed_at = NOW() WHERE id = $1",
        [job.id]
      );
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      const newAttempts = job.attempts + 1;

      if (newAttempts >= job.max_attempts) {
        await pool.query(
          "UPDATE public.job_queue SET status = 'dead', last_error = $1 WHERE id = $2",
          [errorMsg, job.id]
        );
        console.error(`[Worker] Job ${job.id} (${job.job_type}) dead after ${newAttempts} attempts: ${errorMsg}`);
      } else {
        // Exponential backoff: 3^1=3s, 3^2=9s, 3^3=27s
        const backoffSeconds = Math.pow(3, newAttempts);
        await pool.query(
          "UPDATE public.job_queue SET status = 'pending', last_error = $1, run_after = NOW() + make_interval(secs => $2) WHERE id = $3",
          [errorMsg, backoffSeconds, job.id]
        );
        console.warn(`[Worker] Job ${job.id} (${job.job_type}) failed, retrying in ${backoffSeconds}s: ${errorMsg}`);
      }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[Worker] Poll error:", err);
  } finally {
    client.release();
  }
}

/**
 * Reset stale "processing" jobs back to pending.
 * Uses started_processing_at (not created_at) to detect truly stuck jobs.
 * Called on worker startup to recover from crashes.
 */
export async function recoverStaleJobs() {
  const result = await pool.query(
    `UPDATE public.job_queue
     SET status = 'pending', last_error = 'Recovered from stale processing state'
     WHERE status = 'processing'
       AND started_processing_at < NOW() - interval '5 minutes'
     RETURNING id, job_type`
  );
  if (result.rows.length > 0) {
    console.log(`[Worker] Recovered ${result.rows.length} stale jobs:`,
      result.rows.map((r: any) => `${r.id}:${r.job_type}`).join(", ")
    );
  }
}
