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

  await page.goto("/accept-invite?token=raw-token");
  await expect(page.getByText("field@example.com")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("password-123");
  await page.getByLabel("Confirm password").fill("password-123");
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByText("Welcome, Field.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Capture" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Profile" })).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByLabel("Email").fill(fieldUser.email);
  await page.getByLabel("Password", { exact: true }).fill("password-123");
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/home$/);

  const denied = await page.evaluate(async () => {
    const response = await fetch("/api/deals", { credentials: "include" });
    return { status: response.status, body: await response.json() };
  });
  expect(denied).toEqual({
    status: 403,
    body: { error: { message: "CRM access required" } },
  });
});
