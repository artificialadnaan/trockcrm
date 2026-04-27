import { describe, expect, it, vi } from "vitest";
import {
  computeExistingCustomerStatus,
  getCompanyVerificationRecipient,
  maybeRequestCompanyVerification,
  shouldRequestCompanyVerification,
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

  it("routes verification email to the canonical Adnaan inbox by default", () => {
    const original = process.env.COMPANY_VERIFICATION_EMAIL;
    delete process.env.COMPANY_VERIFICATION_EMAIL;

    expect(getCompanyVerificationRecipient()).toBe("adnaan.iqbal@gmail.com");

    if (original === undefined) {
      delete process.env.COMPANY_VERIFICATION_EMAIL;
    } else {
      process.env.COMPANY_VERIFICATION_EMAIL = original;
    }
  });

  it("requests verification for new companies only once", () => {
    expect(
      shouldRequestCompanyVerification({
        computedStatus: "New",
        companyVerificationStatus: null,
        companyVerificationEmailSentAt: null,
      })
    ).toBe(true);
    expect(
      shouldRequestCompanyVerification({
        computedStatus: "New",
        companyVerificationStatus: "pending",
        companyVerificationEmailSentAt: new Date("2026-04-25T12:00:00.000Z"),
      })
    ).toBe(false);
    expect(
      shouldRequestCompanyVerification({
        computedStatus: "Existing",
        companyVerificationStatus: null,
        companyVerificationEmailSentAt: null,
      })
    ).toBe(false);
  });

  it("does not count the lead being created as prior company activity for verification", async () => {
    const now = new Date("2026-04-25T12:00:00.000Z");
    const executedQueries: unknown[] = [];
    const companyUpdates: Array<Record<string, unknown>> = [];
    const insertedActivities: Array<Record<string, unknown>> = [];
    const tenantDb = {
      execute: vi.fn(async (query: unknown) => {
        executedQueries.push(query);
        return { rows: [{ has_activity: false }] };
      }),
      select() {
        return {
          from() {
            return {
              where() {
                return this;
              },
              limit() {
                return this;
              },
              then(onfulfilled: (value: unknown[]) => unknown) {
                return Promise.resolve([
                  {
                    id: "company-1",
                    name: "AUDIT_TEST_New Company",
                    companyVerificationStatus: null,
                    companyVerificationRequestedAt: null,
                    companyVerificationEmailSentAt: null,
                  },
                ]).then(onfulfilled);
              },
            };
          },
        };
      },
      update() {
        return {
          set(values: Record<string, unknown>) {
            companyUpdates.push(values);
            return {
              where() {
                return Promise.resolve([]);
              },
            };
          },
        };
      },
      insert() {
        return {
          values(values: Record<string, unknown>) {
            insertedActivities.push(values);
            return {
              returning() {
                return Promise.resolve([{ id: "activity-1", ...values }]);
              },
            };
          },
        };
      },
    };

    await maybeRequestCompanyVerification(tenantDb as never, {
      companyId: "company-1",
      companyName: "AUDIT_TEST_New Company",
      leadId: "lead-created",
      leadName: "AUDIT_TEST_New Lead",
      userId: "rep-1",
      now,
      excludeLeadId: "lead-created",
    });

    const firstQueryText = JSON.stringify(
      (executedQueries[0] as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? executedQueries[0]
    );
    expect(firstQueryText).toContain("leads.id <>");
    expect(companyUpdates[0]).toMatchObject({
      companyVerificationStatus: "pending",
      companyVerificationRequestedAt: now,
      companyVerificationEmailSentAt: now,
    });
    expect(insertedActivities[0]?.body).toContain("Company verification email sent to");
  });
});
