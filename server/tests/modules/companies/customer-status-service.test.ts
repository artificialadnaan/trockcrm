import { describe, expect, it, vi } from "vitest";
import {
  computeExistingCustomerStatus,
  markCompanyRejected,
} from "../../../src/modules/companies/customer-status-service.js";

describe("customer status service", () => {
  it("treats recent engagement activity as Existing and pure notes as New", async () => {
    const now = new Date("2026-04-25T12:00:00.000Z");
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ has_activity: false }],
        })
        .mockResolvedValueOnce({
          rows: [{ has_activity: true }],
        }),
    };

    await expect(computeExistingCustomerStatus(tenantDb as never, "company-1", now)).resolves.toEqual({
      status: "New",
      hasRecentActivity: false,
    });
    await expect(computeExistingCustomerStatus(tenantDb as never, "company-1", now)).resolves.toEqual({
      status: "Existing",
      hasRecentActivity: true,
    });

    expect(tenantDb.execute).toHaveBeenCalledTimes(2);
    expect(String(tenantDb.execute.mock.calls[0][0])).not.toContain("type = 'note'");
  });

});

describe("markCompanyRejected", () => {
  it("writes rejected status + audit columns and inserts a note activity", async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const updateCalls: Array<Record<string, unknown>> = [];
    const tenantDb = {
      update() {
        return {
          set(values: Record<string, unknown>) {
            updateCalls.push(values);
            return {
              where() {
                return {
                  returning() {
                    return Promise.resolve([{ id: "company-1", name: "Acme" }]);
                  },
                };
              },
            };
          },
        };
      },
      insert() {
        return {
          values(value: Record<string, unknown>) {
            inserts.push(value);
            return {
              returning() {
                return Promise.resolve([{ id: "activity-1", ...value }]);
              },
            };
          },
        };
      },
      execute: vi.fn().mockResolvedValue({ rows: [{ status: "New" }] }),
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  // createActivity now verifies the company it is about is still live, so this answers
                  // as one. Rejecting a company sets a verification STATUS; it stays active.
                  limit() {
                    return Promise.resolve([{ id: "company-1" }]);
                  },
                  then(onfulfilled: (rows: unknown[]) => unknown) {
                    return Promise.resolve([]).then(onfulfilled);
                  },
                };
              },
            };
          },
        };
      },
    };

    const company = await markCompanyRejected(tenantDb as never, {
      companyId: "company-1",
      userId: "user-1",
      reason: "Duplicate of existing company",
      now: new Date("2026-04-27T15:00:00.000Z"),
    });

    expect(company).toEqual({ id: "company-1", name: "Acme" });
    expect(updateCalls[0]).toMatchObject({
      companyVerificationStatus: "rejected",
      companyVerificationRejectedBy: "user-1",
    });
    expect(updateCalls[0]?.companyVerificationRejectedAt).toBeInstanceOf(Date);

    expect(inserts.length).toBeGreaterThan(0);
    const noteInsert = inserts.find((row) => row.type === "note");
    expect(noteInsert).toMatchObject({
      sourceEntityType: "company",
      sourceEntityId: "company-1",
      subject: "Company verification rejected",
    });
    expect(String(noteInsert?.body)).toContain("Duplicate of existing company");
  });
});
