import { beforeEach, describe, expect, it, vi } from "vitest";

type InsertValues = Record<string, unknown>;

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

const { AppError } = await import("../../../src/middleware/error-handler.js");
const { createActivity, getActivities } = await import("../../../src/modules/activities/service.js");

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
});
