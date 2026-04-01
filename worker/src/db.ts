import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

export const db = drizzle(pool, { schema });
export { pool };
