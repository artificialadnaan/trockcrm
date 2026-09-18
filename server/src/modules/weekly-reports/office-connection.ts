import type { PoolClient } from "pg";
import { pool, releasePooledClient, isBrokenConnectionError } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import type { QueryExecutor } from "./projects-service.js";

// A tenant-scoped connection for the two weekly-report paths that arrive with NO request transaction.
//
//   • The public `/wr/:token` viewer, which has no session at all — its office comes from the token row,
//     which is the entire reason public.weekly_report_tokens is not per-office.
//   • The PDF publisher, which must NOT hold a pooled connection across the render and the R2 upload. Those
//     are seconds of network and CPU; holding a connection through them is how the API pool saturates and
//     every deal list starts answering "Couldn't load deals".
//
// Mirrors tenantMiddleware's envelope (BEGIN, statement_timeout, LOCAL search_path, COMMIT/ROLLBACK) so a
// query behaves identically whether it ran here or on a request client. `app.current_user_id` is set only
// when there IS an actor — the audit triggers read it, and inventing a user id for an anonymous public read
// would attribute the read to somebody.

/** Postgres identifiers are interpolated into search_path, so the slug is validated, never trusted. */
const OFFICE_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * The schema name is built by string concatenation (`office_${slug}`), which is the one place in this
 * feature where a value becomes SQL structure rather than a bound parameter. The slug reaching here came
 * off a token row written from an authenticated session, so it should already be safe — this is the check
 * that means "should" does not have to be trusted. Exported so the guard itself has a test.
 */
export function isWeeklyReportOfficeSlug(slug: unknown): slug is string {
  return typeof slug === "string" && OFFICE_SLUG_PATTERN.test(slug);
}

export async function withWeeklyReportOfficeClient<T>(
  officeSlug: string,
  options: { userId?: string | null; statementTimeout?: string } = {},
  run: (client: QueryExecutor) => Promise<T>,
): Promise<T> {
  if (!isWeeklyReportOfficeSlug(officeSlug)) {
    throw new AppError(500, "Invalid office schema");
  }
  const client: PoolClient = await pool.connect();
  let brokenErr: unknown;
  try {
    await client.query("BEGIN");
    // set_config rather than `SET LOCAL <literal>`: both settings are parameterised, so neither the slug
    // nor the timeout is ever concatenated into SQL.
    await client.query("SELECT set_config('statement_timeout', $1, true)", [options.statementTimeout ?? "30s"]);
    await client.query("SELECT set_config('search_path', $1, true)", [`office_${officeSlug},public`]);
    if (options.userId) {
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [options.userId]);
    }
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    brokenErr = err;
    // A dead socket cannot ROLLBACK — attempting it only burns another statement_timeout before the client
    // is destroyed below.
    if (!isBrokenConnectionError(err)) {
      await client.query("ROLLBACK").catch((rollbackErr) => {
        brokenErr = rollbackErr;
      });
    }
    throw err;
  } finally {
    releasePooledClient(client, brokenErr);
  }
}
