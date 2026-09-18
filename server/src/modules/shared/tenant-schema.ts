/**
 * The office schema a tenant-scoped Drizzle instance is bound to, published by the tenant middleware.
 *
 * WHY THIS EXISTS. `tenantMiddleware` builds a BRAND NEW `drizzle(client)` for every request (it has to —
 * the instance is bound to that request's pooled client and its transaction). Anything that memoises
 * per-instance, e.g. a `WeakMap<tenantDb, …>`, therefore has a hit rate of exactly zero in production: a
 * fresh key every request means a fresh miss every request. `mine-visibility`'s schema-capability probes
 * were doing precisely that — six `information_schema` / `to_regclass` round trips per Mine-scoped board
 * load, on a cache that could never hit.
 *
 * The value that actually identifies the cache scope is the office SCHEMA NAME, which the middleware
 * already resolved. Tagging it onto the instance lets a consumer key a process-wide cache on it without
 * threading a new parameter through every call site (and without a `SELECT current_schema()` of its own).
 *
 * The tag is a symbol on the object, not a declared field, so nothing about the Drizzle type surface
 * changes and a consumer that does not know about it is unaffected. A db object with NO tag (unit tests,
 * the worker, any direct `drizzle(pool)`) reads back `undefined` — consumers must keep a correct
 * un-tagged fallback rather than assume the tag is present.
 */
const TENANT_SCHEMA_TAG = Symbol.for("trock-crm.tenantSchemaName");

type TaggableDb = object & { [TENANT_SCHEMA_TAG]?: string };

/** Publish the office schema (`office_<slug>`) a tenant Drizzle instance is bound to. */
export function tagTenantSchema(tenantDb: object | null | undefined, schemaName: string): void {
  if (tenantDb == null || typeof tenantDb !== "object") return;
  Object.defineProperty(tenantDb, TENANT_SCHEMA_TAG, {
    value: schemaName,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/** The office schema this db is bound to, or undefined when it was never tagged. */
export function readTenantSchemaTag(tenantDb: unknown): string | undefined {
  if (tenantDb == null || typeof tenantDb !== "object") return undefined;
  const tagged = (tenantDb as TaggableDb)[TENANT_SCHEMA_TAG];
  return typeof tagged === "string" && tagged.length > 0 ? tagged : undefined;
}
