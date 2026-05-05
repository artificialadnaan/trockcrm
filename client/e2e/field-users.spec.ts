import { expect, test } from "@playwright/test";
import { installCommonApiMocks } from "./helpers/mock-api";

type FieldUserRow = {
  id: string;
  userId: string | null;
  inviteId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  inviteStatus: "accepted" | "pending" | "expired" | "revoked";
  invitedBy: { id: string; name: string } | null;
  invitedAt: string | null;
  acceptedAt: string | null;
  expiresAt: string | null;
};

test("admin invites a field user and sees the accepted user after invite acceptance", async ({ page }) => {
  await installCommonApiMocks(page);

  let capturedInviteToken = "";
  const rows: FieldUserRow[] = [];

  await page.route("**/api/admin/field-users**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === "GET") {
      return route.fulfill({ json: { users: rows, total: rows.length, page: 1, perPage: 25 } });
    }

    if (url.pathname.endsWith("/api/admin/field-users/invite") && request.method() === "POST") {
      const body = request.postDataJSON() as { email: string; firstName: string; lastName: string; phone?: string };
      capturedInviteToken = "playwright-field-invite-token";
      rows.push({
        id: "invite-1",
        userId: null,
        inviteId: "invite-1",
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone ?? null,
        active: false,
        createdAt: "2026-05-05T12:00:00.000Z",
        lastLoginAt: null,
        inviteStatus: "pending",
        invitedBy: { id: "admin-1", name: "Admin User" },
        invitedAt: "2026-05-05T12:00:00.000Z",
        acceptedAt: null,
        expiresAt: "2026-05-12T12:00:00.000Z",
      });
      return route.fulfill({ json: { invite: { id: "invite-1", email: body.email, expiresAt: "2026-05-12T12:00:00.000Z" } } });
    }

    return route.fulfill({ status: 404, json: { error: { message: "Unhandled field-users mock route" } } });
  });

  await page.route("**/api/auth/accept-invite", async (route) => {
    const body = route.request().postDataJSON() as { token: string; password: string };
    expect(body.token).toBe(capturedInviteToken);
    expect(body.password).toBe("StrongPassword12!");

    const row = rows[0]!;
    row.id = "field-user-1";
    row.userId = "field-user-1";
    row.active = true;
    row.inviteStatus = "accepted";
    row.acceptedAt = "2026-05-05T12:15:00.000Z";

    return route.fulfill({
      json: {
        user: {
          id: "field-user-1",
          email: row.email,
          displayName: `${row.firstName} ${row.lastName}`,
          role: "field_contractor",
          officeId: "office-1",
          activeOfficeId: "office-1",
          mustChangePassword: false,
        },
        token: "field-jwt",
      },
    });
  });

  await page.goto("/admin/field-users");
  await expect(page.getByRole("heading", { name: "Field Users" })).toBeVisible();

  await page.getByRole("button", { name: "Invite field user" }).click();
  await page.getByPlaceholder("Email").fill("field.new@example.com");
  await page.getByPlaceholder("First name").fill("Field");
  await page.getByPlaceholder("Last name").fill("New");
  await page.getByPlaceholder("Phone (optional)").fill("555-1212");
  await page.getByRole("button", { name: "Send field user invite" }).click();

  await expect(page.getByText("Invite sent to field.new@example.com")).toBeVisible();
  await expect(page.getByRole("cell", { name: "field.new@example.com" })).toBeVisible();
  await expect(page.getByRole("table").getByText("Pending Invite")).toBeVisible();
  expect(capturedInviteToken).toBe("playwright-field-invite-token");

  await page.evaluate(async (token) => {
    const response = await fetch("/api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "StrongPassword12!" }),
    });
    if (!response.ok) throw new Error(`accept-invite failed: ${response.status}`);
  }, capturedInviteToken);

  await page.reload();
  await expect(page.getByRole("cell", { name: "field.new@example.com" })).toBeVisible();
  await expect(page.getByRole("table").getByText("Active")).toBeVisible();
  await expect(page.getByRole("table").getByText("Pending Invite")).toHaveCount(0);
});
