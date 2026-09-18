import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSchemaCapabilityCache,
  resolveMineVisibilityFeatures,
} from "../../../src/modules/shared/mine-visibility.js";
import { tagTenantSchema } from "../../../src/modules/shared/tenant-schema.js";

/**
 * The schema-capability probes behind `scope=mine` (the DEFAULT deals-board scope, persisted per user)
 * are six catalog round trips: two `to_regclass` table checks and four `information_schema.columns`
 * lookups. They were memoised on a `WeakMap` keyed by the tenant Drizzle instance — and
 * `tenantMiddleware` builds a NEW instance for every request, so the cache could never hit under the
 * API. Every board load paid all six before it could even build the Mine predicate.
 *
 * These tests pin the fix at the level that matters: the SAME OFFICE across DIFFERENT request instances
 * must not re-probe, a DIFFERENT office must, and a FAILED probe must never be remembered (a
 * process-wide cache that memoised a rejection would answer "capability missing" — silently NARROWING a
 * Mine-scoped board — for the whole TTL).
 */

function createProbeSpy(overrides: { failFirst?: boolean } = {}) {
  let calls = 0;
  const execute = vi.fn(async () => {
    calls += 1;
    if (overrides.failFirst && calls === 1) throw new Error("probe blew up");
    return { rows: [{ relation_name: "something", column_exists: true }] };
  });
  return { execute, callCount: () => execute.mock.calls.length };
}

/** One "request": a distinct object, exactly like a fresh `drizzle(client)` per request. */
function createRequestDb(schemaName: string | null, execute: ReturnType<typeof vi.fn>) {
  const db = { execute };
  if (schemaName) tagTenantSchema(db, schemaName);
  return db;
}

const ALL_FEATURES_PRESENT = {
  dealSubscriptions: true,
  leadSubscriptions: true,
  dealSubscriptionsDeletedAt: true,
  leadSubscriptionsDeletedAt: true,
  dealsCreatedByUserId: true,
  leadsCreatedByUserId: true,
};

describe("resolveMineVisibilityFeatures — schema capability cache", () => {
  beforeEach(() => {
    resetSchemaCapabilityCache();
  });

  it("probes the catalog ONCE per office, not once per request", async () => {
    const probe = createProbeSpy();

    const first = await resolveMineVisibilityFeatures(
      createRequestDb("office_dallas", probe.execute)
    );
    const probesAfterFirstRequest = probe.callCount();

    // A SECOND request: a brand-new Drizzle instance for the same office, exactly what the middleware
    // hands the board on the next page load.
    const second = await resolveMineVisibilityFeatures(
      createRequestDb("office_dallas", probe.execute)
    );

    expect(first).toEqual(ALL_FEATURES_PRESENT);
    expect(second).toEqual(first);
    expect(probesAfterFirstRequest).toBe(6);
    // The whole point: the second request adds ZERO catalog round trips.
    expect(probe.callCount()).toBe(6);
  });

  it("keeps offices separate — a different schema is probed on its own", async () => {
    const probe = createProbeSpy();

    await resolveMineVisibilityFeatures(createRequestDb("office_dallas", probe.execute));
    expect(probe.callCount()).toBe(6);

    await resolveMineVisibilityFeatures(createRequestDb("office_atlanta", probe.execute));
    expect(probe.callCount()).toBe(12);

    // ...and both stay cached afterwards.
    await resolveMineVisibilityFeatures(createRequestDb("office_dallas", probe.execute));
    await resolveMineVisibilityFeatures(createRequestDb("office_atlanta", probe.execute));
    expect(probe.callCount()).toBe(12);
  });

  it("does NOT remember a failed probe (a cached rejection would silently narrow Mine)", async () => {
    const probe = createProbeSpy({ failFirst: true });

    await expect(
      resolveMineVisibilityFeatures(createRequestDb("office_dallas", probe.execute))
    ).rejects.toThrow("probe blew up");

    const afterFailure = probe.callCount();
    const retried = await resolveMineVisibilityFeatures(
      createRequestDb("office_dallas", probe.execute)
    );

    expect(retried).toEqual(ALL_FEATURES_PRESENT);
    // The failed capability was re-probed rather than served from cache.
    expect(probe.callCount()).toBeGreaterThan(afterFailure);
  });

  it("falls back to per-instance caching for an UNTAGGED db (worker / unit-test callers)", async () => {
    const probe = createProbeSpy();

    const untagged = createRequestDb(null, probe.execute);
    await resolveMineVisibilityFeatures(untagged);
    expect(probe.callCount()).toBe(6);

    // Same instance → still cached, exactly as before this change.
    await resolveMineVisibilityFeatures(untagged);
    expect(probe.callCount()).toBe(6);

    // A DIFFERENT untagged instance has no office to key on, so it must probe again rather than
    // inherit some other connection's answers.
    await resolveMineVisibilityFeatures(createRequestDb(null, probe.execute));
    expect(probe.callCount()).toBe(12);
  });
});
