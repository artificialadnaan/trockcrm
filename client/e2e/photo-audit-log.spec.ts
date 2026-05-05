import { expect, test } from "@playwright/test";
import { installCommonApiMocks } from "./helpers/mock-api";

const photo = {
  id: "photo-1",
  category: "photo",
  photoCategory: "safety",
  subcategory: null,
  displayName: "Audit roof photo",
  mimeType: "image/jpeg",
  fileSizeBytes: 2048,
  fileExtension: ".jpg",
  r2Key: "photos/photo-1.jpg",
  externalUrl: "https://example.test/photo-1.jpg",
  externalThumbnailUrl: "https://example.test/photo-1-thumb.jpg",
  description: "Audit photo",
  takenAt: "2026-05-04T17:43:00.000Z",
  createdAt: "2026-05-04T18:00:00.000Z",
  uploadedBy: "admin-1",
  uploaderName: "Admin User",
  uploaderAvatarUrl: null,
  latitude: "35.1234567",
  longitude: "-97.6543210",
  address: "200 Updated Ave",
  addressSource: "manual_override",
  geocodedAt: "2026-05-04T18:00:00.000Z",
  procoreSyncStatus: null,
  deletedAt: null,
  deletedByUserId: null,
};

const auditEvents = [
  {
    id: "audit-restored",
    eventType: "restored",
    userId: "admin-1",
    userName: "Admin User",
    userAvatarUrl: null,
    createdAt: "2026-05-05T15:05:00.000Z",
    ipAddress: "127.0.0.1",
    userAgent: "playwright",
    metadata: { previouslyDeletedAt: "2026-05-05T15:04:00.000Z" },
    photo: {
      id: photo.id,
      displayName: photo.displayName,
      fileExtension: photo.fileExtension,
      r2Key: photo.r2Key,
      externalUrl: photo.externalUrl,
      externalThumbnailUrl: photo.externalThumbnailUrl,
    },
    deal: { id: "deal-1", name: "Audit Deal", dealNumber: "TR-1" },
  },
  {
    id: "audit-deleted",
    eventType: "deleted",
    userId: "admin-1",
    userName: "Admin User",
    userAvatarUrl: null,
    createdAt: "2026-05-05T15:04:00.000Z",
    ipAddress: "127.0.0.1",
    userAgent: "playwright",
    metadata: {},
    photo: null,
    deal: null,
  },
  {
    id: "audit-downloaded",
    eventType: "downloaded",
    userId: "admin-1",
    userName: "Admin User",
    userAvatarUrl: null,
    createdAt: "2026-05-05T15:03:00.000Z",
    ipAddress: "127.0.0.1",
    userAgent: "playwright",
    metadata: {},
    photo: null,
    deal: null,
  },
  {
    id: "audit-address",
    eventType: "address_changed",
    userId: "admin-1",
    userName: "Admin User",
    userAvatarUrl: null,
    createdAt: "2026-05-05T15:02:00.000Z",
    ipAddress: "127.0.0.1",
    userAgent: "playwright",
    metadata: { oldAddress: "100 Main St", newAddress: "200 Updated Ave" },
    photo: null,
    deal: null,
  },
  {
    id: "audit-category",
    eventType: "category_changed",
    userId: "admin-1",
    userName: "Admin User",
    userAvatarUrl: null,
    createdAt: "2026-05-05T15:01:00.000Z",
    ipAddress: "127.0.0.1",
    userAgent: "playwright",
    metadata: { oldCategory: "Damage", newCategory: "Safety" },
    photo: null,
    deal: null,
  },
  {
    id: "audit-uploaded",
    eventType: "uploaded",
    userId: "admin-1",
    userName: "Admin User",
    userAvatarUrl: null,
    createdAt: "2026-05-05T15:00:00.000Z",
    ipAddress: "127.0.0.1",
    userAgent: "playwright",
    metadata: { addressSource: "exif", hasGpsCoordinates: true, category: "damage", sizeBytes: 2048 },
    photo: null,
    deal: null,
  },
];

test("photo audit page opens a photo and shows the full history timeline", async ({ page }) => {
  await installCommonApiMocks(page);
  await page.route("**/api/admin/users", (route) => route.fulfill({ json: { users: [{ id: "admin-1", displayName: "Admin User", avatarUrl: null }] } }));
  await page.route("**/api/admin/photo-audit**", (route) => route.fulfill({
    json: { events: [auditEvents[0]], total: 1, page: 1, perPage: 50 },
  }));
  await page.route("**/api/files/photo-1", (route) => route.fulfill({ json: { file: photo } }));
  await page.route("**/api/files/photo-1/audit-log", (route) => route.fulfill({ json: { events: auditEvents } }));
  await page.route("**/api/files/photo-1/download", (route) => route.fulfill({ json: { url: "https://example.test/photo-1.jpg" } }));

  await page.goto("/admin/photo-audit?eventType=uploaded");
  await expect(page.getByRole("heading", { name: "Photo Audit" })).toBeVisible();
  await expect(page.getByText("Audit roof photo")).toBeVisible();

  await page.getByLabel("User filter").click();
  await page.getByRole("button", { name: "Admin User" }).click();
  await expect(page).toHaveURL(/userId=admin-1/);

  await page.getByLabel("Open photo Audit roof photo").click();
  await expect(page.getByText("Uploaded by")).toBeVisible();
  await page.getByText("History").click();
  await expect(page.getByText("Admin User restored this photo")).toBeVisible();
  await expect(page.getByText("Admin User deleted this photo")).toBeVisible();
  await expect(page.getByText("Admin User downloaded this photo")).toBeVisible();
  await expect(page.getByText("Admin User edited address")).toBeVisible();
  await expect(page.getByText("Admin User changed category from Damage to Safety")).toBeVisible();
  await expect(page.getByText("Admin User uploaded this photo")).toBeVisible();

  await page.getByLabel("Toggle details for category changed").click();
  await expect(page.getByText("oldCategory")).toBeVisible();
  await expect(page.locator("pre").filter({ hasText: "127.0.0.1" })).toBeVisible();
});
