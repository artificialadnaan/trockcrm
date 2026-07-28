import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

type InsertValues = Record<string, unknown>;

/**
 * A target lookup that answers LIVE.
 *
 * createActivity now verifies the property and company it is about still exist and are active, so
 * every stub needs to answer that — and the default is the ordinary case. A test that wants the
 * soft-deleted path opts in by returning [].
 */
function liveTargetSelect(rows: unknown[] = [{ id: "target-1" }]) {
  return vi.fn(() => ({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  }));
}

function createInsertMock() {
  let insertedValues: InsertValues | null = null;

  const returning = vi.fn(async () => [
    {
      id: "activity-1",
      ...(insertedValues ?? {}),
    },
  ]);

  const values = vi.fn((payload: InsertValues) => {
    insertedValues = payload;
    return { returning };
  });

  const insert = vi.fn(() => ({ values }));

  return {
    insert,
    values,
    returning,
    getInsertedValues: () => insertedValues,
  };
}

vi.mock("../../../src/db.js", () => ({
  db: { select: vi.fn() },
  pool: {},
}));
vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));

const { AppError } = await import("../../../src/middleware/error-handler.js");
const { createActivity, getActivities } = await import("../../../src/modules/activities/service.js");

function flattenQueryChunks(input: unknown, seen = new WeakSet<object>()): unknown[] {
  if (!input || typeof input !== "object") return [input];
  if (seen.has(input as object)) return [];
  seen.add(input as object);

  const queryChunks = (input as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) {
    return queryChunks.flatMap((chunk) => flattenQueryChunks(chunk, seen));
  }

  if ("value" in (input as Record<string, unknown>)) {
    return [(input as Record<string, unknown>).value];
  }

  return Object.values(input as Record<string, unknown>).flatMap((value) => flattenQueryChunks(value, seen));
}

function createSelectChain(rows: unknown[], options?: { resolveOnWhere?: boolean; resolveOnLimit?: boolean; resolveOnOffset?: boolean }) {
  const builder: Record<string, any> = {};

  builder.from = vi.fn(() => builder);
  builder.where = vi.fn(() => {
    if (options?.resolveOnWhere) return Promise.resolve(rows);
    return builder;
  });
  builder.orderBy = vi.fn(() => builder);
  builder.limit = vi.fn(() => {
    if (options?.resolveOnLimit) return Promise.resolve(rows);
    return builder;
  });
  builder.offset = vi.fn(() => {
    if (options?.resolveOnOffset) return Promise.resolve(rows);
    return builder;
  });

  return builder;
}

function createSingleClientGuard() {
  let active = false;

  return {
    finish<T>(rows: T[]) {
      if (active) {
        throw new Error("concurrent tenantDb query");
      }
      active = true;
      return new Promise<T[]>((resolve) => {
        queueMicrotask(() => {
          active = false;
          resolve(rows);
        });
      });
    },
  };
}

describe("activities service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      label: "company",
      input: {
        sourceEntityType: "company",
        sourceEntityId: "company-1",
        companyId: "company-1",
      },
      expected: {
        sourceEntityType: "company",
        sourceEntityId: "company-1",
        companyId: "company-1",
      },
    },
    {
      label: "property",
      input: {
        sourceEntityType: "property",
        sourceEntityId: "property-1",
        companyId: "company-1",
        propertyId: "property-1",
      },
      expected: {
        sourceEntityType: "property",
        sourceEntityId: "property-1",
        companyId: "company-1",
        propertyId: "property-1",
      },
    },
    {
      label: "lead",
      input: {
        sourceEntityType: "lead",
        sourceEntityId: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        leadId: "lead-1",
      },
      expected: {
        sourceEntityType: "lead",
        sourceEntityId: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        leadId: "lead-1",
      },
    },
    {
      label: "deal",
      input: {
        sourceEntityType: "deal",
        sourceEntityId: "deal-1",
        companyId: "company-1",
        propertyId: "property-1",
        dealId: "deal-1",
      },
      expected: {
        sourceEntityType: "deal",
        sourceEntityId: "deal-1",
        companyId: "company-1",
        propertyId: "property-1",
        dealId: "deal-1",
      },
    },
  ])(
    "creates a $label activity with canonical source attribution and linked entities",
    async ({ input, expected }) => {
      const insertMock = createInsertMock();
      const updateWhere = vi.fn(async () => []);
      const updateSet = vi.fn(() => ({ where: updateWhere }));
      const update = vi.fn(() => ({ set: updateSet }));

      const tenantDb = {
        insert: insertMock.insert,
        update,
        select: liveTargetSelect(),
      } as any;

      const activity = await createActivity(tenantDb, {
        type: "note",
        responsibleUserId: "rep-1",
        performedByUserId: "actor-1",
        body: "Manual activity entry",
        ...input,
      });

      expect(insertMock.values).toHaveBeenCalledTimes(1);
      expect(insertMock.getInsertedValues()).toMatchObject({
        type: "note",
        responsibleUserId: "rep-1",
        performedByUserId: "actor-1",
        body: "Manual activity entry",
        ...expected,
      });
      expect(activity).toMatchObject({
        id: "activity-1",
        responsibleUserId: "rep-1",
        performedByUserId: "actor-1",
        ...expected,
      });
    }
  );

  it("requires responsibleUserId for every activity write", async () => {
    const insertMock = createInsertMock();

    const tenantDb = {
      insert: insertMock.insert,
      update: vi.fn(),
      select: liveTargetSelect(),
    } as any;

    await expect(
      createActivity(tenantDb, {
        type: "note",
        sourceEntityType: "deal",
        sourceEntityId: "deal-1",
      } as any)
    ).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: "responsibleUserId is required",
    });

    expect(insertMock.values).not.toHaveBeenCalled();
  });

  it("includes linked lead history when listing activities for a converted deal", async () => {
    const dealLookup = createSelectChain([{ sourceLeadId: "lead-1" }], { resolveOnLimit: true });
    const countQuery = createSelectChain([{ count: 2 }], { resolveOnWhere: true });
    const rowsQuery = createSelectChain(
      [
        { id: "activity-deal", dealId: "deal-1", leadId: null, sourceEntityType: "deal" },
        { id: "activity-lead", dealId: null, leadId: "lead-1", sourceEntityType: "lead" },
      ],
      { resolveOnOffset: true }
    );

    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce(dealLookup)
        .mockReturnValueOnce(countQuery)
        .mockReturnValueOnce(rowsQuery),
    } as any;

    const result = await getActivities(tenantDb, { dealId: "deal-1", limit: 100 });

    expect(tenantDb.select).toHaveBeenCalledTimes(3);
    expect(dealLookup.from).toHaveBeenCalled();
    expect(result.activities.map((activity: { id: string }) => activity.id)).toEqual([
      "activity-deal",
      "activity-lead",
    ]);
    expect(result.pagination.total).toBe(2);
  });

  it("returns performer metadata when listing lead activities", async () => {
    const countQuery = createSelectChain([{ count: 1 }], { resolveOnWhere: true });
    const rowsQuery = createSelectChain(
      [
        {
          id: "activity-stage",
          leadId: "lead-1",
          sourceEntityType: "lead",
          responsibleUserId: "rep-1",
          performedByUserId: "admin-1",
        },
      ],
      { resolveOnOffset: true }
    );
    const usersQuery = createSelectChain(
      [
        { id: "rep-1", displayName: "Sam Sales", avatarUrl: null },
        { id: "admin-1", displayName: "Morgan Admin", avatarUrl: "https://example.test/avatar.png" },
      ],
      { resolveOnWhere: true }
    );

    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce(countQuery)
        .mockReturnValueOnce(rowsQuery)
        .mockReturnValueOnce(usersQuery),
    } as any;

    const result = await getActivities(tenantDb, { leadId: "lead-1", responsibleUserId: "rep-1", limit: 100 });

    expect(result.activities[0]).toMatchObject({
      id: "activity-stage",
      responsibleUserName: "Sam Sales",
      performedByUserName: "Morgan Admin",
      performedByUserAvatarUrl: "https://example.test/avatar.png",
    });
    expect(tenantDb.select).toHaveBeenCalledTimes(3);
  });

  it("serializes list count and row queries on request-scoped tenantDb", async () => {
    const guard = createSingleClientGuard();
    const countQuery = createSelectChain([{ count: 1 }]);
    const rowsQuery = createSelectChain([{ id: "activity-1", responsibleUserId: null, performedByUserId: null }]);

    countQuery.where = vi.fn(() => guard.finish([{ count: 1 }]));
    rowsQuery.offset = vi.fn(() =>
      guard.finish([{ id: "activity-1", responsibleUserId: null, performedByUserId: null }])
    );

    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce(countQuery)
        .mockReturnValueOnce(rowsQuery),
    } as any;

    const result = await getActivities(tenantDb, { leadId: "lead-1", limit: 100 });

    expect(result.pagination.total).toBe(1);
    expect(result.activities).toHaveLength(1);
  });

  it("filters email activities to the current mailbox owner while leaving non-email activity visible", async () => {
    const whereClauses: unknown[] = [];
    const countQuery = createSelectChain([{ count: 0 }], { resolveOnWhere: true });
    const rowsQuery = createSelectChain([], { resolveOnOffset: true });

    countQuery.where = vi.fn((condition: unknown) => {
      whereClauses.push(condition);
      return Promise.resolve([{ count: 0 }]);
    });
    rowsQuery.where = vi.fn((condition: unknown) => {
      whereClauses.push(condition);
      return rowsQuery;
    });

    const tenantDb = {
      select: vi
        .fn()
        .mockReturnValueOnce(countQuery)
        .mockReturnValueOnce(rowsQuery),
    } as any;

    await getActivities(tenantDb, { contactId: "contact-1", viewerUserId: "rep-1", limit: 100 });

    const flattened = whereClauses.flatMap((condition) => flattenQueryChunks(condition));
    expect(flattened).toContain("contact-1");
    expect(flattened).toContain("rep-1");
    expect(flattened).toContain("email");
  });
});

describe("createActivity — who maintains the last touch", () => {
  /**
   * properties.last_activity_at and companies.last_activity_at are maintained by the
   * redesign_last_activity_refresh TRIGGER (migration 0090), which recomputes each as max(occurred_at)
   * over the activities table on insert, update and delete. An earlier version of this service wrote
   * them here too — redundant, and weaker than the trigger, since GREATEST only ratchets upward.
   * Deals have no such trigger, so the service owns that one.
   */
  function harness() {
    const insertMock = createInsertMock();
    const updates: string[] = [];
    const updateWhere = vi.fn(async () => []);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn((table: unknown) => {
      updates.push(getTableName(table as Parameters<typeof getTableName>[0]));
      return { set: updateSet };
    });
    return { insertMock, update, updates, updateSet, updateWhere, select: liveTargetSelect() };
  }

  it("refreshes the DEAL, which no trigger covers", async () => {
    const { insertMock, update, updates, updateSet, updateWhere } = harness();
    await createActivity({ insert: insertMock.insert, update, select: liveTargetSelect() } as any, {
      type: "note",
      responsibleUserId: "rep-1",
      performedByUserId: "rep-1",
      body: "Call",
      dealId: "deal-1",
      sourceEntityType: "deal",
      sourceEntityId: "deal-1",
    });
    expect(updates).toContain("deals");
    // Table name alone would survive a regression that dropped lastActivityAt, or dropped the WHERE and
    // updated EVERY deal. Assert what is written and that it is scoped.
    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(Object.keys(updateSet.mock.calls[0]?.[0] ?? {})).toEqual(["lastActivityAt"]);
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  it("does NOT duplicate the trigger's property/company writes", async () => {
    const { insertMock, update, updates } = harness();
    await createActivity({ insert: insertMock.insert, update, select: liveTargetSelect() } as any, {
      type: "note",
      responsibleUserId: "rep-1",
      performedByUserId: "rep-1",
      body: "Met the super",
      propertyId: "property-1",
      companyId: "company-1",
      sourceEntityType: "property",
      sourceEntityId: "property-1",
    });
    expect(updates).not.toContain("properties");
    expect(updates).not.toContain("companies");
    // And NO update at all — the trigger owns both, so any statement here is redundant work on rows a
    // busy office touches constantly.
    expect(updates).toEqual([]);
  });

describe("createActivity — the target must still be live", () => {
  /**
   * Every read filters on is_active, so an activity written against a soft-deleted property or company
   * is not merely misfiled — it is unreachable. The rep sees "Logged" and no surface will ever show it.
   */
  it("refuses a soft-deleted PROPERTY", async () => {
    const insertMock = createInsertMock();
    const tenantDb = {
      insert: insertMock.insert,
      update: vi.fn(),
      select: liveTargetSelect([]),
    } as any;

    await expect(
      createActivity(tenantDb, {
        type: "note",
        responsibleUserId: "rep-1",
        performedByUserId: "rep-1",
        body: "Visit",
        propertyId: "property-gone",
        sourceEntityType: "property",
        sourceEntityId: "property-gone",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    // And nothing was written.
    expect(insertMock.values).not.toHaveBeenCalled();
  });

  it("refuses a soft-deleted COMPANY", async () => {
    // Guarded alongside the property rather than after the next review round: the two are the same
    // shape, and half-applying the predicate is what turns one defect into two.
    const insertMock = createInsertMock();
    const tenantDb = {
      insert: insertMock.insert,
      update: vi.fn(),
      select: liveTargetSelect([]),
    } as any;

    await expect(
      createActivity(tenantDb, {
        type: "note",
        responsibleUserId: "rep-1",
        performedByUserId: "rep-1",
        body: "Call",
        companyId: "company-gone",
        sourceEntityType: "company",
        sourceEntityId: "company-gone",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(insertMock.values).not.toHaveBeenCalled();
  });

  it("ALLOWS a contact-sourced visit whose company was retired", async () => {
    /**
     * deleteCompany sets only companies.is_active = false and leaves linked contacts active, so the
     * picker still returns that person — and their companyId rides along on the activity. Guarding
     * every id rejected the save outright, so a valid, selectable contact could not receive a visit.
     * Reachability follows the SOURCE, and the source here is the contact.
     */
    const insertMock = createInsertMock();
    const tenantDb = {
      insert: insertMock.insert,
      update: vi.fn(),
      // Would answer "gone" if anything asked — nothing should, because the source is a contact.
      select: liveTargetSelect([]),
    } as any;

    await createActivity(tenantDb, {
      type: "note",
      responsibleUserId: "rep-1",
      performedByUserId: "rep-1",
      body: "Met Dana",
      contactId: "contact-1",
      companyId: "company-retired",
      sourceEntityType: "contact",
      sourceEntityId: "contact-1",
    });
    expect(insertMock.values).toHaveBeenCalledTimes(1);
  });

  it("writes normally against a live target", async () => {
    const insertMock = createInsertMock();
    const tenantDb = {
      insert: insertMock.insert,
      update: vi.fn(),
      select: liveTargetSelect(),
    } as any;

    await createActivity(tenantDb, {
      type: "note",
      responsibleUserId: "rep-1",
      performedByUserId: "rep-1",
      body: "Visit",
      propertyId: "property-1",
      sourceEntityType: "property",
      sourceEntityId: "property-1",
    });
    expect(insertMock.values).toHaveBeenCalledTimes(1);
  });
});
});
