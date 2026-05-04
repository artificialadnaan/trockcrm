import { expect, test, type Page } from "@playwright/test";

const routes = ["/deals", "/leads", "/contacts", "/tasks", "/reports"];

async function loginAsAdmin(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /admin@trock\.dev/i }).click();
  await expect(page.getByText(/T Rock CRM|Dashboard|Pipeline|Active Leads/i).first()).toBeVisible();
}

async function authenticateAsAdmin(page: Page) {
  const response = await page.request.post("/api/auth/dev/login", {
    headers: { Origin: new URL(page.url() || "http://localhost:30011").origin },
    data: { email: "admin@trock.dev" },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
}

function readCookieValue(cookieString: string, name: string): string | undefined {
  return cookieString
    .split("; ")
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function browserPost(page: Page, path: string, body: Record<string, unknown>) {
  return page.evaluate(
    async ({ requestPath, payload }) => {
      const csrfToken = document.cookie
        .split("; ")
        .find((entry) => entry.startsWith("csrf_token="))
        ?.slice("csrf_token=".length);
      const response = await fetch(requestPath, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "X-CSRF-Token": decodeURIComponent(csrfToken) } : {}),
        },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      return { status: response.status, text };
    },
    { requestPath: path, payload: body }
  );
}

test("login flow uses local dev login and reaches the authenticated app", async ({ page }) => {
  await loginAsAdmin(page);
  const me = await page.request.get("/api/auth/me");
  expect(me.ok()).toBeTruthy();
});

test("authenticated GET pages render without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await authenticateAsAdmin(page);
  errors.length = 0;
  for (const route of routes) {
    await page.goto(route);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("body")).toBeVisible();
  }

  expect(errors.filter((error) => !/Failed to load (regions|stages|task counts)/.test(error))).toEqual([]);
});

test("authenticated POST accepts the browser CSRF token round trip", async ({ page }) => {
  await authenticateAsAdmin(page);
  const suffix = Date.now();
  const result = await browserPost(page, "/api/contacts", {
    firstName: "TrackB",
    lastName: `Smoke${suffix}`,
    email: `track-b-${suffix}@example.test`,
    category: "client",
    skipDedupCheck: true,
  });

  expect(result.status).toBe(201);
  expect(result.text).toContain("TrackB");
});

test("stage write path is not rejected by CSRF when same-origin token is present", async ({ page }) => {
  await authenticateAsAdmin(page);
  const result = await page.evaluate(async () => {
    const csrfToken = document.cookie
      .split("; ")
      .find((entry) => entry.startsWith("csrf_token="))
      ?.slice("csrf_token=".length);
    const response = await fetch("/api/deals/00000000-0000-0000-0000-000000000000/stage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(csrfToken ? { "X-CSRF-Token": decodeURIComponent(csrfToken) } : {}),
      },
      credentials: "include",
      body: JSON.stringify({ targetStageId: "00000000-0000-0000-0000-000000000001" }),
    });
    return { status: response.status, body: await response.text() };
  });

  expect(result.status).not.toBe(403);
});

test("cross-origin cookie-authenticated POST is blocked", async ({ page }) => {
  await authenticateAsAdmin(page);
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const csrfToken = readCookieValue(cookieHeader, "csrf_token");

  const response = await page.request.post("/api/auth/logout", {
    headers: {
      Cookie: cookieHeader,
      Origin: "http://evil.example.com",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
  });

  expect(response.status()).toBe(403);
});

test("navigation sweep records no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await authenticateAsAdmin(page);
  errors.length = 0;
  for (const route of ["/", ...routes]) {
    await page.goto(route);
    await page.waitForLoadState("domcontentloaded");
  }

  expect(errors).toEqual([]);
});
