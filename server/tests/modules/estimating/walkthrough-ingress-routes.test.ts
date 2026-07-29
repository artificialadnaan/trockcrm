// Route-level proof for the ONLY inbound way to create estimate extractions from outside the CRM.
//
// Every other estimating route PATCHes or approves rows that a parse run already produced; nothing
// could create them. This suite covers the seam itself: the guard that refuses a walkthrough with no
// scope rows before any write happens, and the happy path that hands trock-scope's payload to
// `ingestWalkthrough` with the deal and the acting user taken from the request rather than the body.
//
// App-construction and auth follow workflow-state-routes.test.ts: the route handler is pulled straight
// off the express Router stack and invoked with a hand-built req/res, so the handler's own contract is
// what is under test — not express, and not the middleware chain in front of it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalkthroughIngressPayload, WalkthroughScopeRow } from "@trock-crm/shared/types";

const dealsServiceMocks = vi.hoisted(() => ({
  getDealById: vi.fn(),
}));

vi.mock("../../../src/modules/deals/service.js", async () => {
  const actual = await vi.importActual("../../../src/modules/deals/service.js");
  return {
    ...(actual as Record<string, unknown>),
    getDealById: dealsServiceMocks.getDealById,
  };
});

const walkthroughIngressMocks = vi.hoisted(() => ({
  ingestWalkthrough: vi.fn(),
}));

vi.mock("../../../src/modules/estimating/walkthrough-ingress-service.js", async () => {
  const actual = await vi.importActual(
    "../../../src/modules/estimating/walkthrough-ingress-service.js"
  );
  return {
    ...(actual as Record<string, unknown>),
    ingestWalkthrough: walkthroughIngressMocks.ingestWalkthrough,
  };
});

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: {
    emitLocal: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    setMaxListeners: vi.fn(),
  },
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");

const ROUTE_PATH = "/:id/estimating/walkthrough-extractions";

function findRouteHandler(method: "post", path: string) {
  const layer = (dealRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  const routeLayer = layer.route.stack.find((entry: any) => entry.method === method);
  if (!routeLayer) throw new Error(`Route handler ${method.toUpperCase()} ${path} not found`);
  return routeLayer.handle as (req: any, res: any, next: (err?: unknown) => void) => Promise<unknown>;
}

async function invokeRoute(
  method: "post",
  path: string,
  options?: { params?: Record<string, string>; body?: any }
) {
  const handler = findRouteHandler(method, path);
  const commitTransaction = vi.fn(async () => {});
  const req = {
    params: options?.params ?? {},
    body: options?.body ?? {},
    query: {},
    tenantDb: {},
    appDb: {},
    officeSlug: "office-a",
    user: {
      id: "user-1",
      role: "director",
      officeId: "office-1",
      activeOfficeId: "office-1",
    },
    commitTransaction,
  } as any;
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  } as any;
  // Rethrowing `next` is how this repo's route suites assert AppError status codes — the handler's
  // catch hands the error to next(), and the test observes it as a rejection.
  const next = vi.fn((err?: unknown) => {
    if (err) throw err;
  });

  await handler(req, res, next);
  return { req, res, commitTransaction };
}

const SCOPE_ROW: WalkthroughScopeRow = {
  sourceScopeItemId: "scope-1",
  rawLabel: "Replace wall base throughout the corridor",
  trade: "flooring",
  divisionHint: "09",
  quantity: null,
  unit: "LF",
  confidence: 0.84,
  evidenceText: "we'll need to replace the wall base throughout",
  evidence: { clipId: "clip-1", timelineMs: 41_000, frameKey: "frames/clip-1/41000.jpg" },
  locationLabel: "Corridor",
};

const SECOND_SCOPE_ROW: WalkthroughScopeRow = {
  ...SCOPE_ROW,
  sourceScopeItemId: "scope-2",
  rawLabel: "Patch and paint the ceiling at the water stain",
  trade: "painting",
  divisionHint: "09",
  unit: null,
  evidenceText: "patch and paint that ceiling where the stain is",
  evidence: { clipId: "clip-1", timelineMs: 88_000, frameKey: null },
};

/** The wire body trock-scope posts. `dealId` and `userId` are deliberately ABSENT: the route takes
 *  the deal from the URL and the actor from the authenticated session, never from the body. */
const BODY: Omit<WalkthroughIngressPayload, "dealId" | "userId"> = {
  walkthroughId: "walkthrough-1",
  projectId: null,
  contactSheetR2Key: "walkthroughs/walkthrough-1/contact-sheet.jpg",
  contactSheetBucket: "trock-scope",
  contactSheetBytes: 92_160,
  contactSheetMimeType: "image/jpeg",
  siteLabel: "Corridor 2",
  capturedAt: "2026-07-29T16:20:00Z",
  rows: [SCOPE_ROW, SECOND_SCOPE_ROW],
};

describe("POST /:id/estimating/walkthrough-extractions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dealsServiceMocks.getDealById.mockResolvedValue({ id: "deal-1" });
  });

  const { rows: _rows, ...BODY_WITHOUT_ROWS } = BODY;

  it.each([
    ["rows is missing", BODY_WITHOUT_ROWS],
    // An object keyed like an array — what a naive serializer emits — must not squeak past on
    // `.length`, which is why the guard tests Array.isArray rather than truthiness.
    ["rows is not an array", { ...BODY_WITHOUT_ROWS, rows: { "0": SCOPE_ROW, length: 1 } }],
    ["rows is an empty array", { ...BODY_WITHOUT_ROWS, rows: [] }],
  ])("rejects with 400 when %s, without touching the database", async (_label, body) => {
    await expect(
      invokeRoute("post", ROUTE_PATH, { params: { id: "deal-1" }, body })
    ).rejects.toMatchObject({ statusCode: 400 });

    // The point of validating first: a walkthrough with nothing to estimate must not buy a
    // contact-sheet file row and a parse run to hold nothing, and must not be reported as a success.
    expect(walkthroughIngressMocks.ingestWalkthrough).not.toHaveBeenCalled();
    expect(dealsServiceMocks.getDealById).not.toHaveBeenCalled();
  });

  it("creates the ingress chain and answers 201 with the result", async () => {
    walkthroughIngressMocks.ingestWalkthrough.mockResolvedValue({
      documentId: "document-1",
      parseRunId: "parse-run-1",
      fileId: "file-1",
      extractionIds: ["extraction-1", "extraction-2"],
    });

    const { res, commitTransaction } = await invokeRoute("post", ROUTE_PATH, {
      params: { id: "deal-1" },
      body: BODY,
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.documentId).toBeTruthy();
    expect(res.body.extractionIds).toHaveLength(BODY.rows.length);
    expect(res.body).toEqual({
      documentId: "document-1",
      parseRunId: "parse-run-1",
      fileId: "file-1",
      extractionIds: ["extraction-1", "extraction-2"],
    });

    // dealId comes from the URL and userId from the session — a body claiming otherwise cannot
    // redirect a walkthrough onto someone else's deal or forge its uploader.
    expect(walkthroughIngressMocks.ingestWalkthrough).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          dealId: "deal-1",
          userId: "user-1",
          walkthroughId: "walkthrough-1",
          rows: BODY.rows,
        }),
      })
    );
    expect(commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("overrides a dealId and userId claimed in the body", async () => {
    walkthroughIngressMocks.ingestWalkthrough.mockResolvedValue({
      documentId: "document-1",
      parseRunId: "parse-run-1",
      fileId: "file-1",
      extractionIds: ["extraction-1", "extraction-2"],
    });

    // A hostile body: it names someone else's deal and someone else's user. Both must lose. Spreading
    // `req.body` into the payload makes this the load-bearing detail of the handler — dealId/userId
    // have to be assigned AFTER the spread, and from the request rather than from the body.
    await invokeRoute("post", ROUTE_PATH, {
      params: { id: "deal-1" },
      body: { ...BODY, dealId: "someone-elses-deal", userId: "someone-elses-user" },
    });

    expect(walkthroughIngressMocks.ingestWalkthrough).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ dealId: "deal-1", userId: "user-1" }),
      })
    );
    // The deal that gets authorized is the one in the URL, so the one in the payload must match it.
    expect(dealsServiceMocks.getDealById).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      "director",
      "user-1"
    );
  });

  it("404s when the deal does not resolve for the acting user", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(null);

    await expect(
      invokeRoute("post", ROUTE_PATH, { params: { id: "deal-1" }, body: BODY })
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(walkthroughIngressMocks.ingestWalkthrough).not.toHaveBeenCalled();
  });
});
