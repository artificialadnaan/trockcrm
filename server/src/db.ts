import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@trock-crm/shared/schema";

const POOL_MAX = parseInt(process.env.DB_POOL_MAX || "20", 10);

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
  // rejects and node-pg discards that connection instead of leaking a pool slot forever. Set ABOVE the
  // tenant transaction's 30s statement_timeout so it only ever backstops a stuck/dead query, never a
  // legitimately slow one (which the server-side 30s cap already bounds).
  query_timeout: 35000,
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

export const db = drizzle(pool, { schema });
export { pool };
