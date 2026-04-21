import { expect, test } from "@playwright/test";

async function loginWithDevUser(page: import("@playwright/test").Page) {
  const request = page.context().request;
  const usersResponse = await request.get("/api/auth/dev/users");
  expect(usersResponse.ok()).toBeTruthy();
  const usersData = (await usersResponse.json()) as {
    users: Array<{ email: string; role: string }>;
  };
  const preferredEmail = process.env.PLAYWRIGHT_DEV_EMAIL?.trim().toLowerCase();
  const selectedUser =
    usersData.users.find((user) => user.email.toLowerCase() === preferredEmail) ??
    usersData.users.find((user) => user.role === "admin") ??
    usersData.users[0];

  expect(selectedUser).toBeDefined();

  const loginResponse = await request.post("/api/auth/dev/login", {
    data: { email: selectedUser!.email },
  });
  expect(loginResponse.ok()).toBeTruthy();
}

test("converts a qualified lead into opportunity and applies routing review", async ({ page }) => {
  await loginWithDevUser(page);

  const request = page.context().request;
  const stagesResponse = await request.get("/api/pipeline/stages?workflowFamily=lead");
  expect(stagesResponse.ok()).toBeTruthy();
  const stagesData = (await stagesResponse.json()) as {
    stages: Array<{ id: string; slug: string }>;
  };
  const qualifiedStage = stagesData.stages.find(
    (stage) => stage.slug === "qualified_for_opportunity"
  );
  expect(qualifiedStage).toBeDefined();

  const propertiesResponse = await request.get("/api/properties?limit=1");
  expect(propertiesResponse.ok()).toBeTruthy();
  const propertiesData = (await propertiesResponse.json()) as {
    properties: Array<{ id: string; companyId: string }>;
  };
  const property = propertiesData.properties[0];
  test.skip(!property, "At least one property must exist for Playwright workflow coverage.");

  const leadName = `PW Pipeline ${Date.now()}`;
  const leadResponse = await request.post("/api/leads", {
    data: {
      companyId: property.companyId,
      propertyId: property.id,
      stageId: qualifiedStage!.id,
      name: leadName,
    },
  });
  expect(leadResponse.ok()).toBeTruthy();
  const leadData = (await leadResponse.json()) as { lead: { id: string } };

  await page.goto(`/leads/${leadData.lead.id}`);
  await expect(page.getByText("Qualification Intake")).toBeVisible();
  await page.getByRole("button", { name: "Convert to Opportunity" }).click();
  await page.getByRole("button", { name: "Convert to Opportunity" }).last().click();

  await expect(page).toHaveURL(/\/deals\/.+$/);
  await expect(page.getByText("Routing and Ownership")).toBeVisible();
  await expect(page.getByText("Early Routing Review")).toBeVisible();

  await page.getByLabel("Sales Estimated Opportunity Value").fill("42000");
  await page.getByRole("button", { name: "Apply Early Review" }).click();

  await expect(page.getByText("Service Route")).toBeVisible();
  await expect(page.getByText("Accountable Department")).toBeVisible();
});
