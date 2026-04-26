import { describe, expect, it, vi } from "vitest";
import {
  computeExistingCustomerStatus,
  getCompanyVerificationRecipient,
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

    process.env.COMPANY_VERIFICATION_EMAIL = original;
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
