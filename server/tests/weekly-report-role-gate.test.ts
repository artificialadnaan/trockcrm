import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { weeklyReportRoutes } from "../src/modules/weekly-reports/routes.js";
import { errorHandler } from "../src/middleware/error-handler.js";

// Which weekly-report endpoints a `construction` user can reach.
//
// The tenant mount admits `construction` — that is how superintendents get into the CRM at all — so the
// only thing keeping them off this router is the requireRole line at the top of it. A revision hoisted the
// three share-link routes ahead of that line, intending to let an assigned PM on a construction role mint
// their own client link. It could not work: `GET /reports/:id` and `POST /reports/:id/transition` stayed
// behind the gate and the client gates the page on the same three roles, so a construction PM has no way to
// learn a report id. What it did do was open all three endpoints to every construction and
// field_contractor user in the office, each of which only refuses AFTER taking FOR UPDATE on two rows.
//
// No database: a 403 from the gate is decided before any handler runs, which is the whole property.

function appAs(role: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: "00000000-0000-4000-8000-000000000001", role, activeOfficeId: "office-1" };
    next();
  });
  app.use("/weekly-reports", weeklyReportRoutes);
  app.use(errorHandler);
  return app;
}

const REPORT = "6b1f6f2e-9d1a-4e4a-9c2b-1f4d8a0c5e31";
const TOKEN = "6b1f6f2e-9d1a-4e4a-9c2b-1f4d8a0c5e32";

const SHARE_LINK_ROUTES: Array<[string, "get" | "post", string]> = [
  ["mint", "post", `/weekly-reports/reports/${REPORT}/share-link`],
  ["list", "get", `/weekly-reports/reports/${REPORT}/share-link`],
  ["revoke", "post", `/weekly-reports/reports/${REPORT}/share-link/${TOKEN}/revoke`],
];

describe("the share-link routes sit behind the role gate", () => {
  it.each(SHARE_LINK_ROUTES)("refuses a construction user on %s", async (_label, method, path) => {
    const response = await request(appAs("construction"))[method](path);
    // 403 from the gate itself. Hoisted ahead of it these reached their handler, which then failed on the
    // missing tenant client — a 500, i.e. work done on behalf of somebody who was never allowed to ask.
    expect(response.status).toBe(403);
  });

  it.each(SHARE_LINK_ROUTES)("refuses a field_contractor on %s", async (_label, method, path) => {
    expect((await request(appAs("field_contractor"))[method](path)).status).toBe(403);
  });

  it("lets leadership through the gate, so the gate is not simply refusing everyone", async () => {
    // Past the gate it reaches the handler and fails on the absent tenant client — which is exactly the
    // difference the assertions above rely on.
    expect((await request(appAs("director")).get(`/weekly-reports/reports/${REPORT}/share-link`)).status).not.toBe(403);
  });
});
