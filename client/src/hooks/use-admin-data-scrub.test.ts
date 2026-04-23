import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

describe("executeAdminDataScrubOverview", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("requests the admin data scrub overview endpoint", async () => {
    apiMock.mockResolvedValueOnce({
      summary: {
        openDuplicateContacts: 3,
        resolvedDuplicateContacts7d: 5,
        openOwnershipGaps: 2,
        recentScrubActions7d: 11,
      },
      backlogBuckets: [],
      ownershipCoverage: [],
      scrubActivityByUser: [],
    });

    const { executeAdminDataScrubOverview } = await import("./use-admin-data-scrub");
    const result = await executeAdminDataScrubOverview();

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith("/admin/data-scrub/overview");
    expect(result.summary.openDuplicateContacts).toBe(3);
  });
});
