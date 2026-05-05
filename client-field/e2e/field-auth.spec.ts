import { expect, test } from "@playwright/test";

const fieldUser = {
  id: "field-1",
  email: "field@example.com",
  firstName: "Field",
  lastName: "User",
  role: "field_contractor",
  tenantId: "office-1",
  active: true,
};

test("field invite acceptance, logout, login, and CRM route denial", async ({ page }) => {
  let signedIn = false;
  let acceptedPassword = "";
  let starred = false;
  const apiRequestUrls: string[] = [];
  const projects = [
    { id: "deal-1", name: "Roof Repair", dealNumber: "TR-1", propertyName: "Roof Repair", propertyAddress: "123 Main St", stage: "Contract", lastActivityAt: "2026-05-05T12:00:00.000Z", photoCount: 2, starred: false },
    { id: "deal-2", name: "Safety Walk", dealNumber: "TR-2", propertyName: "Safety Walk", propertyAddress: "456 Main St", stage: "Estimating", lastActivityAt: "2026-05-04T12:00:00.000Z", photoCount: 1, starred: false },
  ];
  const photos = [
    { id: "photo-1", category: "photo", photoCategory: "damage", subcategory: null, displayName: "Damage photo", mimeType: "image/jpeg", fileSizeBytes: 1000, fileExtension: ".jpg", dealId: "deal-1", description: "Damage area", takenAt: "2026-05-05T12:00:00.000Z", createdAt: "2026-05-05T12:00:00.000Z", uploadedBy: "field-1", uploaderName: "Field User", uploaderAvatarUrl: null, latitude: "35.1234567", longitude: "-97.1234567", address: "123 Main St", addressSource: "exif", geocodedAt: null, procoreSyncStatus: null, deletedAt: null, imageUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" },
    { id: "photo-2", category: "photo", photoCategory: "safety", subcategory: null, displayName: "Safety photo", mimeType: "image/jpeg", fileSizeBytes: 1000, fileExtension: ".jpg", dealId: "deal-1", description: "Safety rail", takenAt: "2026-05-04T12:00:00.000Z", createdAt: "2026-05-04T12:00:00.000Z", uploadedBy: "field-2", uploaderName: "Other User", uploaderAvatarUrl: null, latitude: "35.1234567", longitude: "-97.1234567", address: "123 Main St", addressSource: "live_gps", geocodedAt: null, procoreSyncStatus: null, deletedAt: null, imageUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" },
  ];

  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/")) apiRequestUrls.push(url);
  });

  await page.route("**/api/field/me", async (route) => {
    if (!signedIn) {
      await route.fulfill({ status: 401, json: { error: { message: "Authentication required" } } });
      return;
    }
    await route.fulfill({ json: { user: fieldUser } });
  });
  await page.route("**/api/auth/invite-preview?*", async (route) => {
    await route.fulfill({
      json: {
        firstName: fieldUser.firstName,
        lastName: fieldUser.lastName,
        email: fieldUser.email,
      },
    });
  });
  await page.route("**/api/auth/accept-invite", async (route) => {
    const body = route.request().postDataJSON() as { token: string; password: string };
    expect(body).toEqual({ token: "raw-token", password: "password-123" });
    acceptedPassword = body.password;
    signedIn = true;
    await route.fulfill({ json: { user: fieldUser, token: "jwt" } });
  });
  await page.route("**/api/auth/logout", async (route) => {
    signedIn = false;
    await route.fulfill({ json: { success: true } });
  });
  await page.route("**/api/auth/field-login", async (route) => {
    const body = route.request().postDataJSON() as { email: string; password: string };
    if (body.email === fieldUser.email && body.password === acceptedPassword) {
      signedIn = true;
      await route.fulfill({ json: { user: fieldUser, token: "jwt" } });
      return;
    }
    await route.fulfill({ status: 401, json: { error: { message: "Invalid email or password" } } });
  });
  await page.route("**/api/deals", async (route) => {
    await route.fulfill({ status: 403, json: { error: { message: "CRM access required" } } });
  });
  await page.route("**/api/files/deal/*/photos", async (route) => {
    await route.fulfill({ status: 403, json: { error: { message: "CRM access required" } } });
  });
  await page.route("**/api/field/projects?*", async (route) => {
    const url = new URL(route.request().url());
    const search = url.searchParams.get("search")?.toLowerCase() ?? "";
    const result = projects
      .filter((project) => !search || project.name.toLowerCase().includes(search) || project.propertyAddress.toLowerCase().includes(search))
      .map((project) => ({ ...project, starred: project.id === "deal-1" ? starred : project.starred }));
    await route.fulfill({ json: { projects: result, total: result.length, page: 1, perPage: 50 } });
  });
  await page.route("**/api/field/projects/starred", async (route) => {
    await route.fulfill({ json: { projects: starred ? [{ ...projects[0], starred: true }] : [] } });
  });
  await page.route("**/api/field/projects/deal-1/star", async (route) => {
    starred = route.request().method() === "POST";
    await route.fulfill({ json: { starred } });
  });
  await page.route("**/api/field/projects/deal-1/photos", async (route) => {
    await route.fulfill({ json: { photos, pagination: { page: 1, limit: 200, total: photos.length, totalPages: 1 } } });
  });

  await page.goto("/accept-invite?token=raw-token");
  await expect(page.getByText("field@example.com")).toBeVisible();
  expect(apiRequestUrls).toContain("http://mock-api.test/api/auth/invite-preview?token=raw-token");
  expect(apiRequestUrls.some((url) => url.startsWith(`${new URL(page.url()).origin}/api/`))).toBe(false);
  await page.getByLabel("Password", { exact: true }).fill("password-123");
  await page.getByLabel("Confirm password").fill("password-123");
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText("ALL ACTIVE")).toBeVisible();
  await expect(page.getByRole("link", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Capture" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Profile" })).toBeVisible();

  await page.getByRole("button", { name: "Search projects" }).click();
  await page.getByLabel("Search projects").fill("Safety");
  await expect(page.getByText("Safety Walk")).toBeVisible();
  await page.getByRole("button", { name: "Close search" }).click();
  await page.getByRole("button", { name: "Star project" }).first().click();
  await page.reload();
  await expect(page.getByText("STARRED")).toBeVisible();
  await page.getByRole("link", { name: /Open Roof Repair/ }).click();
  await expect(page).toHaveURL(/\/projects\/deal-1$/);
  await expect(page.getByText("Damage area")).toBeVisible();
  await page.getByRole("button", { name: "Damage", exact: true }).click();
  await expect(page.getByText("Safety rail")).not.toBeVisible();
  await page.getByRole("button", { name: "All categories" }).click();
  await expect(page.getByText("Safety rail")).toBeVisible();
  await page.getByText("Damage area").click();
  await expect(page.getByText("Coordinates")).toBeVisible();
  await page.getByRole("button", { name: "Next photo" }).click();
  await expect(page.getByRole("heading", { name: "Safety rail" })).toBeVisible();
  await page.getByRole("button", { name: "Close photo viewer" }).click();
  await page.getByRole("button", { name: "Back to projects" }).click();
  await expect(page).toHaveURL(/\/projects$/);

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByLabel("Email").fill(fieldUser.email);
  await page.getByLabel("Password", { exact: true }).fill("password-123");
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  expect(apiRequestUrls).toContain("http://mock-api.test/api/auth/field-login");

  const denied = await page.evaluate(async () => {
    const response = await fetch("http://mock-api.test/api/deals", { credentials: "include" });
    return { status: response.status, body: await response.json() };
  });
  expect(denied).toEqual({
    status: 403,
    body: { error: { message: "CRM access required" } },
  });

  const filesDenied = await page.evaluate(async () => {
    const response = await fetch("http://mock-api.test/api/files/deal/deal-1/photos", { credentials: "include" });
    return { status: response.status, body: await response.json() };
  });
  expect(filesDenied).toEqual({
    status: 403,
    body: { error: { message: "CRM access required" } },
  });
});
