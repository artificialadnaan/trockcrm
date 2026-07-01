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
});

export const db = drizzle(pool, { schema });
export { pool };
