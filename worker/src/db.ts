import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  // Fail a connection acquisition after 10s instead of blocking forever. A momentarily-exhausted pool
  // (e.g. a burst of jobs each opening nested connections) then surfaces as a retryable job error rather
  // than hanging a handler — and, with it, pollJobs — indefinitely.
  connectionTimeoutMillis: 10000,
  // TCP keepalive so a SILENTLY-dead socket (no FIN/RST — a dropped NAT mapping, a killed upstream) is detected
  // and errored instead of leaving a query hung forever. Without it the pollers' claim/outcome queries could
  // wait indefinitely on a dead connection; the queue layer also applies its own client-side query timeout, but
  // keepalive lets the pool actually EVICT the dead connection rather than leak it. First probe after 10s.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

export const db = drizzle(pool, { schema });
export { pool };
