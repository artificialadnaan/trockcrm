import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/assignment-tasks/service.js", () => ({
  createAssignmentTaskIfNeeded: vi.fn(),
}));
vi.mock("../../../src/modules/audit/audit-logger.js", () => ({
  logActivity: vi.fn(),
}));

const { createAssignmentTaskIfNeeded } = await import(
  "../../../src/modules/assignment-tasks/service.js"
);
const { logActivity } = await import("../../../src/modules/audit/audit-logger.js");
const { startProposalDraft, updateDeal } = await import("../../../src/modules/deals/service.js");

function officeNameForSlug(slug: string): string {
  if (slug === "atlanta") return "Atlanta";
  if (slug === "dfw") return "DFW Office";
  if (slug === "dallas") return "Dallas Office";
  return slug;
}

function createDealDb(options: {
  /** Deal's office_code. `null` exercises the no-officeCode fallback branch. */
  dealOfficeCode?: string | null;
  /** Target rep's PRIMARY office_id. */
  targetRepOfficeId?: string;
  /** Slug of the target rep's PRIMARY office (looked up by the officeCode branch). */
  targetOfficeSlug?: string;
  /**
   * Slugs of the offices the target rep holds an EXPLICIT additional-office grant
   * to (`user_office_access` rows). Drives the officeCode-branch grant lookup.
   * Only set this on cross-office tests (primary office mismatches the deal).
   */
  targetRepAccessOfficeSlugs?: string[];
  /** Office_id of the deal's current owner (used by the no-officeCode fallback branch). */
  currentOwnerOfficeId?: string;
  /**
   * Whether the target rep holds a `user_office_access` grant to the current
   * owner's office. Drives the fallback-branch grant lookup. Only set this on
   * cross-office tests using `dealOfficeCode: null`.
   */
  targetRepHasGrantToCurrentOwnerOffice?: boolean;
} = {}) {
  const insertedValues: unknown[] = [];
  const dealOfficeCode = options.dealOfficeCode === undefined ? "dfw" : options.dealOfficeCode;
  const hasDealOfficeCode = dealOfficeCode != null && dealOfficeCode !== "";
  const currentOwnerOfficeId = options.currentOwnerOfficeId ?? "office-1";

  const queue: unknown[] = [
    [
      {
        id: "deal-1",
        name: "Hill Place Interior Upgrade",
        assignedRepId: "rep-old",
        sourceLeadId: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        primaryContactId: null,
        stageId: "stage-estimating",
        workflowRoute: "estimating",
        officeCode: dealOfficeCode,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
    ],
    [{ id: "rep-new", isActive: true, officeId: options.targetRepOfficeId ?? "office-1" }],
  ];

  if (hasDealOfficeCode) {
    // officeCode branch: look up the target rep's PRIMARY office...
    const slug = options.targetOfficeSlug ?? "dallas";
    queue.push([{ slug, name: officeNameForSlug(slug) }]);
    // ...then, on a primary-office mismatch, the additional-office grant lookup.
    if (options.targetRepAccessOfficeSlugs !== undefined) {
      queue.push(
        options.targetRepAccessOfficeSlugs.map((s) => ({ slug: s, name: officeNameForSlug(s) }))
      );
    }
  } else {
    // no-officeCode fallback branch: resolve the deal office via the current owner...
    queue.push([{ id: "rep-old", isActive: true, officeId: currentOwnerOfficeId }]);
    // ...then, on a mismatch, the additional-office grant lookup (keyed by office_id).
    if (options.targetRepHasGrantToCurrentOwnerOffice !== undefined) {
      queue.push(
        options.targetRepHasGrantToCurrentOwnerOffice
          ? [{ userId: "rep-new", officeId: currentOwnerOfficeId }]
          : []
      );
    }
  }

  // Consumed by updateDeal AFTER validation (old-rep lookup for the audit trail).
  queue.push([{ id: "rep-old", isActive: true, officeId: "office-1" }]);

  const select = vi.fn(() => ({
    from: vi.fn(() => {
      const chain: any = {
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => {
          const next = queue.shift();
          return {
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(next).then(resolve),
            limit: vi.fn(async () => next),
          };
        }),
      };
      return chain;
    }),
  }));

  const returning = vi.fn(async () => [
    {
      id: "deal-1",
      name: "Hill Place Interior Upgrade",
      assignedRepId: "rep-new",
      sourceLeadId: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      stageId: "stage-estimating",
      workflowRoute: "estimating",
      officeCode: "dfw",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    },
  ]);

  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning,
      })),
    })),
  }));

  const insert = vi.fn(() => ({
    values: vi.fn(async (value: unknown) => {
      insertedValues.push(value);
      return [];
    }),
  }));

  return { select, update, insert, insertedValues };
}

describe("deal reassignment tasking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new deal assignment task when assignedRepId changes", async () => {
    const tenantDb = createDealDb();

    await updateDeal(
      tenantDb as any,
      "deal-1",
      {
        assignedRepId: "rep-new",
      },
      "director",
      "director-1",
      "office-1"
    );

    expect(createAssignmentTaskIfNeeded).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        entityType: "deal",
        entityId: "deal-1",
        previousAssignedRepId: "rep-old",
        nextAssignedRepId: "rep-new",
        actorUserId: "director-1",
      })
    );
    expect(tenantDb.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "deal_history",
          recordId: "deal-1",
          changedBy: "director-1",
          changes: {
            assignedRepId: { from: "rep-old", to: "rep-new" },
          },
          fullRow: expect.objectContaining({
            oldRepId: "rep-old",
            newRepId: "rep-new",
            changedBy: "director-1",
          }),
        }),
        expect.objectContaining({
          jobType: "domain_event",
          payload: expect.objectContaining({
            eventName: "deal.assignment.changed",
            oldRepId: "rep-old",
            newRepId: "rep-new",
            changedBy: "director-1",
            propagationChannel: "synchub_bid_board",
          }),
        }),
      ])
    );
  });

  it("accepts reassignment to a multi-office rep whose PRIMARY office differs from the deal's office but who holds an additional-office grant for it", async () => {
    // Mirrors the real prod case: deal office_code 'dfw', target rep's primary
    // office is Atlanta, but the rep holds a user_office_access grant to a
    // Dallas-coded office. The guard must honor that grant, not the primary only.
    const tenantDb = createDealDb({
      targetRepOfficeId: "office-2",
      targetOfficeSlug: "atlanta",
      targetRepAccessOfficeSlugs: ["dallas"],
    });

    await updateDeal(
      tenantDb as any,
      "deal-1",
      {
        assignedRepId: "rep-new",
      },
      "director",
      "director-1",
      "office-1"
    );

    expect(createAssignmentTaskIfNeeded).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        entityType: "deal",
        entityId: "deal-1",
        previousAssignedRepId: "rep-old",
        nextAssignedRepId: "rep-new",
      })
    );
    expect(tenantDb.update).toHaveBeenCalled();
  });

  it("still rejects reassignment to a rep whose PRIMARY office differs and who has NO grant for the deal's office", async () => {
    // Over-correction guard: a rep with no access to the deal's office must
    // still be rejected — the fix must not let anyone be assigned anywhere.
    const tenantDb = createDealDb({
      targetRepOfficeId: "office-2",
      targetOfficeSlug: "atlanta",
      targetRepAccessOfficeSlugs: [],
    });

    await expect(
      updateDeal(
        tenantDb as any,
        "deal-1",
        {
          assignedRepId: "rep-new",
        },
        "director",
        "director-1",
        "office-1"
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "DEAL_REASSIGNMENT_OFFICE_MISMATCH",
      message: "Deals can only be reassigned to users in the same office",
    });
    expect(tenantDb.update).not.toHaveBeenCalled();
  });

  it("accepts reassignment via the no-officeCode fallback when the rep holds a grant to the current owner's office", async () => {
    const tenantDb = createDealDb({
      dealOfficeCode: null,
      targetRepOfficeId: "office-2",
      currentOwnerOfficeId: "office-1",
      targetRepHasGrantToCurrentOwnerOffice: true,
    });

    await updateDeal(
      tenantDb as any,
      "deal-1",
      {
        assignedRepId: "rep-new",
      },
      "director",
      "director-1",
      "office-1"
    );

    expect(tenantDb.update).toHaveBeenCalled();
  });

  it("still rejects via the no-officeCode fallback when the rep has no grant to the current owner's office", async () => {
    const tenantDb = createDealDb({
      dealOfficeCode: null,
      targetRepOfficeId: "office-2",
      currentOwnerOfficeId: "office-1",
      targetRepHasGrantToCurrentOwnerOffice: false,
    });

    await expect(
      updateDeal(
        tenantDb as any,
        "deal-1",
        {
          assignedRepId: "rep-new",
        },
        "director",
        "director-1",
        "office-1"
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "DEAL_REASSIGNMENT_OFFICE_MISMATCH",
      message: "Deals can only be reassigned to users in the same office",
    });
    expect(tenantDb.update).not.toHaveBeenCalled();
  });

  it("rejects a non-owner non-admin before validating or writing reassignment", async () => {
    const tenantDb = createDealDb();

    await expect(
      updateDeal(
        tenantDb as any,
        "deal-1",
        {
          assignedRepId: "rep-new",
        },
        "rep",
        "rep-other",
        "office-1"
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "DEAL_REASSIGNMENT_FORBIDDEN",
      message: "Only the assigned rep, a director, or an admin can reassign this deal",
    });
    expect(tenantDb.update).not.toHaveBeenCalled();
    expect(createAssignmentTaskIfNeeded).not.toHaveBeenCalled();
  });

  it("writes an activity audit entry when reassignment includes route audit context", async () => {
    const tenantDb = createDealDb();

    await updateDeal(
      tenantDb as any,
      "deal-1",
      {
        assignedRepId: "rep-new",
        auditContext: {
          actor: {
            userId: "director-1",
            name: "Director One",
            role: "director",
          },
          ipAddress: "127.0.0.1",
          userAgent: "vitest",
        },
      },
      "director",
      "director-1",
      "office-1"
    );

    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantDb,
        action: "update",
        fieldChanges: {
          assignedRepId: { from: "rep-old", to: "rep-new" },
        },
        actor: expect.objectContaining({ userId: "director-1" }),
      })
    );
  });
});

describe("proposal draft backend wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stamps proposalDraftStartedAt and writes a draft audit row", async () => {
    const startedAt = new Date("2026-04-28T15:00:00.000Z");
    const insertedValues: unknown[] = [];
    const existingDeal = {
      id: "deal-1",
      name: "Hill Place Interior Upgrade",
      assignedRepId: "rep-1",
      sourceLeadId: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      stageId: "stage-estimating",
      workflowRoute: "normal",
      isBidBoardOwned: false,
      proposalStatus: "not_started",
      proposalDraftStartedAt: null,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    };
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn(async () => [existingDeal]),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          expect(values).toMatchObject({
            proposalStatus: "drafting",
            proposalDraftStartedAt: expect.any(Date),
          });
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [
                {
                  ...existingDeal,
                  ...values,
                  proposalDraftStartedAt: startedAt,
                },
              ]),
            })),
          };
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: unknown) => {
          insertedValues.push(value);
          return [];
        }),
      })),
    };

    const deal = await startProposalDraft(
      tenantDb as any,
      "deal-1",
      "director",
      "director-1"
    );

    expect(deal.proposalStatus).toBe("drafting");
    expect(deal.proposalDraftStartedAt).toEqual(startedAt);
    expect(insertedValues).toEqual([
      expect.objectContaining({
        tableName: "proposal_drafts",
        recordId: "deal-1",
        action: "insert",
        changedBy: "director-1",
        changes: expect.objectContaining({
          proposalDraftStartedAt: {
            from: null,
            to: expect.any(String),
          },
        }),
        fullRow: expect.objectContaining({
          dealId: "deal-1",
          status: "draft",
          createdBy: "director-1",
        }),
      }),
    ]);
  });
});
