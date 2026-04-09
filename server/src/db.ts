import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@trock-crm/shared/schema";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || "50", 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Log pool exhaustion warnings
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

export const db = drizzle(pool, { schema });
export { pool };
