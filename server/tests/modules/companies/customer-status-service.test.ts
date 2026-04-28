import { describe, expect, it, vi } from "vitest";
import {
  buildCompanyVerificationEmail,
  computeExistingCustomerStatus,
  getActiveAdminDirectorEmails,
  markCompanyRejected,
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
});

describe("getActiveAdminDirectorEmails", () => {
  function makeTenantDb(opts: {
    approverRow?: { email: string; isActive: boolean } | undefined;
    adminDirectorRows?: Array<{ email: string }>;
  }) {
    const calls: Array<{ table: string; columns: string[]; whereCalled: boolean; limitCalled: boolean }> =
      [];
    return {
      _calls: calls,
      select(columns: Record<string, unknown>) {
        const columnNames = Object.keys(columns);
        return {
          from(table: { _: { name?: string } } | unknown) {
            const tableName = String(((table as { _: { name?: string } })?._?.name) ?? "unknown");
            const entry = { table: tableName, columns: columnNames, whereCalled: false, limitCalled: false };
            calls.push(entry);
            return {
              where() {
                entry.whereCalled = true;
                return {
                  limit() {
                    entry.limitCalled = true;
                    return Promise.resolve(opts.approverRow ? [opts.approverRow] : []);
                  },
                  then(onfulfilled: (rows: unknown[]) => unknown) {
                    return Promise.resolve(opts.adminDirectorRows ?? []).then(onfulfilled);
                  },
                };
              },
            };
          },
        };
      },
    };
  }

  it("uses the assigned approver when active", async () => {
    const tenantDb = makeTenantDb({
      approverRow: { email: "approver@example.com", isActive: true },
    });
    const emails = await getActiveAdminDirectorEmails(tenantDb as never, {
      assignedApproverUserId: "approver-id",
    });
    expect(emails).toEqual(["approver@example.com"]);
  });

  it("falls back to active admin/director users when assigned approver is inactive", async () => {
    const tenantDb = makeTenantDb({
      approverRow: { email: "approver@example.com", isActive: false },
      adminDirectorRows: [{ email: "admin@example.com" }, { email: "director@example.com" }],
    });
    const emails = await getActiveAdminDirectorEmails(tenantDb as never, {
      assignedApproverUserId: "approver-id",
    });
    expect(emails).toEqual(["admin@example.com", "director@example.com"]);
  });

  it("falls back to env var when no admin/director users exist", async () => {
    const original = process.env.COMPANY_VERIFICATION_EMAIL;
    process.env.COMPANY_VERIFICATION_EMAIL = "fallback@example.com";
    try {
      const tenantDb = makeTenantDb({ adminDirectorRows: [] });
      const emails = await getActiveAdminDirectorEmails(tenantDb as never);
      expect(emails).toEqual(["fallback@example.com"]);
    } finally {
      if (original === undefined) {
        delete process.env.COMPANY_VERIFICATION_EMAIL;
      } else {
        process.env.COMPANY_VERIFICATION_EMAIL = original;
      }
    }
  });

  it("returns empty array when env fallback is unset and no admin/director users exist", async () => {
    const original = process.env.COMPANY_VERIFICATION_EMAIL;
    delete process.env.COMPANY_VERIFICATION_EMAIL;
    try {
      const tenantDb = makeTenantDb({ adminDirectorRows: [] });
      const emails = await getActiveAdminDirectorEmails(tenantDb as never);
      expect(emails).toEqual([]);
    } finally {
      if (original !== undefined) {
        process.env.COMPANY_VERIFICATION_EMAIL = original;
      }
    }
  });
});

describe("buildCompanyVerificationEmail", () => {
  it("includes approve and reject CTAs pointing at frontend URLs", () => {
    const original = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = "https://crm.example.com";
    try {
      const { subject, html } = buildCompanyVerificationEmail({
        companyId: "company-1",
        companyName: "Acme Corp",
        leadId: "lead-1",
        leadName: "Acme Roof Repair",
      });
      expect(subject).toBe("Company verification needed: Acme Corp");
      expect(html).toContain("https://crm.example.com/companies/company-1?action=verify");
      expect(html).toContain("https://crm.example.com/companies/company-1?action=reject");
      expect(html).toContain("https://crm.example.com/leads/lead-1");
      expect(html).toContain(">Approve<");
      expect(html).toContain(">Reject<");
    } finally {
      if (original === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = original;
    }
  });

  it("strips trailing slash from frontend URL", () => {
    const { html } = buildCompanyVerificationEmail({
      companyId: "company-1",
      companyName: "Acme",
      leadId: "lead-1",
      leadName: "Lead",
      frontendUrl: "https://crm.example.com/",
    });
    expect(html).toContain("https://crm.example.com/companies/company-1");
    expect(html).not.toContain("https://crm.example.com//");
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
                  limit() {
                    return Promise.resolve([]);
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
