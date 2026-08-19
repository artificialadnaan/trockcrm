/**
 * Pins WHICH ROUTER the superintendent's weekly-report endpoints live on.
 *
 * This is the trap the glasses-walkthrough rollout fell into and the reason that test exists: the
 * endpoints were built on a CRM router, but their only caller is T-Rock Cam, which authenticates through
 * `/auth/field-login` and gets a `surface: "field"` token that `authMiddleware` rejects on every CRM route
 * by design (#722). The result was not a degraded feature but an unusable app — every call 401'd, and the
 * client reads 401 as a dead session and signs the user out.
 *
 * Weekly Reports is the same shape twice over: the CRM router at /api/weekly-reports is deliberately
 * gated to admin/director/rep (its dashboard carries every project's client contacts and the leadership
 * digest recipients), so a superintendent could never reach it even with a CRM token. So this asserts the
 * boundary itself — the wizard's endpoints answer on the FIELD surface, and the leadership endpoints
 * refuse a field session — rather than any handler behaviour, which the runtime suite covers.
 */
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// A field session, exactly what T-Rock Cam presents to /api/field.
vi.mock("../src/middleware/auth.js", () => ({
  authMiddleware: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.user = {
      id: "field-1",
      email: "super@example.com",
      displayName: "Steve Sanchez",
      role: "construction",
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    next();
  },
}));

vi.mock("../src/middleware/tenant.js", () => ({
  tenantMiddleware: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.tenantDb = {};
    req.tenantClient = { query: async () => ({ rows: [], rowCount: 0 }) };
    req.officeSlug = "dallas";
    req.commitTransaction = async () => {};
    next();
  },
}));

const { createApp } = await import("../src/app.js");

const REPORT = "00000000-0000-4000-8000-000000000001";

describe("weekly-report field route surface", () => {
  it.each([
    ["GET", "/api/field/weekly-reports/assignments"],
    ["POST", "/api/field/weekly-reports/reports"],
    ["GET", `/api/field/weekly-reports/reports/${REPORT}`],
    ["PATCH", `/api/field/weekly-reports/reports/${REPORT}`],
    ["GET", `/api/field/weekly-reports/reports/${REPORT}/photo-candidates`],
    ["PUT", `/api/field/weekly-reports/reports/${REPORT}/photos`],
    ["POST", `/api/field/weekly-reports/reports/${REPORT}/transition`],
    ["POST", "/api/field/weekly-reports/dictation"],
    // The send, which is the whole reason this mount exists for a PM. On the CRM router these four are
    // gated admin/director, and the roles that may HOLD the PM slot do not intersect that except at
    // leadership — so before they were mounted here the assigned PM could not send their own report at all.
    ["GET", `/api/field/weekly-reports/reports/${REPORT}/send-draft`],
    ["POST", `/api/field/weekly-reports/reports/${REPORT}/send`],
    ["POST", `/api/field/weekly-reports/reports/${REPORT}/send/retry`],
    ["POST", `/api/field/weekly-reports/reports/${REPORT}/correction`],
  ])("registers %s %s on the FIELD router, where T-Rock Cam can reach it", async (method, path) => {
    const agent = request(createApp()) as any;
    const response = await agent[method.toLowerCase()](path).send({});

    // The route must EXIST. It will not succeed here — there is no Authorization header, so
    // requireFieldContractor answers 401 — but a 401 proves a handler is mounted and running its guard,
    // whereas 404 would mean the endpoint is not on the surface its only caller can reach.
    expect(response.status).not.toBe(404);
    expect(response.status).toBe(401);
  });

  it("exposes ONLY the authoring endpoints on the field surface", async () => {
    // Asserted structurally rather than over HTTP: the router applies requireFieldContractor to the whole
    // mount, so an unauthenticated request to a non-existent path answers 401 before routing and cannot
    // tell "no such endpoint" from "not signed in".
    //
    // The list is pinned because the dangerous additions all look harmless. A superintendent who could
    // reach /dashboard would see every project's client contact block and every other crew's misses;
    // /projects would let them edit a setup; /settings names the people the digest reports them to; and
    // /projects/:id/dismiss would let them delete the record of their own missed weeks. None of those
    // belong on a surface every field user in the company can authenticate against.
    const { weeklyReportFieldRoutes } = await import("../src/modules/weekly-reports/field-routes.js");
    const paths = (weeklyReportFieldRoutes as any).stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => layer.route.path);

    expect([...new Set(paths)].sort()).toEqual([
      "/assignments",
      // Sorts first among the report routes. It is the one entry here that is NOT report authoring: it
      // takes a transcript and a character count, touches no rows, and is registered above the
      // router-wide tenantMiddleware for exactly that reason — see the ordering test below.
      "/dictation",
      "/reports",
      "/reports/:id",
      "/reports/:id/correction",
      "/reports/:id/photo-candidates",
      "/reports/:id/photos",
      "/reports/:id/send",
      "/reports/:id/send-draft",
      "/reports/:id/send/retry",
      "/reports/:id/transition",
    ]);
  });

  it("refuses `sent` on the field transition route EVEN THOUGH the send flow now exists", async () => {
    // This guard used to say sending was "not available in the app yet". That deferral is gone — the four
    // send routes above are its replacement — but the refusal itself stays, because what it stops was never
    // about the feature being unfinished.
    //
    // `canTransitionAs` grants `sent` to PM powers, so a PM reaching it through the GENERIC endpoint would
    // stamp sent_by/sent_at and freeze the header snapshot with no email composed, no token minted and no
    // delivery queued. The week stops being owed, every surface reads "Sent", and the client has nothing.
    // The row is then immutable (`canEditWeeklyReport` is false at `sent`) and un-retryable — it carries no
    // `send_request` to replay — so it sits on the board as a send that never delivered and never can.
    // Sending is POST /reports/:id/send, which does all of it in one transaction.
    const { weeklyReportFieldRoutes } = await import("../src/modules/weekly-reports/field-routes.js");
    const layer = (weeklyReportFieldRoutes as any).stack.find(
      (entry: any) => entry.route?.path === "/reports/:id/transition",
    );
    const handler = layer.route.stack[0].handle;

    let captured: unknown;
    await handler(
      { body: { to: "sent" }, params: { id: REPORT }, fieldUser: { id: "u", role: "construction" } },
      { json: () => undefined, status: () => ({ json: () => undefined }) },
      (error: unknown) => {
        captured = error;
      },
    );
    expect((captured as { statusCode?: number })?.statusCode).toBe(400);
    expect((captured as { message?: string })?.message).toMatch(/send endpoint/i);
  });

  it("routes /send/retry to the RETRY handler, not to /send", async () => {
    // The one pair on this router where a matching mistake would be silent AND destructive. `/send` is
    // registered first, so if it matched as a prefix, every Retry would be routed to the initial send —
    // which answers 409 "already sent" on a report the PM is trying to un-stick, leaving the only way
    // forward for an undelivered client report permanently unreachable from the app.
    //
    // Asserted through the router's own matcher rather than over HTTP, because the mount applies
    // requireFieldContractor to everything: an unauthenticated request to ANY path under it answers 401
    // before routing, so a supertest 401 cannot tell a correctly-routed request from a misrouted one.
    const { weeklyReportFieldRoutes } = await import("../src/modules/weekly-reports/field-routes.js");
    const matching = (path: string) =>
      (weeklyReportFieldRoutes as any).stack
        .filter((entry: any) => entry.route?.methods?.post && entry.match(path))
        .map((entry: any) => entry.route.path);

    expect(matching(`/reports/${REPORT}/send/retry`)).toEqual(["/reports/:id/send/retry"]);
    expect(matching(`/reports/${REPORT}/send`)).toEqual(["/reports/:id/send"]);
  });

  it("puts NO role gate in front of the send routes — the gate is the service's", async () => {
    // The point of moving the PM's send here is that the person holding the PM slot is normally a
    // `construction` user. A `requireRole` on these four would re-create, on this mount, the exact
    // exclusion the CRM router's gate creates and this work exists to remove — and it would do it
    // silently, because a role gate looks like ordinary hardening.
    //
    // Every one of these handlers reaches a send-service.ts function that calls `canPublishWeeklyReport`
    // itself, under FOR UPDATE on the report and its setup row. That refusal is asserted against real rows
    // in tests/modules/weekly-reports/weekly-report-field-send.runtime.test.ts, including the control
    // proving the assigned construction PM's send actually executes.
    //
    // A single handler in the stack is what "no extra middleware was attached to this route" looks like.
    // The mount-wide `requireFieldContractor + tenantMiddleware` is a router.use and is not in it — which
    // the "%s %s registers on the FIELD router" cases above prove is still running, since they 401.
    const { weeklyReportFieldRoutes } = await import("../src/modules/weekly-reports/field-routes.js");
    for (const path of [
      "/reports/:id/send-draft",
      "/reports/:id/send",
      "/reports/:id/send/retry",
      "/reports/:id/correction",
    ]) {
      const layer = (weeklyReportFieldRoutes as any).stack.find(
        (entry: any) => entry.route?.path === path,
      );
      expect(layer, `${path} is not mounted`).toBeTruthy();
      expect(layer.route.stack).toHaveLength(1);
    }
  });

  it("keeps /dictation ahead of the router-wide middleware, and everything else behind it", async () => {
    // ORDERING IS THE POINT, and it is invisible in the route list above. Express matches layers in
    // registration order, so /dictation being registered BEFORE `router.use(requireFieldContractor,
    // tenantMiddleware)` is what stops it opening an office transaction: it waits on a model call, reads
    // and writes no rows, and holding a pooled Postgres connection open for that round trip is the shape
    // of a pool-saturation outage this API has already had once. Moving it below the `use` would still
    // pass every other test in this file and quietly reintroduce that.
    //
    // It keeps requireFieldContractor of its own, so it is not a hole in the mount either — the 401 case
    // above is the control for that.
    const { weeklyReportFieldRoutes } = await import("../src/modules/weekly-reports/field-routes.js");
    const stack = (weeklyReportFieldRoutes as any).stack as Array<{ route?: { path: string } }>;
    const useIndex = stack.findIndex((layer) => !layer.route);
    const dictationIndex = stack.findIndex((layer) => layer.route?.path === "/dictation");

    expect(useIndex).toBeGreaterThanOrEqual(0);
    expect(dictationIndex).toBeGreaterThanOrEqual(0);
    expect(dictationIndex).toBeLessThan(useIndex);

    // Every OTHER route stays behind it: they all read or write rows and need the tenant transaction.
    const behind = stack
      .map((layer, index) => ({ path: layer.route?.path, index }))
      .filter((entry) => entry.path && entry.path !== "/dictation");
    expect(behind.length).toBeGreaterThan(0);
    for (const entry of behind) expect(entry.index).toBeGreaterThan(useIndex);
  });

  it("formats a dictated transcript without touching the database", async () => {
    // Drives the handler the way the transition test does. No ANTHROPIC_API_KEY here, so the service takes
    // its own local-split fallback — which is exactly the point: the endpoint answers usefully on a deploy
    // where the model pass is not configured at all.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { weeklyReportFieldRoutes } = await import("../src/modules/weekly-reports/field-routes.js");
    const layer = (weeklyReportFieldRoutes as any).stack.find(
      (entry: any) => entry.route?.path === "/dictation",
    );
    // stack[0] is requireFieldContractor; stack[1] is the handler.
    const handler = layer.route.stack.at(-1).handle;

    let body: unknown;
    const req = {
      body: { transcript: "Poured the north slab. Framing starts Monday.", existingChars: 0 },
      // Deliberately absent: tenantClient / commitTransaction. A handler that reached for either would
      // throw here rather than silently working in a test that supplied them.
    };
    await handler(req, { json: (payload: unknown) => { body = payload; } }, (error: unknown) => {
      throw error;
    });

    expect(body).toEqual({
      text: "- Poured the north slab\n- Framing starts Monday",
      source: "local",
    });
    vi.unstubAllEnvs();
  });

  it.each([
    ["dashboard", "/api/weekly-reports/dashboard"],
    ["settings", "/api/weekly-reports/settings"],
    ["projects", "/api/weekly-reports/projects"],
  ])("refuses a construction-role session on the CRM %s endpoint", async (_label, path) => {
    // `requireCrmUser` admits `construction` (that is how superintendents reach the CRM at all), so the
    // router's own requireRole("admin","director","rep") is the only thing standing between a
    // superintendent and the office-wide board. 403, never 200.
    const response = await request(createApp()).get(path);

    expect(response.status).toBe(403);
  });
});
