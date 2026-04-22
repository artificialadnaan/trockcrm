import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  useAdminDataScrubMock: vi.fn(),
}));

vi.mock("@/hooks/use-admin-data-scrub", () => ({
  useAdminDataScrub: mocks.useAdminDataScrubMock,
}));

import { AdminDataScrubPage } from "./admin-data-scrub-page";

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("AdminDataScrubPage", () => {
  it("renders the admin scrub control surface with queues and ownership coverage", () => {
    mocks.useAdminDataScrubMock.mockReturnValue({
      loading: false,
      error: null,
      refetch: vi.fn(),
      data: {
        summary: {
          openDuplicateContacts: 12,
          resolvedDuplicateContacts7d: 4,
          openOwnershipGaps: 7,
          recentScrubActions7d: 19,
        },
        backlogBuckets: [
          {
            bucketKey: "duplicate_contacts",
            label: "Duplicate Contacts",
            count: 12,
            linkPath: "/admin/merge-queue",
          },
        ],
        ownershipCoverage: [
          {
            bucketKey: "company_owner_missing",
            gapKey: "company_owner_missing",
            label: "Companies missing an owner",
            count: 5,
          },
        ],
        scrubActivityByUser: [
          {
            userId: "user-1",
            userName: "Morgan Lee",
            actionCount: 9,
            ownershipEditCount: 3,
            lastActionAt: "2026-04-18T15:30:00.000Z",
          },
        ],
      },
    });

    const html = normalize(
      renderToStaticMarkup(
        <MemoryRouter>
          <AdminDataScrubPage />
        </MemoryRouter>
      )
    );

    expect(html).toContain("Admin Data Scrub");
    expect(html).toContain("Open Duplicate Contacts");
    expect(html).toContain("12");
    expect(html).toContain("Duplicate Contacts");
    expect(html).toContain('href="/admin/merge-queue"');
    expect(html).toContain("Companies missing an owner");
    expect(html).toContain("Morgan Lee");
    expect(html).toContain("3");
  });
});
