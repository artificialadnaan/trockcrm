/**
 * Pins WHICH ROUTER the glasses-walkthrough endpoints live on.
 *
 * This is the test that would have caught the defect that shipped through five review rounds and 99
 * reviewer comments: the endpoints were built on the CRM deals router, but their only caller —
 * TrockCam — authenticates through `/auth/field-login`, which mints a `surface: "field"` token that
 * `authMiddleware` rejects on every CRM route by design (#722, so a field token can never be replayed
 * against CRM/admin).
 *
 * The consequence was not a degraded feature, it was an unusable app. Every upload returned 401 "This
 * session is not valid for CRM access"; the client read 401 as a dead session and signed the user out;
 * and because the authenticated shell drains the upload queue the moment it mounts, one undeliverable
 * walk produced sign in -> drain -> 401 -> signed out -> sign in, with no way out from inside the app.
 *
 * Nothing in the unit suites could see it. Both sides were tested against mocks that agreed with each
 * other's assumptions rather than with the real auth boundary between them. So this asserts the boundary
 * itself — that the routes are reachable by a FIELD surface and absent from the CRM surface — rather
 * than any handler behaviour, which the service tests already cover.
 */
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// A CRM session: no `surface` claim, exactly what authMiddleware lets through to /api/deals.
vi.mock("../src/middleware/auth.js", () => ({
  authMiddleware: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.user = {
      id: "crm-1",
      email: "crm@example.com",
      displayName: "CRM User",
      role: "admin",
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    next();
  },
}));

vi.mock("../src/middleware/tenant.js", () => ({
  tenantMiddleware: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.tenantDb = {};
    req.officeSlug = "dallas";
    req.commitTransaction = async () => {};
    next();
  },
}));

const { createApp } = await import("../src/app.js");

const DEAL = "00000000-0000-4000-8000-000000000001";

describe("glasses-walkthrough route surface", () => {
  it.each([
    ["upload-url", `/api/deals/${DEAL}/glasses-walkthroughs/artifacts/upload-url`],
    ["completion", `/api/deals/${DEAL}/glasses-walkthroughs`],
  ])(
    "does NOT expose the %s route on the CRM deals router, which no field session can reach",
    async (_label, path) => {
      const response = await request(createApp()).post(path).send({});

      // 404 = no such route. Anything else means a CRM-side copy came back — and a copy is exactly how
      // the original defect would return, since the CRM handler works fine for the CRM sessions the
      // tests use and only fails for the field sessions that are the real callers.
      expect(response.status).toBe(404);
    },
  );

  it.each([
    ["upload-url", `/api/field/projects/${DEAL}/glasses-walkthroughs/artifacts/upload-url`],
    ["completion", `/api/field/projects/${DEAL}/glasses-walkthroughs`],
  ])("registers the %s route on the FIELD router, where TrockCam can reach it", async (_label, path) => {
    const response = await request(createApp()).post(path).send({});

    // The route must EXIST. It will not succeed here — this mock is a CRM session, so
    // requireFieldContractor rejects it — but rejection proves a handler is mounted and running its
    // guard, whereas 404 would mean the endpoint moved out from under the app again.
    expect(response.status).not.toBe(404);
  });
});
