import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  apiBaseURL,
  createIssueCollectors,
  createRoleApiContext,
  fetchJsonWithRetry,
  fetchResponseWithRetry,
  loginWithRole,
} from "./helpers";

test.use({ headless: false, viewport: { width: 1440, height: 1000 } });

type Company = { id: string; name: string };
type Property = { id: string; name: string };
type Contact = { id: string; firstName: string; lastName: string; companyId: string | null; category: string };
type Stage = { id: string; name: string; slug: string };
type ProjectType = { id: string; name: string; slug: string; isActive: boolean };
type Lead = {
  id: string;
  name: string;
  stageId: string;
  convertedDealId?: string | null;
  description?: string | null;
  leadQuestionnaire?: { answers: Record<string, unknown> } | null;
};
type Deal = { id: string; name: string; sourceLeadId: string | null; projectTypeId: string | null };
type QuestionnaireNode = {
  id: string;
  parentNodeId: string | null;
  parentOptionValue: string | null;
  nodeType: string;
  key: string;
  inputType: string | null;
  options: unknown;
  isRequired: boolean;
  isActive: boolean;
  displayOrder: number;
};
type Bundle = {
  company: Company;
  property: Property;
  projectType: ProjectType;
  newLeadStage: Stage;
  qualifiedLeadStage: Stage;
  salesValidationStage: Stage;
};

const manualDir = path.join(process.cwd(), "test-results", "manual-verification");

async function screenshot(page: import("@playwright/test").Page, name: string) {
  await mkdir(manualDir, { recursive: true });
  await page.screenshot({
    path: path.join(manualDir, `${process.env.MANUAL_PASS ?? "opportunity"}-${name}.png`),
    fullPage: true,
  });
}

function isTruthyRevealValue(value: unknown) {
  if (typeof value === "string") return value.trim().length > 0;
  return Boolean(value);
}

function isNodeVisible(
  node: QuestionnaireNode,
  nodeById: Map<string, QuestionnaireNode>,
  answers: Record<string, unknown>,
  visibleCache: Map<string, boolean>
): boolean {
  const cached = visibleCache.get(node.id);
  if (cached !== undefined) return cached;
  if (!node.parentNodeId) {
    visibleCache.set(node.id, true);
    return true;
  }
  const parent = nodeById.get(node.parentNodeId);
  if (!parent || !isNodeVisible(parent, nodeById, answers, visibleCache)) {
    visibleCache.set(node.id, false);
    return false;
  }
  const parentAnswer = answers[parent.key];
  const visible =
    node.parentOptionValue != null
      ? String(parentAnswer ?? "") === node.parentOptionValue
      : isTruthyRevealValue(parentAnswer);
  visibleCache.set(node.id, visible);
  return visible;
}

function getQuestionOptionEntries(options: unknown): { value: string; label: string }[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (typeof option === "string") return [{ value: option, label: option }];
    if (option && typeof option === "object" && "value" in option) {
      const value = (option as { value?: unknown }).value;
      if (typeof value !== "string") return [];
      const label = (option as { label?: unknown }).label;
      return [{ value, label: typeof label === "string" ? label : value }];
    }
    if (option && typeof option === "object" && "label" in option) {
      const label = (option as { label?: unknown }).label;
      return typeof label === "string" ? [{ value: label, label }] : [];
    }
    return [];
  });
}

function getVisibleQuestionNodes(nodes: QuestionnaireNode[], answers: Record<string, unknown>) {
  const questions = nodes.filter((node) => node.nodeType === "question" && node.isActive);
  const nodeById = new Map(questions.map((node) => [node.id, node]));
  const visibleCache = new Map<string, boolean>();
  return questions
    .filter((node) => isNodeVisible(node, nodeById, answers, visibleCache))
    .sort((left, right) => left.displayOrder - right.displayOrder);
}

function getQuestionAnswerValue(node: QuestionnaireNode) {
  const inputType = node.inputType ?? "text";
  if (inputType === "boolean") return false;
  if (inputType === "select" || (Array.isArray(node.options) && node.options.length > 0)) {
    return getQuestionOptionEntries(node.options)[0]?.value ?? "AUDIT_TEST option";
  }
  if (inputType === "date") return "2026-06-01";
  if (inputType === "number" || inputType === "currency") return 1;
  return `AUDIT_TEST ${node.key}`;
}

async function buildRequiredAnswers(projectTypeId: string) {
  const apiRequest = await createRoleApiContext("rep");
  try {
    const template = await fetchJsonWithRetry<{
      questionnaire: { nodes: QuestionnaireNode[] } | null;
    }>(
      apiRequest,
      `${apiBaseURL}/api/leads/questionnaire-template?projectTypeId=${projectTypeId}`
    );
    const nodes = template.questionnaire?.nodes ?? [];
    const answers: Record<string, unknown> = {};
    for (let pass = 0; pass < 4; pass += 1) {
      const visibleRequired = getVisibleQuestionNodes(nodes, answers).filter((node) => node.isRequired);
      for (const node of visibleRequired) {
        if (!(node.key in answers)) {
          answers[node.key] = getQuestionAnswerValue(node);
        }
      }
    }
    return answers;
  } finally {
    await apiRequest.dispose();
  }
}

async function createBundle(): Promise<Bundle> {
  const apiRequest = await createRoleApiContext("rep");
  try {
    const suffix = Date.now();
    const companyData = await fetchJsonWithRetry<{ company: Company }>(
      apiRequest,
      `${apiBaseURL}/api/companies`,
      {
        method: "POST",
        data: {
          name: `AUDIT_TEST_OppScope_Company_${suffix}`,
          category: "other",
          notes: "AUDIT_TEST opportunity scoping manual verification",
        },
      }
    );
    const propertyData = await fetchJsonWithRetry<{ property: Property }>(
      apiRequest,
      `${apiBaseURL}/api/properties`,
      {
        method: "POST",
        data: {
          companyId: companyData.company.id,
          name: `AUDIT_TEST_OppScope_Property_${suffix}`,
          address: "100 Audit Way",
          city: "Dallas",
          state: "TX",
          zip: "75001",
        },
      }
    );
    const [projectTypesData, stagesData] = await Promise.all([
      fetchJsonWithRetry<{ projectTypes: ProjectType[] }>(
        apiRequest,
        `${apiBaseURL}/api/pipeline/project-types`
      ),
      fetchJsonWithRetry<{ stages: Stage[] }>(
        apiRequest,
        `${apiBaseURL}/api/pipeline/stages?workflowFamily=lead`
      ),
    ]);
    const projectType = projectTypesData.projectTypes.find(
      (item) => item.slug === "traditional_multifamily"
    );
    const newLeadStage = stagesData.stages.find((item) => item.slug === "new_lead");
    const qualifiedLeadStage = stagesData.stages.find((item) => item.slug === "qualified_lead");
    const salesValidationStage = stagesData.stages.find(
      (item) => item.slug === "sales_validation_stage"
    );
    expect(projectType).toBeDefined();
    expect(newLeadStage).toBeDefined();
    expect(qualifiedLeadStage).toBeDefined();
    expect(salesValidationStage).toBeDefined();

    return {
      company: companyData.company,
      property: propertyData.property,
      projectType: projectType!,
      newLeadStage: newLeadStage!,
      qualifiedLeadStage: qualifiedLeadStage!,
      salesValidationStage: salesValidationStage!,
    };
  } finally {
    await apiRequest.dispose();
  }
}

async function createConvertibleLead(bundle: Bundle, cleanup: { leadIds: string[]; dealIds: string[] }) {
  const answers = await buildRequiredAnswers(bundle.projectType.id);
  const apiRequest = await createRoleApiContext("rep");
  try {
    const suffix = Date.now();
    const created = await fetchJsonWithRetry<{ lead: Lead }>(apiRequest, `${apiBaseURL}/api/leads`, {
      method: "POST",
      data: {
        companyId: bundle.company.id,
        propertyId: bundle.property.id,
        stageId: bundle.newLeadStage.id,
        name: `AUDIT_TEST_OppScope_Lead_${suffix}`,
        sourceCategory: "Referral",
        projectTypeId: bundle.projectType.id,
        description: "AUDIT_TEST original lead description",
        qualificationPayload: {
          estimated_value: 125000,
          timeline_status: "Q3 2026",
        },
        leadQuestionAnswers: answers,
      },
    });
    cleanup.leadIds.push(created.lead.id);
    await fetchJsonWithRetry(apiRequest, `${apiBaseURL}/api/leads/${created.lead.id}`, {
      method: "PATCH",
      data: {
        stageId: bundle.qualifiedLeadStage.id,
        qualificationPayload: {
          estimated_value: 125000,
          timeline_status: "Q3 2026",
        },
        leadQuestionAnswers: answers,
      },
    });
    await fetchJsonWithRetry(apiRequest, `${apiBaseURL}/api/leads/${created.lead.id}`, {
      method: "PATCH",
      data: {
        stageId: bundle.salesValidationStage.id,
        qualificationPayload: {
          estimated_value: 125000,
          timeline_status: "Q3 2026",
        },
        leadQuestionAnswers: answers,
      },
    });
    await fetchJsonWithRetry(apiRequest, `${apiBaseURL}/api/files/upload-direct`, {
      method: "POST",
      headers: {
        "content-type": "image/jpeg",
        "x-original-filename": encodeURIComponent(`AUDIT_TEST_lead_photo_${suffix}.jpg`),
        "x-file-category": "photo",
        "x-lead-id": created.lead.id,
      },
      data: Buffer.from("AUDIT_TEST lead photo"),
    });
    const converted = await fetchJsonWithRetry<{ lead: Lead; deal: Deal }>(
      apiRequest,
      `${apiBaseURL}/api/leads/${created.lead.id}/convert`,
      { method: "POST", data: {} }
    );
    cleanup.dealIds.push(converted.deal.id);
    return { lead: converted.lead, deal: converted.deal };
  } finally {
    await apiRequest.dispose();
  }
}

test.describe.serial("opportunity scoping phase 3 manual verification", () => {
  let bundle: Bundle;
  const cleanup: { leadIds: string[]; dealIds: string[] } = { leadIds: [], dealIds: [] };

  test.beforeAll(async () => {
    bundle = await createBundle();
  });

  test.afterAll(async () => {
    const adminRequest = await createRoleApiContext("admin");
    const repRequest = await createRoleApiContext("rep");
    try {
      for (const dealId of cleanup.dealIds) {
        await fetchResponseWithRetry(adminRequest, `${apiBaseURL}/api/deals/${dealId}`, {
          method: "DELETE",
        });
      }
      for (const leadId of cleanup.leadIds) {
        await fetchResponseWithRetry(repRequest, `${apiBaseURL}/api/leads/${leadId}`, {
          method: "DELETE",
        });
      }
    } finally {
      await adminRequest.dispose();
      await repRequest.dispose();
    }
  });

  test("lead-to-opportunity lineage, autosave, inline contact, DealLeadTab, and photo lineage work on production", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const issues = createIssueCollectors(page);
    const apiRequest = await createRoleApiContext("rep");
    await loginWithRole(page, "rep");

    try {
      await page.goto(
        `/leads/new?companyId=${bundle.company.id}&propertyId=${bundle.property.id}&projectTypeId=${bundle.projectType.id}`,
        { waitUntil: "domcontentloaded" }
      );
      await expect(page.getByRole("heading", { name: "New Lead", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "+ Add new contact", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Add Primary Contact" })).toBeVisible();
      await page.locator("#newContactFirstName").fill("Audit");
      await page.locator("#newContactLastName").fill("Contact");
      await page.locator("#newContactEmail").fill(`audit.contact.${Date.now()}@example.com`);
      await page.locator("#newContactPhone").fill("555-0100");
      await page.locator("#newContactTitle").fill("Property Manager");
      await expect(page.locator("#newContactCategory")).toContainText("Client");
      await page.getByRole("button", { name: "Save Contact", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Add Primary Contact" })).toHaveCount(0);
      await expect(page.locator("#primaryContactId")).toContainText("Audit Contact");
      const contacts = await fetchJsonWithRetry<{ contacts: Contact[] }>(
        apiRequest,
        `${apiBaseURL}/api/contacts?companyId=${bundle.company.id}&search=Audit%20Contact&limit=10`
      );
      const createdContact = contacts.contacts.find((contact) => contact.firstName === "Audit");
      expect(createdContact?.companyId).toBe(bundle.company.id);
      expect(createdContact?.category).toBe("client");
      await screenshot(page, "09-inline-contact-created-with-company-and-category");

      const { lead, deal } = await createConvertibleLead(bundle, cleanup);

      const searchTargets = await fetchJsonWithRetry<{ targets: Array<{ id: string; type: string; name: string }> }>(
        apiRequest,
        `${apiBaseURL}/api/files/photo-targets/search?search=${encodeURIComponent(bundle.company.name)}&limit=20`
      );
      expect(searchTargets.targets.some((target) => target.type === "lead" && target.name === lead.name)).toBe(true);
      expect(searchTargets.targets.some((target) => target.type === "deal" && target.id === deal.id)).toBe(true);

      await page.goto(`/photos/capture`, { waitUntil: "domcontentloaded" });
      await page.getByPlaceholder("Search leads, opportunities, and deals").fill(bundle.company.name);
      await expect(page.getByText("Leads", { exact: true })).toBeVisible();
      await expect(page.getByText("Deals", { exact: true })).toBeVisible();
      await screenshot(page, "10-global-photo-search-categorized-targets");

      await page.goto(`/deals/${deal.id}?tab=scoping`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Scoping Workspace", { exact: true })).toBeVisible();
      await expect(page.locator("#workflowRoute")).toContainText("Standard");
      await expect(page.locator("#projectTypeId")).toContainText(bundle.projectType.name);
      await expect(page.locator("#propertyName")).toContainText(bundle.property.name);
      await expect(page.getByText("100 Audit Way", { exact: false }).first()).toBeVisible();
      await screenshot(page, "11-field-lineage-populates-opportunity-scoping");

      let parentDealFetches = 0;
      page.on("response", (response) => {
        if (
          response.request().method() === "GET" &&
          response.url() === `${apiBaseURL}/api/deals/${deal.id}`
        ) {
          parentDealFetches += 1;
        }
      });
      const summarySave = page.waitForResponse(
        (response) =>
          response.url() === `${apiBaseURL}/api/deals/${deal.id}/resolved-fields` &&
          response.request().method() === "PATCH" &&
          response.ok()
      );
      await page.locator("#scopeSummary").fill("AUDIT_TEST updated from opportunity scoping autosave");
      await summarySave;
      await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
      const bidDueDateSave = page.waitForResponse(
        (response) =>
          response.url() === `${apiBaseURL}/api/deals/${deal.id}/resolved-fields` &&
          response.request().method() === "PATCH" &&
          response.ok()
      );
      await page.locator("#bidDueDate").fill("2026-07-15");
      await bidDueDateSave;
      await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(async () => {
          const detail = await fetchJsonWithRetry<{ lead: Lead }>(
            apiRequest,
            `${apiBaseURL}/api/leads/${lead.id}`
          );
          return {
            description: detail.lead.description,
            bidDueDate: detail.lead.leadQuestionnaire?.answers.bid_due_date,
          };
        })
        .toEqual({
          description: "AUDIT_TEST updated from opportunity scoping autosave",
          bidDueDate: "2026-07-15",
        });
      expect(parentDealFetches).toBe(0);
      await screenshot(page, "12-autosave-persists-lineage-fields-without-parent-refetch");

      await page.getByRole("button", { name: "Lead", exact: true }).click();
      await expect(page.getByText(lead.name, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "View Source Lead", exact: true })).toBeVisible();
      await screenshot(page, "13-deal-lead-tab-renders-source-lead");

      await page.getByRole("button", { name: "Files", exact: true }).click();
      const files = await fetchJsonWithRetry<{
        files: Array<{
          displayName: string;
          fileExtension: string;
          originalFilename: string;
          leadId: string | null;
        }>;
      }>(
        apiRequest,
        `${apiBaseURL}/api/files?dealId=${deal.id}&limit=25`
      );
      const leadPhoto = files.files.find(
        (file) => file.leadId === lead.id && file.originalFilename.startsWith("AUDIT_TEST_lead_photo_")
      );
      expect(leadPhoto).toBeDefined();
      await expect(page.getByText(`${leadPhoto!.displayName}${leadPhoto!.fileExtension}`, { exact: true })).toBeVisible();
      await screenshot(page, "14-lead-photo-visible-on-deal-files-tab");

      issues.assertClean();
    } finally {
      await apiRequest.dispose();
    }
  });
});
