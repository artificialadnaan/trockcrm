import { expect, test } from "@playwright/test";

import { installCommonApiMocks } from "./helpers/mock-api";

type Deal = ReturnType<typeof makeDeal>;

function makeDeal(overrides: Partial<Record<string, unknown>> = {}) {
  const isBidBoardOwned = Boolean(overrides.isBidBoardOwned);

  return {
    id: "deal-bid-board-ownership",
    dealNumber: "dfw-3-11826-bb",
    name: "Bid Board Ownership Deal",
    stageId: isBidBoardOwned ? "stage-estimating" : "stage-opportunity",
    assignedRepId: "admin-1",
    assignedRepName: "Admin User",
    sourceLeadId: "lead-1",
    companyId: "company-1",
    propertyId: "property-1",
    primaryContactId: null,
    pipelineDisposition: "deals",
    workflowRoute: "normal",
    ddEstimate: "10000.00",
    bidEstimate: "25000.00",
    awardedAmount: "0.00",
    changeOrderTotal: "0.00",
    description: "Original CRM description",
    propertyAddress: "100 Audit Way",
    propertyCity: "Dallas",
    propertyState: "TX",
    propertyZip: "75201",
    projectTypeId: "type-3",
    regionId: null,
    source: "Bid Board",
    winProbability: 50,
    expectedCloseDate: "2026-06-01",
    actualCloseDate: null,
    contractSignedDate: null,
    lastActivityAt: null,
    stageEnteredAt: "2026-04-28T12:00:00.000Z",
    isActive: true,
    hubspotDealId: null,
    procoreProjectId: null,
    procoreBidId: null,
    procoreLastSyncedAt: null,
    lostReasonId: null,
    lostNotes: null,
    lostCompetitor: null,
    lostAt: null,
    createdAt: "2026-04-28T12:00:00.000Z",
    updatedAt: "2026-04-28T12:00:00.000Z",
    proposalStatus: "drafting",
    proposalDraftStartedAt: "2026-04-28T12:00:00.000Z",
    proposalSentAt: null,
    proposalAcceptedAt: null,
    proposalRevisionCount: 0,
    proposalNotes: null,
    estimatingSubstage: "building_estimate",
    isBidBoardOwned,
    bidBoardStageSlug: isBidBoardOwned ? "estimate_in_progress" : null,
    readOnlySyncedAt: isBidBoardOwned ? "2026-04-28T12:00:00.000Z" : null,
    bidBoardOwnership: {
      isOwned: isBidBoardOwned,
      sourceOfTruth: isBidBoardOwned ? "bid_board" : "crm",
      handoffStageSlug: "estimate_in_progress",
      downstreamStagesReadOnly: isBidBoardOwned,
      canEditInCrm: ["deal details", "files", "activity", "notes"],
      mirroredInCrm: ["stage progression", "proposal status", "estimating progress", "estimate amounts"],
      reason: isBidBoardOwned
        ? "Bid Board now owns downstream progression after the deal entered estimating."
        : "CRM still owns manual stage progression before estimating handoff.",
      message: isBidBoardOwned
        ? "Bid Board is now the source of truth once this deal entered estimating."
        : "CRM remains the source of truth until the deal is handed off into estimating.",
    },
    postConversionEnrichment: { applies: true, isComplete: false, requiredFields: [], missingFields: [] },
    departmentOwnership: {
      ownerDepartment: "estimating",
      editableDepartments: ["sales", "estimating"],
      readOnlyDepartments: [],
      handoffLabel: null,
    },
    stageHistory: [],
    approvals: [],
    changeOrders: [],
    routingHistory: [],
    ...overrides,
  };
}

async function installDealMocks(page: import("@playwright/test").Page, initialDeal: Deal) {
  let deal = initialDeal;
  const patchStatuses: number[] = [];

  await installCommonApiMocks(page);
  await page.route("**/api/activities**", (route) => route.fulfill({ json: { activities: [] } }));
  await page.route("**/api/ai/deals/**", (route) =>
    route.fulfill({ json: { packet: null, refreshQueuedAt: null } })
  );
  await page.route("**/api/deals/deal-bid-board-ownership/team", (route) =>
    route.fulfill({ json: { members: [] } })
  );
  await page.route("**/api/deals/deal-bid-board-ownership/detail", (route) =>
    route.fulfill({ json: { deal } })
  );
  await page.route("**/api/deals/deal-bid-board-ownership", async (route) => {
    if (route.request().method() !== "PATCH") {
      return route.fulfill({ json: { deal } });
    }

    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (deal.isBidBoardOwned && body.bidEstimate !== undefined) {
      patchStatuses.push(403);
      return route.fulfill({
        status: 403,
        json: {
          error: {
            code: "BID_BOARD_OWNED_FIELD_READ_ONLY",
            message: "Bid estimate is mirrored from Bid Board after estimating handoff.",
          },
        },
      });
    }

    deal = { ...deal, ...body, updatedAt: new Date().toISOString() };
    patchStatuses.push(200);
    return route.fulfill({ json: { deal } });
  });

  return {
    getDeal: () => deal,
    patchStatuses,
  };
}

test("editing a Bid Board-owned estimate field succeeds before Opportunity handoff", async ({ page }) => {
  const harness = await installDealMocks(page, makeDeal({ isBidBoardOwned: false }));

  await page.goto("/deals/deal-bid-board-ownership/edit");
  await page.getByLabel("Bid Estimate ($)").fill("27500");
  await page.getByRole("button", { name: "Save Changes" }).click();

  await expect.poll(() => harness.patchStatuses).toEqual([200]);
  expect(harness.getDeal().bidEstimate).toBe("27500");
});

test("editing the same Bid Board-owned estimate field is locked after Opportunity handoff", async ({ page }) => {
  const harness = await installDealMocks(page, makeDeal({ isBidBoardOwned: true }));

  await page.goto("/deals/deal-bid-board-ownership/edit");
  await expect(page.getByLabel("Bid Estimate ($)")).toBeDisabled();
  const lock = page.getByLabel("Bid estimate is mirrored from Bid Board after estimating handoff.");
  await expect(lock).toBeVisible();
  await expect(lock).toHaveAttribute(
    "title",
    "Bid estimate is mirrored from Bid Board after estimating handoff."
  );

  const responseStatus = await page.evaluate(async () => {
    const response = await fetch("/api/deals/deal-bid-board-ownership", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bidEstimate: "30000.00" }),
    });
    return response.status;
  });
  expect(responseStatus).toBe(403);
  await expect.poll(() => harness.patchStatuses).toContain(403);
});

test("editing a CRM-owned field still succeeds after Opportunity handoff", async ({ page }) => {
  const harness = await installDealMocks(page, makeDeal({ isBidBoardOwned: true }));

  await page.goto("/deals/deal-bid-board-ownership/edit");
  await page.getByLabel("Description").fill("Updated CRM-owned description");
  await page.getByRole("button", { name: "Save Changes" }).click();

  await expect.poll(() => harness.patchStatuses).toContain(200);
  expect(harness.getDeal().description).toBe("Updated CRM-owned description");
});

test("Bid Board sync status shows relative sync time and a manual refresh button", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-04-28T12:15:00.000Z"));
  const harness = await installDealMocks(page, makeDeal({ isBidBoardOwned: true }));

  await page.goto("/deals/deal-bid-board-ownership?tab=overview");

  await expect(page.getByText("Synced from Bid Board 15 minutes ago")).toBeVisible();
  await page.getByRole("button", { name: "Refresh Bid Board sync status" }).click();
  await expect.poll(() => harness.getDeal().id).toBe("deal-bid-board-ownership");
});
