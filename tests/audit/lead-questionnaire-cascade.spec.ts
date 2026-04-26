import { expect, test } from "@playwright/test";

import {
  apiBaseURL,
  createRoleApiContext,
  fetchJsonWithRetry,
  loginWithRole,
} from "./helpers";

type AuditCompany = {
  id: string;
  name: string;
};

type AuditProperty = {
  id: string;
  name: string;
};

type AuditStage = {
  id: string;
  name: string;
  slug: string;
};

type AuditProjectType = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  isActive: boolean;
};

type LeadQuestionnaireNode = {
  id: string;
  projectTypeId: string | null;
  parentNodeId: string | null;
  parentOptionValue: string | null;
  nodeType: string;
  key: string;
  label: string;
  prompt: string | null;
  inputType: string | null;
  options: unknown;
  isRequired: boolean;
  displayOrder: number;
  isActive: boolean;
};

type LeadQuestionnaireTemplate = {
  enabled: boolean;
  questionnaire: {
    projectTypeId: string | null;
    nodes: LeadQuestionnaireNode[];
    allNodes: LeadQuestionnaireNode[];
    answers: Record<string, string | boolean | number | null>;
  } | null;
};

type AuditBundle = {
  company: AuditCompany;
  property: AuditProperty;
  newLeadStage: AuditStage;
  qualifiedLeadStage: AuditStage;
  salesValidationStage: AuditStage;
  projectTypes: {
    traditionalMultifamily: AuditProjectType;
    commercial: AuditProjectType;
    restoration: AuditProjectType;
  };
};

type QuestionAnswerValue = string | boolean | number | null;

function isTruthyRevealValue(value: QuestionAnswerValue | undefined) {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return Boolean(value);
}

function isNodeVisible(
  node: LeadQuestionnaireNode,
  nodeById: Map<string, LeadQuestionnaireNode>,
  answers: Record<string, QuestionAnswerValue>,
  visibleCache: Map<string, boolean>
): boolean {
  const cached = visibleCache.get(node.id);
  if (cached !== undefined) {
    return cached;
  }

  if (!node.parentNodeId) {
    visibleCache.set(node.id, true);
    return true;
  }

  const parent = nodeById.get(node.parentNodeId);
  if (!parent) {
    visibleCache.set(node.id, false);
    return false;
  }

  if (!isNodeVisible(parent, nodeById, answers, visibleCache)) {
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

function getVisibleQuestionNodes(
  nodes: LeadQuestionnaireNode[],
  answers: Record<string, QuestionAnswerValue>
) {
  const questions = nodes.filter((node) => node.nodeType === "question" && node.isActive);
  const nodeById = new Map(questions.map((node) => [node.id, node]));
  const visibleCache = new Map<string, boolean>();

  return questions
    .filter((node) => isNodeVisible(node, nodeById, answers, visibleCache))
    .sort((left, right) => left.displayOrder - right.displayOrder);
}

function getFirstOptionValue(options: unknown): string | null {
  if (!Array.isArray(options) || options.length === 0) {
    return null;
  }

  const first = options[0];
  if (typeof first === "string") {
    return first;
  }
  if (first && typeof first === "object" && "value" in first) {
    const value = (first as { value?: unknown }).value;
    return typeof value === "string" ? value : null;
  }
  if (first && typeof first === "object" && "label" in first) {
    const label = (first as { label?: unknown }).label;
    return typeof label === "string" ? label : null;
  }
  return null;
}

async function loadAuditBundle() {
  const apiRequest = await createRoleApiContext("rep");

  try {
    const companyResponse = await fetchJsonWithRetry<{
      companies: AuditCompany[];
      total: number;
    }>(apiRequest, `${apiBaseURL}/api/companies?search=AUDIT_TEST_Company&limit=20`);

    expect(companyResponse.companies.length).toBeGreaterThan(0);

    let company: AuditCompany | null = null;
    let property: AuditProperty | null = null;

    for (const candidate of companyResponse.companies) {
      const propertiesResponse = await fetchJsonWithRetry<{ properties: AuditProperty[] }>(
        apiRequest,
        `${apiBaseURL}/api/properties?companyId=${candidate.id}&limit=20`
      );

      if (propertiesResponse.properties[0]) {
        company = candidate;
        property = propertiesResponse.properties[0];
        break;
      }
    }

    expect(company, "No AUDIT_TEST_ company with a linked property is available").toBeDefined();
    expect(property, "No AUDIT_TEST_ property is available").toBeDefined();

    const [projectTypesResponse, stagesResponse] = await Promise.all([
      fetchJsonWithRetry<{ projectTypes: AuditProjectType[] }>(apiRequest, `${apiBaseURL}/api/pipeline/project-types`),
      fetchJsonWithRetry<{ stages: AuditStage[] }>(
        apiRequest,
        `${apiBaseURL}/api/pipeline/stages?workflowFamily=lead`
      ),
    ]);

    const traditionalMultifamily = projectTypesResponse.projectTypes.find(
      (entry) => entry.slug === "traditional_multifamily"
    );
    const commercial = projectTypesResponse.projectTypes.find((entry) => entry.slug === "commercial");
    const restoration = projectTypesResponse.projectTypes.find((entry) => entry.slug === "restoration");
    const newLeadStage = stagesResponse.stages.find((entry) => entry.slug === "new_lead");
    const qualifiedLeadStage = stagesResponse.stages.find((entry) => entry.slug === "qualified_lead");
    const salesValidationStage = stagesResponse.stages.find(
      (entry) => entry.slug === "sales_validation_stage"
    );

    expect(traditionalMultifamily, "Traditional Multifamily project type missing").toBeDefined();
    expect(commercial, "Commercial project type missing").toBeDefined();
    expect(restoration, "Restoration project type missing").toBeDefined();
    expect(newLeadStage, "New Lead stage missing").toBeDefined();
    expect(qualifiedLeadStage, "Qualified Lead stage missing").toBeDefined();
    expect(salesValidationStage, "Sales Validation stage missing").toBeDefined();

    return {
      company: company!,
      property: property!,
      newLeadStage: newLeadStage!,
      qualifiedLeadStage: qualifiedLeadStage!,
      salesValidationStage: salesValidationStage!,
      projectTypes: {
        traditionalMultifamily: traditionalMultifamily!,
        commercial: commercial!,
        restoration: restoration!,
      },
    } satisfies AuditBundle;
  } finally {
    await apiRequest.dispose();
  }
}

async function createAuditLead(bundle: AuditBundle) {
  const apiRequest = await createRoleApiContext("rep");

  try {
    const data = await fetchJsonWithRetry<{ lead: { id: string } }>(apiRequest, `${apiBaseURL}/api/leads`, {
      method: "POST",
      data: {
        companyId: bundle.company.id,
        propertyId: bundle.property.id,
        stageId: bundle.newLeadStage.id,
        name: `AUDIT_TEST_Cascade_${Date.now()}`,
        source: "AUDIT_TEST cascade",
      },
    });

    return data.lead.id;
  } finally {
    await apiRequest.dispose();
  }
}

async function deleteLeadById(leadId: string) {
  const apiRequest = await createRoleApiContext("rep");
  try {
    await apiRequest.fetch(`${apiBaseURL}/api/leads/${leadId}`, { method: "DELETE" });
  } finally {
    await apiRequest.dispose();
  }
}

async function fetchTemplate(projectTypeId: string | null) {
  const apiRequest = await createRoleApiContext("rep");

  try {
    const params = new URLSearchParams();
    if (projectTypeId) {
      params.set("projectTypeId", projectTypeId);
    }

    return await fetchJsonWithRetry<LeadQuestionnaireTemplate>(
      apiRequest,
      `${apiBaseURL}/api/leads/questionnaire-template${params.toString() ? `?${params.toString()}` : ""}`
    );
  } finally {
    await apiRequest.dispose();
  }
}

async function fetchLeadById(leadId: string) {
  const apiRequest = await createRoleApiContext("rep");
  try {
    const data = await fetchJsonWithRetry<{ lead: { stageId: string } }>(
      apiRequest,
      `${apiBaseURL}/api/leads/${leadId}`
    );
    return data.lead;
  } finally {
    await apiRequest.dispose();
  }
}

async function promoteLeadToQualified(bundle: AuditBundle, leadId: string, projectTypeId: string) {
  const apiRequest = await createRoleApiContext("rep");

  try {
    const response = await apiRequest.fetch(`${apiBaseURL}/api/leads/${leadId}`, {
      method: "PATCH",
      data: {
        stageId: bundle.qualifiedLeadStage.id,
        projectTypeId,
        qualificationPayload: {
          existing_customer_status: "Repeat customer",
        },
      },
    });

    expect(response.status()).toBe(200);
  } finally {
    await apiRequest.dispose();
  }
}

async function expectRenderedKeys(
  page: import("@playwright/test").Page,
  candidateKeys: string[],
  expectedKeys: string[]
) {
  const actualVisibleKeys: string[] = [];

  for (const key of candidateKeys) {
    const count = await page.locator(`#${key}`).count();
    if (count > 0) {
      actualVisibleKeys.push(key);
    }
  }

  expect(actualVisibleKeys.sort()).toEqual([...expectedKeys].sort());
}

async function fillQuestionAnswer(
  page: import("@playwright/test").Page,
  node: LeadQuestionnaireNode,
  valueOverride?: QuestionAnswerValue
) {
  const locator = page.locator(`#${node.key}`);
  const inputType = node.inputType ?? "text";
  const currentValue = valueOverride;

  if (inputType === "boolean") {
    await locator.click();
    const next = typeof currentValue === "boolean" ? String(currentValue) : "true";
    await page.getByRole("option", { name: next === "true" ? "Yes" : "No", exact: true }).click();
    return;
  }

  if ((inputType === "select" || (Array.isArray(node.options) && node.options.length > 0)) && currentValue == null) {
    const next = getFirstOptionValue(node.options);
    if (!next) return;
    await locator.click();
    await page.getByRole("option", { name: next, exact: true }).click();
    return;
  }

  if (inputType === "select" || (Array.isArray(node.options) && node.options.length > 0)) {
    await locator.click();
    await page.getByRole("option", { name: String(currentValue), exact: true }).click();
    return;
  }

  const value =
    currentValue != null
      ? String(currentValue)
      : inputType === "date"
        ? "2026-05-01"
        : inputType === "number" || inputType === "currency"
          ? "1"
          : `AUDIT_TEST ${node.key}`;

  await locator.fill(value);
}

async function collectIssues(page: import("@playwright/test").Page, expectedLeadPatchUrl: string) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const responseErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    consoleErrors.push(message.text());
  });

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = response.url();
    if (url.includes("/api/auth/me")) return;
    if ((response.status() === 400 || response.status() === 409) && url === expectedLeadPatchUrl) return;
    responseErrors.push(`${response.status()} ${response.request().method()} ${url}`);
  });

  return {
    assertClean() {
      expect(consoleErrors, `Console errors:\\n${consoleErrors.join("\\n")}`).toEqual([]);
      expect(pageErrors, `Page errors:\\n${pageErrors.join("\\n")}`).toEqual([]);
      expect(responseErrors, `Network errors:\\n${responseErrors.join("\\n")}`).toEqual([]);
    },
  };
}

test.describe.serial("lead questionnaire cascade production audit", () => {
  let auditBundle: AuditBundle;
  let leadId: string;

  test.beforeAll(async () => {
    auditBundle = await loadAuditBundle();
    leadId = await createAuditLead(auditBundle);
  });

  test.afterAll(async () => {
    if (leadId) {
      await deleteLeadById(leadId);
    }
  });

  test("rep can verify questionnaire cascade rendering, switching, reveal rules, and sales validation stage gating on production", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await loginWithRole(page, "rep");
    const issues = await collectIssues(page, `${apiBaseURL}/api/leads/${leadId}`);

    const initialTemplate = await fetchTemplate(null);
    const traditionalTemplate = await fetchTemplate(auditBundle.projectTypes.traditionalMultifamily.id);
    const commercialTemplate = await fetchTemplate(auditBundle.projectTypes.commercial.id);
    const restorationTemplate = await fetchTemplate(auditBundle.projectTypes.restoration.id);

    expect(initialTemplate.enabled).toBeTruthy();
    expect(traditionalTemplate.enabled).toBeTruthy();
    expect(commercialTemplate.enabled).toBeTruthy();
    expect(restorationTemplate.enabled).toBeTruthy();

    const allCandidateKeys = Array.from(
      new Set(
        [
          ...(initialTemplate.questionnaire?.nodes ?? []),
          ...(traditionalTemplate.questionnaire?.nodes ?? []),
          ...(commercialTemplate.questionnaire?.nodes ?? []),
          ...(restorationTemplate.questionnaire?.nodes ?? []),
        ]
          .filter((node) => node.nodeType === "question")
          .map((node) => node.key)
      )
    );

    await page.goto(`/leads/${leadId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Edit Lead", exact: true }).click();
    await expect(page.getByText("Project Questions", { exact: true })).toBeVisible();

    const initialVisibleNodes = getVisibleQuestionNodes(initialTemplate.questionnaire?.nodes ?? [], {});
    await expectRenderedKeys(
      page,
      allCandidateKeys,
      initialVisibleNodes.map((node) => node.key)
    );

    const assertProjectType = async (projectType: AuditProjectType) => {
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes(
            `/api/leads/questionnaire-template?projectTypeId=${projectType.id}`
          ) && response.status() === 200
      );

      await page.locator("#lead-project-type").click();
      await page.getByRole("option", { name: projectType.name, exact: true }).click();
      await responsePromise;

      const template = await fetchTemplate(projectType.id);
      const visibleNodes = getVisibleQuestionNodes(template.questionnaire?.nodes ?? [], {});
      const baselineKeys = visibleNodes
        .filter((node) => node.projectTypeId == null)
        .map((node) => node.key);
      const categoryKeys = visibleNodes
        .filter((node) => node.projectTypeId != null)
        .map((node) => node.key);

      await expectRenderedKeys(
        page,
        allCandidateKeys,
        visibleNodes.map((node) => node.key)
      );

      for (const node of visibleNodes) {
        const label = page.locator(`label[for="${node.key}"]`);
        await expect(label).toBeVisible();
        if (node.isRequired) {
          await expect(label).toContainText("*");
        } else {
          await expect(label).not.toContainText("*");
        }
      }

      expect(baselineKeys.length, `${projectType.slug} should include baseline keys`).toBeGreaterThan(0);
      expect(categoryKeys.length, `${projectType.slug} should include category-specific keys`).toBeGreaterThan(0);

      return {
        template,
        visibleNodes,
        baselineKeys,
        categoryKeys,
      };
    };

    const traditionalSetA = await assertProjectType(auditBundle.projectTypes.traditionalMultifamily);
    const commercialSet = await assertProjectType(auditBundle.projectTypes.commercial);
    const restorationSetB = await assertProjectType(auditBundle.projectTypes.restoration);

    expect(
      traditionalSetA.categoryKeys.filter((key) => !traditionalSetA.baselineKeys.includes(key)).length
    ).toBeGreaterThan(0);
    expect(
      restorationSetB.categoryKeys.filter((key) => !restorationSetB.baselineKeys.includes(key)).length
    ).toBeGreaterThan(0);

    expect(
      traditionalSetA.categoryKeys.filter((key) => !restorationSetB.baselineKeys.includes(key))
    ).not.toEqual(
      restorationSetB.categoryKeys.filter((key) => !traditionalSetA.baselineKeys.includes(key))
    );

    for (const key of traditionalSetA.categoryKeys) {
      if (traditionalSetA.baselineKeys.includes(key)) continue;
      expect(restorationSetB.visibleNodes.map((node) => node.key)).not.toContain(key);
    }

    for (const key of restorationSetB.categoryKeys) {
      if (restorationSetB.baselineKeys.includes(key)) continue;
      expect(traditionalSetA.visibleNodes.map((node) => node.key)).not.toContain(key);
    }

    for (const key of traditionalSetA.baselineKeys) {
      expect(restorationSetB.visibleNodes.map((node) => node.key)).toContain(key);
      expect(commercialSet.visibleNodes.map((node) => node.key)).toContain(key);
    }

    const traditionalSetAReturn = await assertProjectType(auditBundle.projectTypes.traditionalMultifamily);
    expect(traditionalSetAReturn.visibleNodes.map((node) => node.key).sort()).toEqual(
      traditionalSetA.visibleNodes.map((node) => node.key).sort()
    );

    await promoteLeadToQualified(auditBundle, leadId, auditBundle.projectTypes.restoration.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Edit Lead", exact: true }).click();
    await expect(page.getByText("Project Questions", { exact: true })).toBeVisible();

    const restorationSet = await assertProjectType(auditBundle.projectTypes.restoration);
    const insuranceClaimNode = restorationSet.template.questionnaire?.nodes.find(
      (node) => node.key === "insurance_claim"
    );
    const xactimateNode = restorationSet.template.questionnaire?.nodes.find(
      (node) => node.key === "xactimate"
    );

    expect(insuranceClaimNode, "insurance_claim node missing from restoration seed").toBeDefined();
    expect(xactimateNode, "xactimate node missing from restoration seed").toBeDefined();

    await expect(page.locator("#xactimate")).toHaveCount(0);

    const hiddenChildGateApi = await createRoleApiContext("rep");
    try {
      const hiddenChildResponse = await hiddenChildGateApi.fetch(`${apiBaseURL}/api/leads/${leadId}`, {
        method: "PATCH",
        data: {
          projectTypeId: auditBundle.projectTypes.restoration.id,
          stageId: auditBundle.salesValidationStage.id,
          qualificationPayload: {
            existing_customer_status: "Repeat customer",
            estimated_value: 125000,
            timeline_status: "Q3 2026",
          },
          leadQuestionAnswers: {
            insurance_claim: false,
          },
        },
      });

      expect(hiddenChildResponse.status()).toBe(409);
      const hiddenChildPayload = await hiddenChildResponse.json();
      expect(hiddenChildPayload.error?.code).toBe("LEAD_STAGE_REQUIREMENTS_UNMET");
      expect(hiddenChildPayload.error?.missingRequirements?.projectTypeQuestionIds).not.toContain(
        "xactimate"
      );
    } finally {
      await hiddenChildGateApi.dispose();
    }

    await fillQuestionAnswer(page, insuranceClaimNode!, true);
    await expect(page.locator("#xactimate")).toBeVisible();
    await expect(page.locator('label[for="xactimate"]')).toContainText("*");
    await fillQuestionAnswer(page, insuranceClaimNode!, false);
    await expect(page.locator("#xactimate")).toHaveCount(0);

    const traditionalGate = await assertProjectType(auditBundle.projectTypes.traditionalMultifamily);
    const traditionalRequiredVisibleKeys = traditionalGate.visibleNodes
      .filter((node) => node.isRequired)
      .map((node) => node.key)
      .sort();

    const gateApi = await createRoleApiContext("rep");
    try {
      const blockedResponse = await gateApi.fetch(`${apiBaseURL}/api/leads/${leadId}`, {
        method: "PATCH",
        data: {
          projectTypeId: auditBundle.projectTypes.traditionalMultifamily.id,
          stageId: auditBundle.salesValidationStage.id,
          qualificationPayload: {
            existing_customer_status: "Repeat customer",
            estimated_value: 125000,
            timeline_status: "Q3 2026",
          },
        },
      });

      expect(blockedResponse.status()).toBe(409);
      const blockedPayload = await blockedResponse.json();
      expect(blockedPayload.error?.code).toBe("LEAD_STAGE_REQUIREMENTS_UNMET");
      expect([...blockedPayload.error?.missingRequirements?.projectTypeQuestionIds].sort()).toEqual(
        traditionalRequiredVisibleKeys
      );
    } finally {
      await gateApi.dispose();
    }

    await page.locator("#lead-stage").click();
    await page.getByRole("option", { name: auditBundle.salesValidationStage.name, exact: true }).click();
    await page.locator("#existing-customer-status").fill("Repeat customer");
    await page.locator("#estimated-value").fill("125000");
    await page.locator("#timeline-status").fill("Q3 2026");
    await page.getByRole("button", { name: "Save Changes", exact: true }).click();

    await expect(page.getByText("Missing question keys:", { exact: false })).toBeVisible();
    for (const key of traditionalRequiredVisibleKeys) {
      await expect(page.getByText(key, { exact: true })).toBeVisible();
    }

    for (const node of traditionalGate.visibleNodes.filter((entry) => entry.isRequired)) {
      await fillQuestionAnswer(page, node);
    }

    await page.getByRole("button", { name: "Save Changes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Convert to Opportunity", exact: true })).toBeVisible();

    const persistedLead = await fetchLeadById(leadId);
    expect(persistedLead.stageId).toBe(auditBundle.salesValidationStage.id);

    issues.assertClean();
  });
});
