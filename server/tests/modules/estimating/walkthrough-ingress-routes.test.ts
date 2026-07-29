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
import { getCrmFileBucket } from "../../../src/modules/estimating/walkthrough-ingress-service.js";

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

/** The per-call mocks of the LAST invocation, so a call that REJECTS can still be inspected —
 *  `invokeRoute` cannot return them once the rethrowing `next` below turns the failure into a
 *  rejection, and "commitTransaction was never called" is exactly what the failure paths must prove. */
let lastCommitTransaction: ReturnType<typeof vi.fn>;
let lastNext: ReturnType<typeof vi.fn>;

async function invokeRoute(
  method: "post",
  path: string,
  options?: { params?: Record<string, string>; body?: any }
) {
  const handler = findRouteHandler(method, path);
  const commitTransaction = vi.fn(async () => {});
  lastCommitTransaction = commitTransaction;
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
  lastNext = next;

  await handler(req, res, next);
  return { req, res, commitTransaction, next };
}

const SCOPE_ROW: WalkthroughScopeRow = {
  sourceScopeItemId: "scope-1",
  rawLabel: "Replace wall base throughout the corridor",
  trade: "flooring",
  divisionHint: "09",
  // Spoken and confirmed. A null here is refused by validateWalkthroughIngressPayload — see the
  // "no spoken quantity" case below — because downstream a null is priced as one unit.
  quantity: 64,
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
  quantity: 1,
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
  contactSheetBucket: getCrmFileBucket(),
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
    // Everything below reached the service before this PR: `rows: [null]` and a row missing rawLabel
    // both died as a 500 from inside the transaction, and a foreign bucket succeeded into a file row
    // whose download URL points at an object that is not there.
    ["a row is null", { ...BODY_WITHOUT_ROWS, rows: [null] }],
    ["a row has no rawLabel", { ...BODY_WITHOUT_ROWS, rows: [{ ...SCOPE_ROW, rawLabel: undefined }] }],
    ["confidence is outside 0-1", { ...BODY_WITHOUT_ROWS, rows: [{ ...SCOPE_ROW, confidence: 42 }] }],
    ["capturedAt is unparseable", { ...BODY, capturedAt: "last tuesday" }],
    ["contactSheetMimeType is not accepted", { ...BODY, contactSheetMimeType: "image/png" }],
    ["the contact sheet is in another bucket", { ...BODY, contactSheetBucket: "trock-scope" }],
    ["siteLabel is missing", { ...BODY, siteLabel: undefined }],
  ])("rejects with 400 when %s, without touching the database", async (_label, body) => {
    await expect(
      invokeRoute("post", ROUTE_PATH, { params: { id: "deal-1" }, body })
    ).rejects.toMatchObject({ statusCode: 400 });

    // The point of validating first: a malformed walkthrough must not buy a contact-sheet file row
    // and a parse run to hold nothing, must not cost a deal lookup, and must not be reported as a
    // success. Committing an empty transaction would report exactly that.
    expect(walkthroughIngressMocks.ingestWalkthrough).not.toHaveBeenCalled();
    expect(dealsServiceMocks.getDealById).not.toHaveBeenCalled();
    expect(lastCommitTransaction).not.toHaveBeenCalled();
  });

  // Called out separately from the table above because it is the rule the whole export is built on,
  // and because the message has to NAME the row: downstream a quantity-less row is priced as one unit
  // (`Number(extraction.quantity ?? 1)`), so the sender needs to know which utterance to go fix.
  it("rejects with 400, naming the row, when a scope row has no spoken quantity", async () => {
    await expect(
      invokeRoute("post", ROUTE_PATH, {
        params: { id: "deal-1" },
        body: { ...BODY, rows: [SCOPE_ROW, { ...SECOND_SCOPE_ROW, quantity: null }] },
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("scope-2"),
    });

    expect(walkthroughIngressMocks.ingestWalkthrough).not.toHaveBeenCalled();
    expect(lastCommitTransaction).not.toHaveBeenCalled();
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
    expect(lastCommitTransaction).not.toHaveBeenCalled();
  });

  // The path everything else in this file assumes but nothing was proving: the ingress itself fails.
  // The handler must hand that error to `next` (so the error middleware renders it and the tenant
  // middleware rolls the request's transaction back) and must NOT commit — a commit here would turn a
  // failed ingress into a 201 with a body built from an exception that never produced any rows.
  it("hands an ingress failure to next without committing", async () => {
    const failure = Object.assign(new Error("Walkthrough ingress requires at least one scope row"), {
      statusCode: 400,
    });
    walkthroughIngressMocks.ingestWalkthrough.mockRejectedValue(failure);

    await expect(
      invokeRoute("post", ROUTE_PATH, { params: { id: "deal-1" }, body: BODY })
    ).rejects.toBe(failure);

    expect(walkthroughIngressMocks.ingestWalkthrough).toHaveBeenCalledTimes(1);
    expect(lastNext).toHaveBeenCalledTimes(1);
    expect(lastNext).toHaveBeenCalledWith(failure);
    expect(lastCommitTransaction).not.toHaveBeenCalled();
  });
});
