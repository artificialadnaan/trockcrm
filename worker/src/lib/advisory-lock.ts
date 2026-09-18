import { pool } from "../db.js";

/**
 * A Postgres SESSION advisory lock, taken over a dedicated pooled client.
 *
 * The single-flight guard for a cron job. Global across worker replicas, so a second replica's tick skips
 * rather than racing this one — which for an email job is the difference between one notification and two.
 *
 * It has to be a dedicated client because a session lock must be acquired and released on the SAME
 * connection, and `pool.query` hands out an arbitrary one. That is also why the connection stays checked
 * out for the whole run: the lock dies with it.
 *
 * Extracted from `weekly-report-reminders.ts`, which owned the only copy, when the weekly-report send sweep
 * needed the same primitive under a DIFFERENT key. Sharing a key would have been worse than duplicating
 * the code: the sweep and the reminder cron would block each other, and the 07:00 tick that happened to
 * overlap a sweep would silently send nothing.
 */

/** The slice of a pg Pool this needs. Narrowed so a test can supply one without a database. */
export interface AdvisoryLockPool {
  connect(): Promise<{
    query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
    release(err?: Error): void;
  }>;
}

/**
 * @returns a release function if this call took the lock, or null if another holder has it.
 *
 * `poolLike` is a parameter purely so this can be exercised without a live Postgres — every job injects a
 * lock stub in its suite, so nothing else executes a line of it.
 */
export async function acquirePgAdvisoryLock(
  lockKey: number,
  poolLike: AdvisoryLockPool = pool,
): Promise<null | (() => Promise<void>)> {
  const client = await poolLike.connect();
  try {
    const res = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [lockKey]);
    if (res.rows[0]?.locked !== true) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey]);
      client.release();
    } catch (err) {
      // The unlock failed, so this session may still hold the lock — destroy the connection rather than
      // return a possibly-locked one to the pool. Postgres frees session advisory locks on disconnect.
      client.release(err as Error);
      throw err;
    }
  };
}
