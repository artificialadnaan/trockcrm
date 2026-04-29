import { expect, test } from "@playwright/test";
import { adminUser, canonicalProjectTypes, installCommonApiMocks } from "./helpers/mock-api";

const roofing = canonicalProjectTypes.find((type) => type.slug === "roofing")!;

const repUser = {
  ...adminUser,
  id: "rep-1",
  email: "rep@example.test",
  displayName: "Sales Rep",
  role: "rep",
};

test("non-admin users cannot edit Opportunity project type in Scoping", async ({ page }) => {
  await installCommonApiMocks(page);
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: repUser } }));
  await page.route("**/api/deals/deal-rep/detail", (route) =>
    route.fulfill({
      json: {
        deal: {
          id: "deal-rep",
          dealNumber: "dfw-3-11826-aa",
          name: "Rep Project Type Deal",
          stageId: "stage-opportunity",
          assignedRepId: "rep-1",
          assignedRepName: "Sales Rep",
          sourceLeadId: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          projectTypeId: roofing.id,
          intendedProjectNumber: null,
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
        },
      },
    })
  );
  await page.route("**/api/deals/deal-rep/scoping-intake**", (route) =>
    route.fulfill({
      json: {
        intake: {
          id: "intake-1",
          dealId: "deal-rep",
          officeId: "office-1",
          workflowRouteSnapshot: "normal",
          status: "draft",
          projectTypeId: roofing.id,
          sectionData: { opportunity: {}, projectOverview: {}, propertyDetails: {}, scopeSummary: {} },
          completionState: {},
          readinessErrors: { sections: {}, attachments: {} },
          firstReadyAt: null,
          activatedAt: null,
          lastAutosavedAt: "2026-04-28T12:00:00.000Z",
          createdBy: "rep-1",
          lastEditedBy: "rep-1",
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
          projectTypeId: roofing.id,
          companyId: "company-1",
          sourceCategory: null,
          sourceDetail: null,
          legacySource: null,
          propertyId: "property-1",
          propertyName: "Rep Project Type Deal",
          propertyAddress: null,
          propertyCity: null,
          propertyState: null,
          propertyZip: null,
          primaryContactId: null,
          assignedRepId: "rep-1",
          workflowRoute: "normal",
          description: null,
          bidDueDate: null,
        },
      },
    })
  );

  await page.goto("/deals/deal-rep?tab=scoping");

  await expect(page.getByLabel("Project Type")).toBeDisabled();
});
