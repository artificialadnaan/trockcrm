import type { Request, Response, NextFunction } from "express";
import type { PoolClient } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { pool, releasePooledClient, isBrokenConnectionError } from "../db.js";
import { AppError } from "./error-handler.js";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";

// Extend Express Request with tenant DB and transaction helpers
declare global {
  namespace Express {
    interface Request {
      tenantDb?: NodePgDatabase<typeof schema>;
      officeSlug?: string;
      tenantClient?: PoolClient;
      commitTransaction: () => Promise<void>;
      // Set by the error handler to the failing request's error, so the res-close cleanup can skip ROLLBACK
      // on an already-broken tenant connection (a ROLLBACK on a query-timed-out socket would wait again).
      tenantOpError?: unknown;
    }
  }
}

// ── In-memory cache for office slugs and validated schemas ──────────────
// Eliminates 2 DB queries per request for data that rarely changes.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> { value: T; expiresAt: number; }
const officeSlugCache = new Map<string, CacheEntry<string>>();
const schemaExistsCache = new Map<string, CacheEntry<boolean>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return undefined; }
  return entry.value;
}

function setCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Call when an office is created/updated/deactivated to bust the cache. */
export function invalidateOfficeCache(officeId?: string): void {
  if (officeId) {
    officeSlugCache.delete(officeId);
  } else {
    officeSlugCache.clear();
    schemaExistsCache.clear();
  }
}
// ────────────────────────────────────────────────────────────────────────

export async function tenantMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new AppError(401, "Authentication required for tenant resolution"));
  }

  // Resolve office slug (cached)
  const activeOfficeId = req.user.activeOfficeId;
  let officeSlug = getCached(officeSlugCache, activeOfficeId);

  const client = await pool.connect();
  let committed = false;

  try {
    if (!officeSlug) {
      const officeResult = await client.query(
        "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
        [activeOfficeId]
      );
      if (officeResult.rows.length === 0) {
        client.release();
        return next(new AppError(404, "Office not found or inactive"));
      }
      officeSlug = officeResult.rows[0].slug;
      setCache(officeSlugCache, activeOfficeId, officeSlug);
    }

    const schemaName = `office_${officeSlug}`;

    // Validate schema exists (cached)
    if (!getCached(schemaExistsCache, schemaName)) {
      const schemaCheck = await client.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1",
        [schemaName]
      );
      if (schemaCheck.rows.length === 0) {
        client.release();
        return next(new AppError(500, `Office schema ${schemaName} does not exist`));
      }
      setCache(schemaExistsCache, schemaName, true);
    }

    // Begin transaction
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '30s'");

    // Set search_path and audit user via parameterized set_config (Issue #10 fix)
    await client.query("SELECT set_config('search_path', $1, true)", [`${schemaName},public`]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [req.user.id]);

    // Create a Drizzle instance bound to this client
    req.tenantDb = drizzle(client, { schema });
    req.officeSlug = officeSlug;
    req.tenantClient = client;

    // Commit helper — route handlers call this before sending a response
    req.commitTransaction = async () => {
      if (committed) return;
      committed = true;
      try {
        await client.query("COMMIT");
        client.release();
      } catch (err) {
        // COMMIT on a dead/timed-out socket: destroy the client so it isn't recycled, then surface.
        releasePooledClient(client, err);
        throw err;
      }
    };

    // Cleanup on connection close or error — rollback if commit never happened
    const cleanup = async () => {
      if (committed) return;
      committed = true;
      // If the request already failed with a broken-connection error (carried here by the error handler),
      // skip ROLLBACK — it would issue another query on a dead/timed-out socket and wait again before we
      // finally destroy it. Destroy immediately with the original error.
      if (isBrokenConnectionError(req.tenantOpError)) {
        releasePooledClient(client, req.tenantOpError);
        return;
      }
      let rollbackErr: unknown;
      await client.query("ROLLBACK").catch((e) => {
        rollbackErr = e; // a failed rollback means the connection is unusable → destroy on release
      });
      releasePooledClient(client, rollbackErr);
    };
    res.on("close", cleanup);
    res.on("error", cleanup);

    next();
  } catch (err) {
    if (!committed) {
      committed = true;
      if (isBrokenConnectionError(err)) {
        // The connection is already dead (e.g. a setup query hit the client-side query_timeout on a dead
        // socket). Skip ROLLBACK — it would burn another full query_timeout keeping this bad pool slot
        // checked out during a saturation incident — and destroy the client immediately.
        releasePooledClient(client, err);
      } else {
        let rollbackErr: unknown;
        await client.query("ROLLBACK").catch((e) => {
          rollbackErr = e;
        });
        // Destroy the client if the request error OR the failed rollback indicates a broken connection.
        releasePooledClient(client, rollbackErr ?? err);
      }
    }
    next(err);
  }
}
