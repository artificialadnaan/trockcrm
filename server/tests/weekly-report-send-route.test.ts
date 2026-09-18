import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
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
//   2. WHO MAY SEND. The CRM's send is a LEADERSHIP action — admin or director — and this file is where
//      that is pinned. It matters because the service layer suggests otherwise: `canPublishWeeklyReport`
//      allows "the assigned PM or an admin/director", but the roles that may HOLD the PM slot
//      (ASSIGNABLE_ROLES: field_contractor/construction/admin/director) do not intersect the roles these
//      routes admit except at admin/director — so the assigned-PM arm is unreachable HERE.
//
//      That is not a gap any more, and it must not be "fixed" by widening this router. The assigned PM
//      sends from /api/field/weekly-reports (field-routes.ts), over the same send-service.ts, gated by
//      `canPublishWeeklyReport` rather than by a role. Relaxing the gate below would enable nothing new
//      and would hand every superintendent in the office the leadership board, the client contact book
//      and the dismissal ledger. The refusals asserted here are load-bearing, not leftovers.
//
//   3. WHO MAY REWRITE THE CLIENT ADDRESSES the send modal pre-fills. The project routes are open to
//      every `rep`, and `client_*_email` became an email sink the moment this branch turned it into
//      `draft.recipients`.

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
const PROJECT = "0f6d2f5a-1c2b-4a3e-8b7c-2d4e6f8a0b1c";
const DEAL = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it.each(SEND_ROUTES)("refuses a rep on %s", async (_label, method, path) => {
    // A rep passes the ROUTER's own allow-list (admin/director/rep) — this refusal comes from the send
    // routes' own narrower gate. Without it a rep reached the handler and was refused only after
    // `loadSendTarget` had taken FOR UPDATE on two rows, and only because they happen not to be the PM.
    //
    // 0228 TURNED THAT "HAPPEN NOT TO BE" INTO A REAL CASE. The PM slot used to be closed to `rep`, so a
    // rep could never satisfy the assigned-PM arm of `canPublishWeeklyReport` and this gate was belt over
    // braces. The field-team roster decides the slot now and it contains `rep` logins — Adam Sherwood is
    // one — so a rep CAN be the assigned PM, and this 403 is the only thing keeping them off the
    // office-wide leadership surface. It is load-bearing from here on.
    expect((await request(appAs("rep"))[method](path)).status).toBe(403);
  });

  it.each(SEND_ROUTES)("lets leadership past the gate on %s", async (_label, method, path) => {
    // Past the gate it reaches the handler and fails on the missing tenant client — which is exactly the
    // difference the refusals above rely on. A gate that refused everyone would pass those and fail this.
    expect((await request(appAs("director"))[method](path)).status).not.toBe(403);
  });

  it("refuses the role a real assigned PM actually holds — ON THIS ROUTER, by design", async () => {
    // `construction` is what a T-Rock PM logs in as. The send service accepts them (their project row
    // names them as PM); this router does not, and that is the boundary rather than a bug. Their send is
    // POST /api/field/weekly-reports/reports/:id/send, on a mount that carries only their own reports.
    const response = await request(appAs("construction")).post(
      `/weekly-reports/reports/${REPORT}/send`,
    );
    expect(response.status).toBe(403);
  });
});

/**
 * The client contact fields are an EMAIL SINK, not ordinary setup data.
 *
 * `recipientOptionsFrom` turns `client_doc_email` and its siblings into the send modal's pre-selected
 * recipients. The project routes admit every `rep` in the office, so without a gate any of them could
 * typo-squat a client address on any project and wait: the next director to press Send delivers that
 * client's report, the attached PDF and a live 180-day unauthenticated link to the attacker's mailbox,
 * with the CRM showing an entirely ordinary send.
 */
describe("who may change the addresses a report is sent to", () => {
  const contactPatch = { clientTeam: { doc: { name: "Jay", email: "jay@examp1e.com" } } };

  it("refuses a rep supplying client contacts on create", async () => {
    const response = await request(appAs("rep"))
      .post("/weekly-reports/projects")
      .send({ dealId: DEAL, ...contactPatch });
    expect(response.status).toBe(403);
    expect(String(response.body?.error?.message ?? response.body?.message ?? response.text)).toMatch(
      /client contacts/i,
    );
  });

  it("refuses a rep rewriting client contacts on update", async () => {
    const response = await request(appAs("rep"))
      .patch(`/weekly-reports/projects/${PROJECT}`)
      .send(contactPatch);
    expect(response.status).toBe(403);
  });

  it("still lets a rep edit the rest of the setup", async () => {
    // The gate is specific to the contacts. Past it the handler runs and fails on the absent tenant
    // client, which is a different outcome from the 403 — the whole distinction above rests on that.
    const response = await request(appAs("rep"))
      .patch(`/weekly-reports/projects/${PROJECT}`)
      .send({ cadenceWeekday: 3 });
    expect(response.status).not.toBe(403);
  });

  it("lets leadership set them", async () => {
    const response = await request(appAs("director"))
      .patch(`/weekly-reports/projects/${PROJECT}`)
      .send(contactPatch);
    expect(response.status).not.toBe(403);
  });
});

/**
 * The client link's host is config, and getting it wrong is invisible from inside the CRM.
 *
 * `/wr` is served by the API service; `publicViewerBaseUrl` falls back to FRONTEND_URL and then to the
 * request's own host, so an unset var mints links against the SPA-only CRM host, which has no such route.
 * The client's one way into their report 404s and nobody else ever sees it.
 */
describe("a client link is never minted against an unconfigured host", () => {
  it("refuses the send in production BEFORE anything is minted", async () => {
    // This used to be a console.warn AFTER commitTransaction — after the token existed, the snapshot was
    // frozen, the report was terminally `sent` and the delivery job was queued. A warning at that point
    // can only describe an email that has already gone.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_SHARE_BASE_URL", "");
    const response = await request(appAs("director")).post(`/weekly-reports/reports/${REPORT}/send`);
    expect(response.status).toBe(500);
    expect(String(response.body?.error?.message ?? response.body?.message ?? response.text)).toMatch(
      /Nothing has been sent/i,
    );
  });

  it("does not refuse when the host IS configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_SHARE_BASE_URL", "https://reports.trockcam.com");
    const response = await request(appAs("director")).post(`/weekly-reports/reports/${REPORT}/send`);
    // Falls through to the handler and dies on the missing tenant context instead — a different failure.
    expect(response.status).not.toBe(500);
  });
});
