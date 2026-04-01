import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@trock-crm/shared/schema";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected pool error:", err);
});

export const db = drizzle(pool, { schema });
export { pool };
