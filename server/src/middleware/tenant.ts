import type { Request, Response, NextFunction } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { AppError } from "./error-handler.js";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";

// Extend Express Request with tenant DB and transaction helpers
declare global {
  namespace Express {
    interface Request {
      tenantDb?: ReturnType<typeof drizzle>;
      officeSlug?: string;
      tenantClient?: PoolClient;
      commitTransaction: () => Promise<void>;
    }
  }
}

export async function tenantMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new AppError(401, "Authentication required for tenant resolution"));
  }

  const client = await pool.connect();
  let committed = false;

  try {
    // Look up office slug
    const officeResult = await client.query(
      "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
      [req.user.activeOfficeId]
    );

    if (officeResult.rows.length === 0) {
      client.release();
      return next(new AppError(404, "Office not found or inactive"));
    }

    const officeSlug = officeResult.rows[0].slug;
    const schemaName = `office_${officeSlug}`;

    // Validate schema exists
    const schemaCheck = await client.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1",
      [schemaName]
    );

    if (schemaCheck.rows.length === 0) {
      client.release();
      return next(new AppError(500, `Office schema ${schemaName} does not exist`));
    }

    // Begin transaction
    await client.query("BEGIN");

    // Set search_path and audit user via parameterized set_config (Issue #10 fix)
    await client.query("SELECT set_config('search_path', $1, true)", [`${schemaName},public`]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [req.user.id]);

    // Create a Drizzle instance bound to this client
    req.tenantDb = drizzle(client, { schema });
    req.officeSlug = officeSlug;
    req.tenantClient = client;

    // Commit helper — route handlers call this before sending a response
    req.commitTransaction = async () => {
      if (!committed) {
        committed = true;
        await client.query("COMMIT");
        client.release();
      }
    };

    // Cleanup on connection close or error — rollback if commit never happened
    const cleanup = async () => {
      if (!committed) {
        committed = true;
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    };
    res.on("close", cleanup);
    res.on("error", cleanup);

    next();
  } catch (err) {
    if (!committed) {
      committed = true;
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    next(err);
  }
}
