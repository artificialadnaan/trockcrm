import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const targetUrl = (process.env.TARGET_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "");
const authMode = process.env.AUTH_MODE ?? "dev-picker";
const authEmail = process.env.AUTH_EMAIL ?? (authMode === "dev-picker" ? "admin@trock.dev" : "");
const authPassword = process.env.AUTH_PASSWORD ?? "";
const targetTestUserEmail = process.env.TARGET_TEST_USER_EMAIL ?? "rep@trock.dev";
const headless = process.env.HEADLESS !== "false";

const reportPath = path.resolve(
  process.cwd(),
  "docs/superpowers/reports/2026-04-20-admin-users-volume-validation.md",
);
const screenshotDir = path.resolve(process.cwd(), "output/playwright");
const screenshotPath = path.join(screenshotDir, "admin-users-volume-validation.png");

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function writeReport(summary) {
  const lines = [
    "# Admin Users Volume Validation",
    "",
    `- Run at: ${summary.executedAt}`,
    `- Target URL: ${summary.targetUrl}`,
    `- Auth mode: ${summary.authMode}`,
    `- Target test user: ${summary.targetTestUserEmail}`,
    `- Result: ${summary.ok ? "PASS" : "FAIL"}`,
    `- Screenshot: ${summary.screenshotPath}`,
    "",
    "## Checks",
    "",
    ...summary.checks.map((check) => `- ${check}`),
  ];

  if (summary.errorMessage) {
    lines.push("", "## Error", "", `- ${summary.errorMessage}`);
  }

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");
}

async function login(page, checks) {
  await page.goto(`${targetUrl}/admin/users`, { waitUntil: "load" });

  if (await page.getByRole("heading", { name: "Users" }).isVisible().catch(() => false)) {
    checks.push("Admin users page opened without an interactive login prompt.");
    return;
  }

  if (authMode === "dev-picker") {
    invariant(authEmail, "AUTH_EMAIL is required for dev-picker mode.");
    const devButton = page.getByRole("button", { name: new RegExp(authEmail, "i") });
    await devButton.waitFor({ state: "visible" });
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes("/api/auth/dev/login") && response.ok(),
        { timeout: 15000 },
      ),
      devButton.click(),
    ]);
    checks.push(`Signed in through dev-picker as ${authEmail}.`);
  } else if (authMode === "local-credentials") {
    invariant(authEmail, "AUTH_EMAIL is required for local-credentials mode.");
    invariant(authPassword, "AUTH_PASSWORD is required for local-credentials mode.");
    await page.getByLabel("Email").fill(authEmail);
    await page.getByLabel("Password").fill(authPassword);
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes("/api/auth/local/login") && response.ok(),
        { timeout: 15000 },
      ),
      page.getByRole("button", { name: /^sign in$/i }).click(),
    ]);
    checks.push(`Signed in with local credentials as ${authEmail}.`);
  } else {
    throw new Error(`Unsupported AUTH_MODE: ${authMode}`);
  }

  await page.waitForFunction(
    () => {
      return document.body.innerText.includes("Dashboard")
        || document.body.innerText.includes("Users");
    },
    { timeout: 15000 },
  );
  await page.goto(`${targetUrl}/admin/users`, { waitUntil: "load" });
  await page.getByRole("heading", { name: "Users" }).waitFor({ state: "visible" });
}

async function validateAdminUsers(page, checks) {
  await page.getByRole("heading", { name: "Users" }).waitFor({ state: "visible" });
  checks.push("Users page heading is visible.");

  for (const label of ["Loaded", "Roles", "Invites Pending", "Selected"]) {
    await page.getByText(label, { exact: true }).waitFor({ state: "visible" });
  }
  checks.push("Summary cards rendered.");

  await page.getByPlaceholder("Search by name or email").waitFor({ state: "visible" });
  for (const label of ["Role", "Status", "Source", "Login"]) {
    await page.locator("label", { hasText: label }).waitFor({ state: "visible" });
  }
  checks.push("Search and filter controls rendered.");

  const searchInput = page.getByPlaceholder("Search by name or email");
  await searchInput.fill(targetTestUserEmail);
  await page.getByText(targetTestUserEmail, { exact: true }).waitFor({ state: "visible" });
  checks.push(`Located target user row for ${targetTestUserEmail}.`);

  const targetRow = page.locator("tr", { has: page.getByText(targetTestUserEmail, { exact: true }) }).first();
  await targetRow.waitFor({ state: "visible" });

  await targetRow.getByRole("button", { name: /preview/i }).click();
  await page.getByRole("heading", { name: "Invite Preview" }).waitFor({ state: "visible" });
  await page.getByText("This preview never sends email.", { exact: false }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("heading", { name: "Invite Preview" }).waitFor({ state: "hidden" });
  checks.push("Invite preview dialog opened and closed without sending email.");

  await targetRow.getByRole("button", { name: /history/i }).click();
  await page.getByRole("heading", { name: "Local Auth History" }).waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Local Auth History" }).waitFor({ state: "hidden" });
  checks.push("Local-auth history dialog opened and closed.");

  await targetRow.getByRole("button", { name: /send invite|resend invite/i }).waitFor({ state: "visible" });
  checks.push("Invite send control is present and was not activated.");
}

async function main() {
  invariant(
    authMode === "dev-picker" || targetTestUserEmail,
    "TARGET_TEST_USER_EMAIL is required outside dev-picker mode.",
  );

  const checks = [];
  const executedAt = nowIso();
  let browser;

  try {
    await fs.mkdir(screenshotDir, { recursive: true });
    browser = await chromium.launch({ headless });
    const page = await browser.newPage();

    await login(page, checks);
    await validateAdminUsers(page, checks);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    await writeReport({
      executedAt,
      targetUrl,
      authMode,
      targetTestUserEmail,
      ok: true,
      screenshotPath,
      checks,
      errorMessage: null,
    });

    console.log("PASS: admin users volume validation");
    for (const check of checks) console.log(`- ${check}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await writeReport({
      executedAt,
      targetUrl,
      authMode,
      targetTestUserEmail,
      ok: false,
      screenshotPath,
      checks,
      errorMessage,
    });
    console.error(`FAIL: ${errorMessage}`);
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}

await main();
