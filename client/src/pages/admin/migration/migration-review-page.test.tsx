import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const invalidCompany = {
  id: "company-1",
  hubspotCompanyId: "hs-company-1",
  mappedName: "Alpha Roofing",
  mappedDomain: "alpha.com",
  mappedPhone: null,
  mappedOwnerEmail: "owner@trock.com",
  mappedLeadHint: null,
  validationStatus: "invalid",
  validationErrors: [{ field: "company", error: "Missing domain" }],
  validationWarnings: [],
  exceptionBucket: "unknown_company",
  exceptionReason: "Company cannot be matched because both name and domain are missing.",
  reviewNotes: null,
  promotedAt: null,
};

const queueResult = {
  rows: [invalidCompany],
  total: 75,
  page: 1,
  setPage: vi.fn(),
  loading: false,
  approve: vi.fn(),
  reject: vi.fn(),
  refetch: vi.fn(),
};

vi.mock("../../../hooks/use-migration", () => ({
  useStagedCompanies: vi.fn((validationStatus?: string) =>
    validationStatus === "unresolved" ? queueResult : { ...queueResult, rows: [], total: 75 }
  ),
  useStagedProperties: vi.fn((validationStatus?: string) =>
    validationStatus === "unresolved" ? queueResult : { ...queueResult, rows: [], total: 75 }
  ),
  useStagedLeads: vi.fn((validationStatus?: string) =>
    validationStatus === "unresolved" ? queueResult : { ...queueResult, rows: [], total: 75 }
  ),
}));

import { MigrationReviewPage } from "./migration-review-page";
import {
  MigrationReviewActionErrorBanner,
  formatMigrationReviewActionError,
} from "./migration-review-page";

describe("MigrationReviewPage", () => {
  it("surfaces invalid rows and paging controls for unresolved migration queues", () => {
    const html = renderToStaticMarkup(<MigrationReviewPage />);

    expect(html).toContain("invalid");
    expect(html).toContain("Page 1 of 2");
    expect(html).toContain("Next");
  });

  it("renders a visible approval failure banner", () => {
    const message = formatMigrationReviewActionError(
      "approve",
      new Error("Lead cannot be promoted while it still has an unresolved deal conflict exception.")
    );
    const html = renderToStaticMarkup(
      <MigrationReviewActionErrorBanner message={message} />
    );

    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("unresolved deal conflict exception");
  });

  it("falls back to a generic message when the server does not provide one", () => {
    expect(formatMigrationReviewActionError("reject", "no message")).toBe(
      "Failed to reject migration row"
    );
  });
});
