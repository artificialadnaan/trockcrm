import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { weeklyReportRoutes } from "../src/modules/weekly-reports/routes.js";
import { errorHandler } from "../src/middleware/error-handler.js";

// Two properties of the send routes that are decided BEFORE any handler touches a database, and are
// therefore testable without one.
//
//   1. `POST /reports/:id/transition {"to":"sent"}` is refused. The state machine can perform that
//      transition — the send service calls it — but reaching it through the generic endpoint would stamp
//      sent_at, freeze the snapshot and light up "Sent" on the board with no email existing anywhere.
//      The client would never receive their report and every surface would insist they had.
//
//   2. The send, retry and correction routes sit behind the router's role gate. `requireCrmUser` on the
//      tenant mount admits `construction` — that is how superintendents reach the CRM at all — so without
//      the gate any superintendent in the office could send a client-facing report themselves.

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

describe("the generic transition endpoint cannot send a report", () => {
  it("refuses `sent` with a 400 that names the endpoint to use instead", async () => {
    const response = await request(appAs("director"))
      .post(`/weekly-reports/reports/${REPORT}/transition`)
      .send({ to: "sent" });
    expect(response.status).toBe(400);
    expect(String(response.body?.error?.message ?? response.body?.message ?? response.text)).toMatch(
      /send endpoint/i,
    );
  });

  it("still lets every OTHER target through to the handler", async () => {
    // Proves the guard is specific to `sent` rather than breaking the endpoint. Past it the handler runs
    // and fails on the absent tenant client, which is a different outcome from the 400 above — the whole
    // distinction the assertion rests on.
    for (const to of ["draft", "pending_review", "approved"]) {
      const response = await request(appAs("director"))
        .post(`/weekly-reports/reports/${REPORT}/transition`)
        .send({ to });
      expect(response.status).not.toBe(400);
    }
  });
});

const SEND_ROUTES: Array<[string, "get" | "post", string]> = [
  ["send draft", "get", `/weekly-reports/reports/${REPORT}/send-draft`],
  ["send", "post", `/weekly-reports/reports/${REPORT}/send`],
  ["retry", "post", `/weekly-reports/reports/${REPORT}/send/retry`],
  ["correction", "post", `/weekly-reports/reports/${REPORT}/correction`],
];

describe("the send routes sit behind the role gate", () => {
  it.each(SEND_ROUTES)("refuses a construction user on %s", async (_label, method, path) => {
    // 403 from the gate itself, before any handler runs — not a refusal that arrives only after the
    // handler has taken FOR UPDATE on two rows.
    expect((await request(appAs("construction"))[method](path)).status).toBe(403);
  });

  it.each(SEND_ROUTES)("refuses a field_contractor on %s", async (_label, method, path) => {
    expect((await request(appAs("field_contractor"))[method](path)).status).toBe(403);
  });

  it.each(SEND_ROUTES)("lets leadership past the gate on %s", async (_label, method, path) => {
    // Past the gate it reaches the handler and fails on the missing tenant client — which is exactly the
    // difference the refusals above rely on. A gate that refused everyone would pass those and fail this.
    expect((await request(appAs("director"))[method](path)).status).not.toBe(403);
  });
});
