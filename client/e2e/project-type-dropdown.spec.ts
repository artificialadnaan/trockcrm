import { expect, test } from "@playwright/test";
import { canonicalProjectTypes, installCommonApiMocks } from "./helpers/mock-api";

test("deal form project type dropdown lists the 9 canonical values in order", async ({ page }) => {
  await installCommonApiMocks(page);

  await page.goto("/deals/new");
  await page.getByText("Project Type").locator("..").getByRole("combobox").click();

  await expect(page.getByRole("option")).toHaveText(canonicalProjectTypes.map((type) => type.name));
});
