import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { weeklyReportRoutes } from "../src/modules/weekly-reports/routes.js";
import { errorHandler } from "../src/middleware/error-handler.js";

// WHO MAY DELETE A WEEKLY REPORT, decided before any handler runs.
//
// The router as a whole admits `admin | director | rep` — that is the read gate for the leadership board
// — so `rep` is the role this route has to narrow away, and it is the one a router-level gate alone would
// let through. A rep can already open the History tab and read every project's reports; removing one is a
// different act, and the service's own 403 is not a substitute for refusing the request outright: a gate
// that only fires inside the handler has already loaded the report on behalf of somebody who was never
// allowed to ask.
//
// No database. A 403 from the gate is decided before the handler, which is the whole property under test.

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
const DELETE_PATH = `/weekly-reports/reports/${REPORT}`;

describe("DELETE /reports/:id sits behind admin and director", () => {
  it.each(["rep", "construction", "field_contractor"])("refuses a %s", async (role) => {
    const response = await request(appAs(role)).delete(DELETE_PATH).send({ reason: "Test data" });
    expect(response.status).toBe(403);
  });

  it.each(["admin", "director"])("lets a %s past the gate, so it is not simply refusing everyone", async (role) => {
    // Past the gate it reaches the handler and fails on the absent tenant client. That difference IS the
    // assertion: without it the refusals above would pass for a route that does not exist at all.
    const response = await request(appAs(role)).delete(DELETE_PATH).send({ reason: "Test data" });
    expect(response.status).not.toBe(403);
    expect(response.status).not.toBe(404);
  });
});
