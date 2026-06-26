import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { pool } from "../../db.js";
import { isKnownOfficeSchema, type OfficeSchema } from "../auth/officeSchemas.js";

export type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Runs a READ-ONLY callback against a single tenant schema, selected by name from the allowlist.
 *
 * SECURITY: `office` comes only from the validated session token (req.mcpContext). It is asserted
 * against the allowlist here (defense-in-depth) and then SELECTED via a parameterized
 * `set_config('search_path', $1, true)` — it is NEVER interpolated into SQL. The transaction is
 * marked `read_only`, so even a buggy tool cannot mutate tenant data. A short statement timeout
 * bounds runaway queries.
 */
export async function withOfficeSchema<T>(
  office: OfficeSchema,
  fn: (db: TenantDb) => Promise<T>
): Promise<T> {
  if (!isKnownOfficeSchema(office)) {
    throw new Error(`Refusing tenant query for unknown office schema: ${JSON.stringify(office)}`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL transaction_read_only = on");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SELECT set_config('search_path', $1, true)", [`${office},public`]);

    const tenantDb = drizzle(client, { schema });
    const result = await fn(tenantDb);

    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
