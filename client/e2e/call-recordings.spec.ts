import { expect, test } from "@playwright/test";
import { installCommonApiMocks } from "./helpers/mock-api";

const deal = {
  id: "deal-call-recordings",
  dealNumber: "dfw-3-11826-cr",
  name: "Call Recording Deal",
  stageId: "stage-opportunity",
  assignedRepId: "admin-1",
  assignedRepName: "Admin User",
  sourceLeadId: null,
  companyId: "company-1",
  propertyId: "property-1",
  primaryContactId: null,
  changeOrders: [],
  approvals: [],
  stageHistory: [],
  workflowRoute: "normal",
  isBidBoardOwned: false,
  bidBoardOwnership: { isOwned: false },
  postConversionEnrichment: { applies: false, isComplete: true, requiredFields: [], missingFields: [] },
  stageEnteredAt: "2026-04-28T12:00:00.000Z",
  createdAt: "2026-04-28T12:00:00.000Z",
  updatedAt: "2026-04-28T12:00:00.000Z",
  proposalStatus: "not_started",
  proposalDraftStartedAt: null,
  proposalSentAt: null,
  proposalAcceptedAt: null,
  proposalRevisionCount: 0,
};

test("admin uploads, plays, and deletes a call recording from a deal", async ({ page }) => {
  await installCommonApiMocks(page);

  let recordings: any[] = [];
  let uploaded = false;
  let confirmed = false;
  let deleted = false;

  await page.route("**/api/deals/deal-call-recordings/detail", (route) => route.fulfill({ json: { deal } }));
  await page.route("**/api/deals/deal-call-recordings/team", (route) => route.fulfill({ json: { members: [] } }));
  await page.route("**/api/activities?dealId=deal-call-recordings**", (route) => route.fulfill({ json: { activities: [], pagination: { total: 0 } } }));
  await page.route("**/api/call-recordings?entityType=deal&entityId=deal-call-recordings", (route) =>
    route.fulfill({ json: { recordings } })
  );
  await page.route("**/api/call-recordings/upload-url", async (route) => {
    await route.request().postDataJSON();
    await route.fulfill({
      json: {
        uploadUrl: "/api/mock-r2/rec-1",
        recordingId: "rec-1",
        r2Key: "call-recordings/office-1/rec-1.wav",
        expiresIn: 900,
      },
    });
  });
  await page.route("**/api/mock-r2/rec-1", (route) => {
    uploaded = route.request().method() === "PUT";
    return route.fulfill({ status: 200, headers: { ETag: "mock" }, body: "" });
  });
  await page.route("**/api/call-recordings/rec-1/confirm", async (route) => {
    confirmed = true;
    recordings = [{
      id: "rec-1",
      originalFilename: "call.wav",
      title: "Kickoff Call",
      callDate: "2026-04-29T14:00:00.000Z",
      uploadedAt: "2026-04-29T14:01:00.000Z",
      uploadedByName: "Admin User",
      durationSeconds: 1,
      fileSizeBytes: 44,
    }];
    await route.fulfill({ json: { recording: recordings[0] } });
  });
  await page.route("**/api/call-recordings/rec-1/playback", (route) =>
    route.fulfill({ json: { playbackUrl: "/api/mock-r2/rec-1-playback.wav", expiresIn: 3600 } })
  );
  await page.route("**/api/mock-r2/rec-1-playback.wav", (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body: Buffer.from("RIFF$\0\0\0WAVEfmt ") })
  );
  await page.route("**/api/call-recordings/rec-1", async (route) => {
    deleted = route.request().method() === "DELETE";
    recordings = [];
    await route.fulfill({ status: 204, body: "" });
  });

  await page.goto("/deals/deal-call-recordings?tab=activity");
  await expect(page.getByText("No call recordings yet.")).toBeVisible();

  await page.getByRole("button", { name: "Upload Recording" }).click();
  await page.getByLabel("Audio file").setInputFiles({
    name: "call.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("RIFF$\0\0\0WAVEfmt "),
  });
  await page.getByLabel("Title").fill("Kickoff Call");
  await page.getByRole("button", { name: "Upload Recording" }).click();

  await expect(page.getByText("Kickoff Call")).toBeVisible();
  expect(uploaded).toBe(true);
  expect(confirmed).toBe(true);

  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.locator("audio")).toBeVisible();

  page.on("dialog", (dialog) => dialog.accept());
  await page.getByLabel("Delete recording").click();
  await expect(page.getByText("No call recordings yet.")).toBeVisible();
  expect(deleted).toBe(true);
});
