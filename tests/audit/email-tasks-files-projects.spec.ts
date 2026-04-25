import { expect, test } from "@playwright/test";

import {
  apiBaseURL,
  createIssueCollectors,
  createRoleApiContext,
  fetchJsonWithRetry,
  loginWithRole,
} from "./helpers";

type AuditDeal = {
  id: string;
  dealNumber: string;
  name: string;
};

type AuditTask = {
  id: string;
  title: string;
  status: string;
  dealId: string | null;
};

type AuditFile = {
  id: string;
  displayName: string;
  originalFilename: string;
  dealId: string | null;
  createdAt?: string;
};

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadAuditDeal() {
  const apiRequest = await createRoleApiContext("rep");

  try {
    const data = await fetchJsonWithRetry<{
      deals: AuditDeal[];
      pagination: { total: number };
    }>(apiRequest, `${apiBaseURL}/api/deals?search=AUDIT_TEST_&limit=20`);

    const deal = data.deals.find((entry) => entry.name.includes("AUDIT_TEST_Lead"));
    expect(deal, "No AUDIT_TEST_ deal is available for the production audit").toBeDefined();
    return deal!;
  } finally {
    await apiRequest.dispose();
  }
}

async function findTaskByTitle(title: string, dealId?: string) {
  const apiRequest = await createRoleApiContext("rep");

  try {
    const data = await fetchJsonWithRetry<{
      tasks: AuditTask[];
      pagination: { total: number };
    }>(
      apiRequest,
      `${apiBaseURL}/api/tasks?limit=100${dealId ? `&dealId=${dealId}` : ""}`
    );

    return data.tasks.find((task) => task.title === title) ?? null;
  } finally {
    await apiRequest.dispose();
  }
}

async function waitForTaskByTitle(title: string, dealId?: string, attempts = 10) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const task = await findTaskByTitle(title, dealId);
    if (task) return task;
    await wait(300 * attempt);
  }

  throw new Error(`Task ${title} was not persisted`);
}

async function dismissTaskById(taskId: string) {
  const apiRequest = await createRoleApiContext("rep");

  try {
    await fetchJsonWithRetry<{ task: AuditTask }>(apiRequest, `${apiBaseURL}/api/tasks/${taskId}/dismiss`, {
      method: "POST",
    });
  } finally {
    await apiRequest.dispose();
  }
}

async function findFilesForDeal(dealId: string, search?: string) {
  const apiRequest = await createRoleApiContext("admin");

  try {
    const data = await fetchJsonWithRetry<{
      files: AuditFile[];
      pagination: { total: number };
    }>(
      apiRequest,
      `${apiBaseURL}/api/files?dealId=${dealId}&limit=50${
        search ? `&search=${encodeURIComponent(search)}` : ""
      }`
    );

    return data.files;
  } finally {
    await apiRequest.dispose();
  }
}

async function waitForFilesForDealCount(dealId: string, expectedCount: number, attempts = 10) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const files = await findFilesForDeal(dealId);
    if (files.length === expectedCount) return files;
    await wait(300 * attempt);
  }

  throw new Error(`Deal ${dealId} did not reach expected file count ${expectedCount}`);
}

async function deleteFileById(fileId: string) {
  const apiRequest = await createRoleApiContext("admin");

  try {
    await fetchJsonWithRetry(apiRequest, `${apiBaseURL}/api/files/${fileId}`, {
      method: "DELETE",
    });
  } finally {
    await apiRequest.dispose();
  }
}

test.describe.serial("email / tasks / files / projects production audit", () => {
  let auditDeal: AuditDeal;

  test.beforeAll(async () => {
    auditDeal = await loadAuditDeal();
  });

  test("rep can load email, validate compose requirements, and stay clean", async ({ page }) => {
    const issues = createIssueCollectors(page);

    await loginWithRole(page, "rep");
    await page.goto("/email", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Email", exact: true })).toBeVisible();
    await expect(page.getByText("No emails yet. Connect your Microsoft account or compose your first email.")).toBeVisible();

    await page.getByRole("button", { name: "Compose", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Compose Email", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Recipient is required", { exact: true })).toBeVisible();

    await page.getByLabel("To").fill("audit@example.com");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Subject is required", { exact: true })).toBeVisible();

    await page.getByLabel("Subject").fill("AUDIT_TEST subject");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Message body is required", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    issues.assertClean();
  });

  test("rep can create an AUDIT_TEST task linked to the audit deal and dismiss it for cleanup", async ({ page }) => {
    const issues = createIssueCollectors(page);
    const taskTitle = `AUDIT_TEST_Task_${Date.now()}`;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dueDate = tomorrow.toISOString().slice(0, 10);
    let createdTaskId: string | null = null;

    await loginWithRole(page, "rep");

    try {
      await page.goto("/tasks", { waitUntil: "domcontentloaded" });

      await expect(page.getByRole("heading", { name: "Tasks & Deliverables", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "New Task", exact: true }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByPlaceholder("Task title").fill(taskTitle);
      await dialog.locator('input[type="date"]').fill(dueDate);

      await dialog.getByRole("combobox").nth(1).click();
      await page.getByRole("option", { name: `${auditDeal.dealNumber} - ${auditDeal.name}` }).click();

      await dialog.getByRole("button", { name: "Create Task", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page.getByText(taskTitle, { exact: true })).toBeVisible();

      const createdTask = await waitForTaskByTitle(taskTitle, auditDeal.id);
      createdTaskId = createdTask.id;
    } finally {
      if (createdTaskId) {
        await dismissTaskById(createdTaskId);
      }
    }

    issues.assertClean();
  });

  test("admin can upload and delete an AUDIT_TEST file from the global file browser", async ({ page }) => {
    const issues = createIssueCollectors(page);
    const filename = `AUDIT_TEST_file_${Date.now()}.txt`;
    const baselineFiles = await findFilesForDeal(auditDeal.id);
    const baselineIds = new Set(baselineFiles.map((file) => file.id));

    await loginWithRole(page, "admin");
    await page.goto("/files", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Project Files", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Upload File", exact: true }).click();

    await page.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: `${auditDeal.dealNumber} — ${auditDeal.name}` }).click();

    await page.locator('input[type="file"]').setInputFiles({
      name: filename,
      mimeType: "text/plain",
      buffer: Buffer.from(`audit upload for ${auditDeal.dealNumber}`),
    });

    await expect(page.getByText(filename, { exact: true })).toBeVisible();
    await expect(page.getByText("Clear completed", { exact: true })).toBeVisible();

    const uploadedFiles = await waitForFilesForDealCount(auditDeal.id, baselineFiles.length + 1);
    const uploadedFile = uploadedFiles.find((file) => !baselineIds.has(file.id));
    expect(uploadedFile, `Uploaded file for ${auditDeal.dealNumber} should be identifiable`).toBeDefined();

    await page.getByPlaceholder("Filename…").fill(auditDeal.dealNumber);
    await expect(page.getByText(auditDeal.dealNumber, { exact: true })).toBeVisible();

    await deleteFileById(uploadedFile!.id);
    await waitForFilesForDealCount(auditDeal.id, baselineFiles.length);

    issues.assertClean();
  });

  test("rep can load the empty projects list without console or network failures", async ({ page }) => {
    const issues = createIssueCollectors(page);

    await loginWithRole(page, "rep");

    await page.goto("/projects", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Procore Projects", exact: true })).toBeVisible();
    await expect(page.getByText("No Procore-linked projects found", { exact: true })).toBeVisible();

    issues.assertClean();
  });

  test("rep sees the project not found state for an invalid project id", async ({ page }) => {
    await loginWithRole(page, "rep");

    await page.goto("/projects/non-existent-audit-project", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Project not found", { exact: true })).toBeVisible();
  });
});
