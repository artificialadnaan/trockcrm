import { expect, test } from "@playwright/test";
import { installCommonApiMocks } from "./helpers/mock-api";

const deal = {
  id: "deal-public-photos",
  dealNumber: "TR-140",
  name: "Public Photo Deal",
  stageId: "stage-opportunity",
  assignedRepId: "admin-1",
  assignedRepName: "Admin User",
  sourceLeadId: null,
  companyId: "company-1",
  propertyId: "property-1",
  primaryContactId: null,
  changeOrders: [],
  approvals: [],
  stageHistory: [],
  workflowRoute: "normal",
  isBidBoardOwned: false,
  bidBoardOwnership: { isOwned: false },
  postConversionEnrichment: { applies: false, isComplete: true, requiredFields: [], missingFields: [] },
  stageEnteredAt: "2026-05-01T12:00:00.000Z",
  createdAt: "2026-05-01T12:00:00.000Z",
  updatedAt: "2026-05-01T12:00:00.000Z",
  proposalStatus: "not_started",
  proposalDraftStartedAt: null,
  proposalSentAt: null,
  proposalAcceptedAt: null,
  proposalRevisionCount: 0,
};

const photo = {
  id: "photo-public-1",
  category: "photo",
  photoCategory: "damage",
  subcategory: null,
  displayName: "Public roof photo",
  mimeType: "image/jpeg",
  fileExtension: ".jpg",
  description: "Public viewer photo",
  takenAt: "2026-05-04T17:43:00.000Z",
  createdAt: "2026-05-04T18:00:00.000Z",
  uploadedBy: "user-1",
  uploaderName: "Admin User",
  uploaderAvatarUrl: null,
  latitude: null,
  longitude: null,
  address: "100 Main St",
  addressSource: "deal_fallback",
  imageUrl: "https://example.test/public-photo.jpg",
};

async function installAdminPhotoShareMocks(
  page: Parameters<typeof installCommonApiMocks>[0],
  state: { revoked: boolean } = { revoked: false },
) {
  await installCommonApiMocks(page);
  const tokens = [{
    id: "public-token-id",
    createdBy: { id: "admin-1", name: "Admin User" },
    createdAt: "2026-05-05T12:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    lastAccessedAt: null,
    accessCount: 0,
    status: "active",
  }];

  await page.route("**/api/deals/deal-public-photos/detail", (route) => route.fulfill({ json: { deal } }));
  await page.route("**/api/deals/deal-public-photos/team", (route) => route.fulfill({ json: { members: [] } }));
  await page.route("**/api/deals/deal-public-photos/timers", (route) => route.fulfill({ json: { active: [], recent: [], all: [] } }));
  await page.route("**/api/files/deal/deal-public-photos/photos**", (route) =>
    route.fulfill({ json: { photos: [photo], pagination: { page: 1, limit: 200, total: 1, totalPages: 1 } } })
  );
  await page.route("**/api/admin/deals/deal-public-photos/photo-tokens", async (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 201,
        json: {
          token: { id: "public-token-id", dealId: deal.id, tenantId: "office-1", expiresAt: null },
          rawToken: "raw-public-token",
          url: "/p/raw-public-token",
        },
      });
    }
    return route.fulfill({ json: { tokens: state.revoked ? [{ ...tokens[0], status: "revoked", revokedAt: "2026-05-05T13:00:00.000Z" }] : tokens } });
  });
  await page.route("**/api/admin/photo-tokens/public-token-id/revoke", (route) => {
    state.revoked = true;
    return route.fulfill({ json: { success: true } });
  });
}

async function installPublicPhotoViewerMocks(
  page: Parameters<typeof installCommonApiMocks>[0],
  state: { revoked: boolean },
) {
  await page.route("**/api/public/photo-viewer/raw-public-token", (route) => {
    if (state.revoked) return route.fulfill({ status: 404, json: { error: { message: "Photo link not found" } } });
    return route.fulfill({
      json: {
        deal: { id: deal.id, name: deal.name, dealNumber: deal.dealNumber, propertyAddress: "100 Main St" },
        photos: [photo],
      },
    });
  });
  await page.route("**/api/public/photo-viewer/raw-public-token/photos/photo-public-1/download", (route) =>
    route.fulfill({ json: { url: "https://example.test/public-photo.jpg" } })
  );
  await page.route("https://example.test/public-photo.jpg", (route) => route.fulfill({ body: "mock image" }));
}

test("admin creates a public photo link, public viewer loads, downloads, then revoked link errors", async ({ page, browser }) => {
  const state = { revoked: false };
  await installAdminPhotoShareMocks(page, state);

  await page.goto("/deals/deal-public-photos/photos");
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("button", { name: "Create new link" }).click();
  await expect(page.locator('input[readonly]')).toHaveValue("/p/raw-public-token");

  const publicContext = await browser.newContext();
  const publicPage = await publicContext.newPage();
  await installPublicPhotoViewerMocks(publicPage, state);
  await publicPage.goto("/p/raw-public-token");
  await expect(publicPage.getByRole("heading", { name: "Public Photo Deal" })).toBeVisible();
  // Leak-free public payload: even though the API mock still returns a per-photo displayName, the
  // viewer must NOT render it — thumbnails carry only a generic, indexed accessible name.
  await expect(publicPage.getByText("Public roof photo")).toHaveCount(0);
  await expect(publicPage.getByRole("button", { name: "Shared photo 1" })).toBeVisible();
  await publicPage.getByRole("button", { name: "Shared photo 1" }).click();
  await expect(publicPage.getByRole("button", { name: "Download" })).toBeVisible();

  await page.getByRole("button", { name: "Revoke" }).click();
  await expect.poll(() => state.revoked).toBe(true);
  await publicPage.reload();
  await expect(publicPage.getByText("This link is no longer valid.")).toBeVisible();
  await publicContext.close();
});
