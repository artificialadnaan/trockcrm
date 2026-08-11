/**
 * The worker's ONE implementation of "run a statement with a clock on it, and if the clock wins, throw the
 * connection away instead of the wait".
 *
 * The distinction it exists to enforce: `Promise.race([pool.query(sql), timer])` bounds the CALLER and
 * nothing else. pg has already checked a connection out for that statement and will hold it until the
 * statement settles — so on the failure this is written for (a query blocked on a lock, or a socket that
 * accepted the request and went quiet) the slot is held exactly as long as it would have been without the
 * race. The timeout changes who is waiting, not what is held, and on a periodic caller the stranded slots
 * accumulate one per tick until the pool (max 10, db.ts) is gone and every unrelated job stops with it.
 *
 * So: check the client out EXPLICITLY, race that client's query, and on a timeout call `release(err)` —
 * pg reads a truthy release argument as "discard this connection", which both frees the slot for a fresh
 * connection and makes sure the next caller never inherits a socket with an orphaned statement on it. A
 * clean result (or an ordinary query error, which means the connection answered) releases normally.
 *
 * Note what this does NOT do: cancel the query. Nothing on a pg client can, short of a second connection
 * issuing pg_cancel_backend. Postgres keeps chewing on the abandoned statement until it finishes or the
 * backend notices the closed socket — this bounds the RESOURCE, which is the one that is scarce.
 *
 * Three callers grew their own copy of this before it was extracted (queue.ts's outcome/lease/sweep writes,
 * bid-board-ingest.ts's inbox queries, and the glasses dead-letter sweep's enrichment read). They differ
 * only in their timeout value and the error they want to throw, which is why both are parameters.
 */

/** Structural minimum of a checked-out pg client. `release` takes `any` deliberately: pg's own signature is
 *  `(err?: Error | boolean)`, and a narrower parameter type here would make pg.PoolClient non-assignable. */
export type TimedPoolClient = {
  query: (sql: string, params?: any[]) => Promise<any>;
  release: (err?: any) => void;
};

export type TimedPoolLike = {
  connect: () => Promise<TimedPoolClient>;
};

export async function timedPoolClientQuery<T = { rows: any[] }>(
  pool: TimedPoolLike,
  sql: string,
  params: any[] | undefined,
  options: { timeoutMs: number; timeoutError: () => Error }
): Promise<T> {
  let client: TimedPoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    // An exhausted pool REJECTS the acquire (connectionTimeoutMillis, db.ts) rather than queueing forever,
    // so this arrives bounded. Surface it as an ordinary failure — there is no connection to destroy.
    throw err instanceof Error ? err : new Error(String(err));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(options.timeoutError());
    }, options.timeoutMs);
  });
  try {
    return (await Promise.race([client.query(sql, params), deadline])) as T;
  } finally {
    clearTimeout(timer);
    // `timedOut`, not "did we throw": an ordinary SQL error came back OVER this connection, which proves it
    // is alive and reusable. Only the deadline means the connection's state is unknown.
    client.release(timedOut ? options.timeoutError() : undefined);
  }
}
