import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@trock-crm/shared/schema";

const DEFAULT_POOL_MAX = 20;
// Validate DB_POOL_MAX: a missing / malformed / non-positive value falls back to the default so an invalid
// env can't set pg.Pool.max (and the saturation-gauge threshold) to a bad value. Number() (not parseInt)
// rejects partial-numeric strings — "10foo" → NaN, "1.5" → non-integer — instead of silently accepting 10/1.
const parsedPoolMax = Number(process.env.DB_POOL_MAX);
const POOL_MAX = Number.isInteger(parsedPoolMax) && parsedPoolMax > 0 ? parsedPoolMax : DEFAULT_POOL_MAX;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: POOL_MAX,
  idleTimeoutMillis: 30000,
  // Bounds ACQUIRING a connection only — not a query on one already checked out.
  connectionTimeoutMillis: 5000,
  // Detect dead peers. Railway's private network (postgres.railway.internal) can silently drop a
  // long-lived socket; without TCP keepalive the OS won't notice, and the next query on that connection
  // blocks on a socket read with no error — pinning the pooled client until the process restarts.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  // Client-side per-query ceiling (a node-pg timer). Crucially this fires even when the socket is DEAD —
  // unlike a server-side statement_timeout, which a gone backend can never enforce — so a hung query
  // rejects and node-pg discards that connection (see releasePooledClient) instead of leaking a pool slot
  // forever. Set ABOVE the tenant transaction's 30s statement_timeout so it only ever backstops a
  // stuck/dead query, never a legitimately slow one (which the server-side 30s cap already bounds).
  //
  // CAVEAT: this timer starts at client.query() call time, INCLUDING time spent queued behind earlier
  // queries on the SAME pooled client (a tenant request binds Drizzle to one client, which runs queries
  // serially). A `Promise.all` of many queries on one client can therefore make a late-queued query time
  // out on cumulative WAIT, not its own execution. The headroom below (45s > 30s statement cap) absorbs a
  // couple of stacked slow queries; the heaviest report fan-outs (monday-showcase, analytics-tier4) are
  // run SEQUENTIALLY so each query's timer measures only its own execution. Avoid `Promise.all` of many
  // queries on a single tenant client.
  query_timeout: 45000,
  // Server-side ceiling for connections/queries that DON'T pass through the tenant middleware's
  // `SET LOCAL statement_timeout` (auth, office lookups, LISTEN/NOTIFY setup, direct pool.query).
  statement_timeout: 30000,
});

// Log pool exhaustion warnings when a new connection is established under contention.
pool.on("connect", () => {
  const { totalCount, idleCount, waitingCount } = pool;
  if (waitingCount > 0) {
    console.warn(
      `[DB Pool] Connections waiting: ${waitingCount} (total: ${totalCount}, idle: ${idleCount})`
    );
  }
});

pool.on("error", (err) => {
  console.error("Unexpected pool error:", err);
});

// Continuous saturation gauge. The on("connect") hook only fires when a NEW connection is made, so it
// misses SUSTAINED saturation (pool pinned at max with waiters and no new connects) — exactly the state a
// leak or a burst of slow requests produces. Sample periodically and log only under pressure so a stuck
// pool is visible in the logs instead of inferred. Unref'd so it never keeps the process alive; skipped
// under test so importing this module doesn't leave a live timer.
if (process.env.NODE_ENV !== "test") {
  const gauge = setInterval(() => {
    const { totalCount, idleCount, waitingCount } = pool;
    if (waitingCount > 0 || (idleCount === 0 && totalCount >= POOL_MAX)) {
      console.warn(
        `[DB Pool] Saturated: waiting=${waitingCount} total=${totalCount} idle=${idleCount} max=${POOL_MAX}`
      );
    }
  }, 15000);
  gauge.unref();
}

/**
 * True when an error means the CONNECTION itself is broken (dead socket, admin shutdown, or a client-side
 * `query_timeout` firing on a stuck/dead socket) — as opposed to a normal query error (constraint
 * violation, etc.) where the connection is healthy and safe to reuse.
 */
export function isBrokenConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: unknown; code?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  // Match only messages specific to CONNECTION loss. Deliberately NOT a bare "timeout" — a statement_timeout
  // ("canceling statement due to statement timeout") or lock timeout leaves the connection healthy and
  // reusable; only node-pg's client-side "Query read timeout" (ambiguous socket state) counts as broken.
  // "not queryable" / "Client has encountered a connection error" is what node-pg throws for a follow-up
  // query (ROLLBACK/reset) on a client that ALREADY hit a connection error — cleanup paths that prefer the
  // rollback error over the original must recognize it, or they'd recycle an unusable client.
  if (/Query read timeout|Connection terminated|terminating connection|server closed the connection|not queryable|Client has encountered a connection error/i.test(message)) {
    return true;
  }
  const code = typeof e.code === "string" ? e.code : "";
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "57P01" || // admin_shutdown
    code === "57P02" || // crash_shutdown
    code === "08000" || // connection_exception
    code === "08003" || // connection_does_not_exist
    code === "08006" //   connection_failure
  );
}

/**
 * Release a checked-out pool client. On a BROKEN-connection error, release WITH the error so node-pg
 * destroys the client (discards the socket) instead of recycling a poisoned/half-open connection to the
 * idle pool. This is essential now that pool-level `query_timeout` can reject a query on a dead socket
 * WITHOUT node-pg auto-removing the client (unlike `pool.query()`); a plain `release()` would hand the
 * next request the same dead connection. A normal query error releases the client cleanly for reuse.
 */
export function releasePooledClient(client: pg.PoolClient, err?: unknown): void {
  if (err !== undefined && err !== null && isBrokenConnectionError(err)) {
    client.release(err instanceof Error ? err : new Error(String(err)));
  } else {
    client.release();
  }
}

export const db = drizzle(pool, { schema });
export { pool };
