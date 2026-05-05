import { expect, test } from "@playwright/test";
import { installCommonApiMocks } from "./helpers/mock-api";

const deal = {
  id: "deal-photos",
  dealNumber: "dfw-3-11826-ph",
  name: "Photos Tab Deal",
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
  stageEnteredAt: "2026-04-28T12:00:00.000Z",
  createdAt: "2026-04-28T12:00:00.000Z",
  updatedAt: "2026-04-28T12:00:00.000Z",
  proposalStatus: "not_started",
  proposalDraftStartedAt: null,
  proposalSentAt: null,
  proposalAcceptedAt: null,
  proposalRevisionCount: 0,
};

const basePhotos = [
  {
    id: "photo-1",
    category: "photo",
    photoCategory: "damage",
    subcategory: null,
    displayName: "Damage roof photo",
    mimeType: "image/jpeg",
    r2Key: "photos/photo-1.jpg",
    externalUrl: "https://example.test/photo-1.jpg",
    externalThumbnailUrl: "https://example.test/photo-1-thumb.jpg",
    description: "Storm damage before repair",
    takenAt: "2026-05-04T17:43:00.000Z",
    createdAt: "2026-05-04T18:00:00.000Z",
    uploadedBy: "user-1",
    uploaderName: "Kaleb Martin",
    uploaderAvatarUrl: null,
    latitude: "35.1234567",
    longitude: "-97.6543210",
    address: "100 Main St",
    addressSource: "exif",
    geocodedAt: "2026-05-04T18:00:00.000Z",
    procoreSyncStatus: "pending",
    deletedAt: null,
    deletedByUserId: null,
  },
  {
    id: "photo-2",
    category: "photo",
    photoCategory: "safety",
    subcategory: null,
    displayName: "Safety setup photo",
    mimeType: "image/jpeg",
    r2Key: "photos/photo-2.jpg",
    externalUrl: "https://example.test/photo-2.jpg",
    externalThumbnailUrl: "https://example.test/photo-2-thumb.jpg",
    description: "Safety setup",
    takenAt: "2026-05-03T15:00:00.000Z",
    createdAt: "2026-05-03T15:10:00.000Z",
    uploadedBy: "user-2",
    uploaderName: "Adnaan Iqbal",
    uploaderAvatarUrl: null,
    latitude: null,
    longitude: null,
    address: "Project address",
    addressSource: "deal_fallback",
    geocodedAt: null,
    procoreSyncStatus: null,
    deletedAt: null,
    deletedByUserId: null,
  },
];

async function installPhotosMocks(page: Parameters<typeof installCommonApiMocks>[0]) {
  await installCommonApiMocks(page);
  let photos = structuredClone(basePhotos);

  await page.route("**/api/deals/deal-photos/detail", (route) => route.fulfill({ json: { deal } }));
  await page.route("**/api/deals/deal-photos/team", (route) => route.fulfill({ json: { members: [] } }));
  await page.route("**/api/deals/deal-photos/timers", (route) => route.fulfill({ json: { active: [], recent: [], all: [] } }));
  await page.route("**/api/files/deal/deal-photos/photos**", (route) => {
    const url = new URL(route.request().url());
    const includeDeleted = url.searchParams.get("deleted") === "1" || url.searchParams.get("deleted") === "true";
    const visible = photos.filter((photo) => includeDeleted || !photo.deletedAt);
    return route.fulfill({
      json: {
        photos: visible,
        pagination: { page: 1, limit: 200, total: visible.length, totalPages: 1 },
      },
    });
  });
  await page.route("**/api/files/photo-1/download", (route) => route.fulfill({ json: { url: "https://example.test/photo-1.jpg", filename: "photo-1.jpg" } }));
  await page.route("**/api/files/photo-2/download", (route) => route.fulfill({ json: { url: "https://example.test/photo-2.jpg", filename: "photo-2.jpg" } }));
  await page.route("**/api/files/photo-1/address", async (route) => {
    const body = await route.request().postDataJSON();
    photos = photos.map((photo) => photo.id === "photo-1"
      ? { ...photo, ...body, addressSource: "manual_override" }
      : photo);
    return route.fulfill({ json: { file: photos.find((photo) => photo.id === "photo-1") } });
  });
  await page.route("**/api/files/photo-1", async (route) => {
    if (route.request().method() === "DELETE") {
      photos = photos.map((photo) => photo.id === "photo-1"
        ? { ...photo, deletedAt: "2026-05-05T12:00:00.000Z", deletedByUserId: "admin-1" }
        : photo);
      return route.fulfill({ json: { success: true } });
    }
    const body = await route.request().postDataJSON();
    photos = photos.map((photo) => photo.id === "photo-1" ? { ...photo, ...body } : photo);
    return route.fulfill({ json: { file: photos.find((photo) => photo.id === "photo-1") } });
  });
}

test("photo viewer edits category and address, soft deletes, then restores", async ({ page }) => {
  await installPhotosMocks(page);

  await page.goto("/deals/deal-photos/photos");
  await expect(page.getByRole("button", { name: /Photos \(2\)/ })).toHaveClass(/border-brand-red/);
  await expect(page.getByText("Monday, May 4th, 2026")).toBeVisible();

  await page.getByLabel("Open photo Damage roof photo").click();
  await expect(page.getByText("Uploaded by")).toBeVisible();
  await expect(page.getByText("From photo")).toBeVisible();

  await page.locator("section").filter({ hasText: "Category" }).getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Safety" }).click();
  await expect(page.locator("section").filter({ hasText: "Category" }).getByText("Safety")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Edit address" }).click();
  await page.getByPlaceholder("Street address").fill("200 Updated Ave");
  await page.getByRole("button", { name: "Save address" }).click();
  await expect(page.getByText("200 Updated Ave")).toBeVisible();
  await expect(page.getByText("Manually set")).toBeVisible();

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Delete this photo?")).toBeVisible();
  await page.getByRole("button", { name: "Delete photo" }).click();
  await expect(page.getByLabel("Open photo Damage roof photo")).toHaveCount(0);

  await page.getByLabel("Show deleted photos").click();
  await expect(page.getByText("Deleted")).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByLabel("Open photo Damage roof photo")).toBeVisible();
});

test("photo filters and grouping persist through the URL", async ({ page }) => {
  await installPhotosMocks(page);

  await page.goto("/deals/deal-photos/photos");
  await page.getByLabel("Category filter").click();
  await page.locator("[data-base-ui-portal]").getByRole("button", { name: "Safety", exact: true }).click();
  await expect(page).toHaveURL(/category=safety/);
  await expect(page.getByLabel("Open photo Safety setup photo")).toBeVisible();
  await expect(page.getByLabel("Open photo Damage roof photo")).toHaveCount(0);

  await page.getByLabel("Uploader filter").click();
  await page.getByRole("button", { name: "Adnaan Iqbal" }).click();
  await expect(page).toHaveURL(/uploader=user-2/);

  await page.getByLabel("Group by Category").click();
  await expect(page).toHaveURL(/group=category/);
  await expect(page.getByRole("heading", { name: /Safety/ })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Open photo Safety setup photo")).toBeVisible();
  await expect(page.getByLabel("Open photo Damage roof photo")).toHaveCount(0);
  await expect(page).toHaveURL(/category=safety/);
});
