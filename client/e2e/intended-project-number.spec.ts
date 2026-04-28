import { expect, test } from "@playwright/test";
import { canonicalProjectTypes, installCommonApiMocks } from "./helpers/mock-api";

const roofing = canonicalProjectTypes.find((type) => type.slug === "roofing")!;
const exterior = canonicalProjectTypes.find((type) => type.slug === "exterior-renovation")!;

function makeDeal(projectTypeId = roofing.id, intendedProjectNumber: string | null = null) {
  return {
    id: "deal-intended",
    dealNumber: "dfw-3-11826-aa",
    name: "Intended Project Number Deal",
    stageId: "stage-opportunity",
    assignedRepId: "admin-1",
    assignedRepName: "Admin User",
    sourceLeadId: "lead-1",
    companyId: "company-1",
    propertyId: "property-1",
    primaryContactId: null,
    projectTypeId,
    intendedProjectNumber,
    changeOrders: [],
    approvals: [],
    stageHistory: [],
    workflowRoute: "normal",
    isBidBoardOwned: false,
    bidBoardOwnership: { isOwned: false },
    postConversionEnrichment: { applies: true, isComplete: false, requiredFields: [], missingFields: [] },
    stageEnteredAt: "2026-04-28T12:00:00.000Z",
    createdAt: "2026-04-28T12:00:00.000Z",
    updatedAt: "2026-04-28T12:00:00.000Z",
    proposalStatus: "not_started",
    proposalDraftStartedAt: null,
    proposalSentAt: null,
    proposalAcceptedAt: null,
    proposalRevisionCount: 0,
  };
}

function makeScoping(projectTypeId = roofing.id) {
  return {
    intake: {
      id: "intake-1",
      dealId: "deal-intended",
      officeId: "office-1",
      workflowRouteSnapshot: "normal",
      status: "draft",
      projectTypeId,
      sectionData: { opportunity: {}, projectOverview: {}, propertyDetails: {}, scopeSummary: {} },
      completionState: {},
      readinessErrors: { sections: {}, attachments: {} },
      firstReadyAt: null,
      activatedAt: null,
      lastAutosavedAt: "2026-04-28T12:00:00.000Z",
      createdBy: "admin-1",
      lastEditedBy: "admin-1",
      createdAt: "2026-04-28T12:00:00.000Z",
      updatedAt: "2026-04-28T12:00:00.000Z",
    },
    readiness: {
      status: "draft",
      errors: { sections: {}, attachments: {} },
      completionState: {},
      requiredSections: [],
      requiredAttachmentKeys: [],
      attachmentRequirements: [],
    },
    previousStatus: "draft",
    resolved: {
      projectTypeId,
      companyId: "company-1",
      sourceCategory: null,
      sourceDetail: null,
      legacySource: null,
      propertyId: "property-1",
      propertyName: "Intended Project Number Deal",
      propertyAddress: null,
      propertyCity: null,
      propertyState: null,
      propertyZip: null,
      primaryContactId: null,
      assignedRepId: "admin-1",
      workflowRoute: "normal",
      description: null,
      bidDueDate: null,
    },
  };
}

test("admin project type changes show and clear intended project number", async ({ page }) => {
  let deal = makeDeal();
  let scoping = makeScoping();

  await installCommonApiMocks(page);
  await page.route("**/api/deals/deal-intended/detail", (route) => route.fulfill({ json: { deal } }));
  await page.route("**/api/deals/deal-intended/scoping-intake**", async (route) => {
    if (route.request().method() === "PATCH") {
      return route.fulfill({ json: scoping });
    }
    return route.fulfill({ json: scoping });
  });
  await page.route("**/api/deals/deal-intended/resolved-fields", async (route) => {
    const body = await route.request().postDataJSON();
    const nextProjectTypeId = body.projectTypeId as string;
    const intendedProjectNumber = nextProjectTypeId === roofing.id ? null : "dfw-1-11826-aa";
    deal = makeDeal(nextProjectTypeId, intendedProjectNumber);
    scoping = makeScoping(nextProjectTypeId);
    return route.fulfill({
      json: {
        resolved: {
          deal,
          resolved: scoping.resolved,
          sourceLead: null,
          property: null,
          answersByKey: {},
          ownership: {},
        },
      },
    });
  });

  await page.goto("/deals/deal-intended?tab=scoping");
  await expect(page.getByText("dfw-3-11826-aa")).toBeVisible();

  await page.getByRole("combobox", { name: "Project Type" }).click();
  await page.getByRole("option", { name: "Exterior Renovation" }).click();
  await expect(page.getByText("Intended: dfw-1-11826-aa")).toBeVisible();
  await expect(page.getByText("dfw-3-11826-aa")).toBeVisible();

  await page.getByRole("combobox", { name: "Project Type" }).click();
  await page.getByRole("option", { name: "Roofing" }).click();
  await expect(page.getByText("Intended: dfw-1-11826-aa")).toHaveCount(0);
});
