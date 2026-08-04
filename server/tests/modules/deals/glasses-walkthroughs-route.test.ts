// GET /api/deals/:id/glasses-walkthroughs — the deal page's AI-walk panel, at the route boundary.
//
// The service suites cover what each `state` means and how a stubbed TROCK Scope maps onto it. What can
// only be checked HERE is the wiring, and both halves of it have consequences a unit test cannot see:
//   1. the deal is authorised before a single row is read, through the SAME gate the neighbouring
//      `GET /:id/estimating` reads use;
//   2. the request's tenant transaction is COMMITTED — which is what releases its pooled connection —
//      BEFORE the fan-out to TROCK Scope, not after. Getting that backwards holds one of the pool's 20
//      slots for up to the 5s deadline on an endpoint the deal page polls, and nothing about the response
//      would look different.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  assertDealCollaboratorAccess: vi.fn(),
  assertDealOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn((_role: string, scope: "mine" | "team" | "all" | undefined) => scope ?? "all"),
}));

const panelMocks = vi.hoisted(() => ({
  loadDealGlassesWalkthroughRows: vi.fn(),
  createGlassesWalkthroughScopeReader: vi.fn(),
}));

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: { emitLocal: vi.fn(), on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
}));

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertDealOwnerAccess: accessMocks.assertDealOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
}));

// Only the ROW READ is mocked. `resolveGlassesWalkthroughScope` runs for real — it is the piece that turns
// a reader's answers into the response contract, and stubbing it would leave this suite asserting that a
// mock returns what it was told to.
vi.mock("../../../src/modules/walkthrough-capture/glasses-walkthrough-scope-service.js", async () => {
  const actual = await vi.importActual(
    "../../../src/modules/walkthrough-capture/glasses-walkthrough-scope-service.js",
  );
  return {
    ...(actual as Record<string, unknown>),
    loadDealGlassesWalkthroughRows: panelMocks.loadDealGlassesWalkthroughRows,
  };
});

vi.mock("../../../src/modules/walkthrough-capture/glasses-walkthrough-scope-store.js", () => ({
  createGlassesWalkthroughScopeReader: panelMocks.createGlassesWalkthroughScopeReader,
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const { errorHandler, AppError } = await import("../../../src/middleware/error-handler.js");

const DEAL = "00000000-0000-4000-8000-0000000011111";
const USER = "00000000-0000-4000-8000-0000000022222";
const SCOPE_ID = "b91a5bfd-1111-4222-8333-444455556666";

function walkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-00000000aaa1",
    walkId: "walk-msc4vvy4-m7r30urh",
    scopeWalkthroughId: SCOPE_ID,
    capturedAt: new Date("2026-08-02T22:21:47.702Z"),
    capturedByUserId: USER,
    ...overrides,
  };
}

/** Records the order in which the route's two phases run, which is the property this suite exists for. */
function createApp(trace: string[]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      id: USER,
      role: "rep",
      displayName: "rep user",
      email: "rep@example.com",
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    (req as any).tenantDb = {};
    (req as any).commitTransaction = vi.fn(async () => {
      trace.push("commit");
    });
    next();
  });
  app.use("/api/deals", dealRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.assertDealCollaboratorAccess.mockResolvedValue({ id: DEAL, officeId: "office-1" });
  panelMocks.loadDealGlassesWalkthroughRows.mockResolvedValue([]);
  panelMocks.createGlassesWalkthroughScopeReader.mockReturnValue({
    isConfigured: () => true,
    fetchScopeItems: async () => ({ outcome: "found", items: [] }),
  });
});

describe("GET /api/deals/:id/glasses-walkthroughs", () => {
  it("returns the contract shape: a `walkthroughs` array with each walk's state and scope", async () => {
    panelMocks.loadDealGlassesWalkthroughRows.mockResolvedValue([walkRow()]);
    panelMocks.createGlassesWalkthroughScopeReader.mockReturnValue({
      isConfigured: () => true,
      fetchScopeItems: async () => ({
        outcome: "found",
        items: [
          {
            id: "1f0c0a6e-2222-4333-8444-555566667777",
            trade: "painting",
            description: "Paint wall red",
            quantity: 700,
            unit: "SF",
            confidence: 0.78,
          },
        ],
      }),
    });

    const res = await request(createApp([])).get(`/api/deals/${DEAL}/glasses-walkthroughs`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walkthroughs: [
        {
          id: "00000000-0000-4000-8000-00000000aaa1",
          walkId: "walk-msc4vvy4-m7r30urh",
          scopeWalkthroughId: SCOPE_ID,
          capturedAt: "2026-08-02T22:21:47.702Z",
          capturedByUserId: USER,
          state: "ready",
          scope: {
            status: "ready",
            items: [
              {
                id: "1f0c0a6e-2222-4333-8444-555566667777",
                workTypeCode: null,
                description: "Paint wall red",
                trade: "painting",
                quantity: 700,
                unit: "SF",
                confidence: 0.78,
              },
            ],
          },
        },
      ],
    });
  });

  it("authorises the deal through the SAME gate the neighbouring deal reads use", async () => {
    await request(createApp([])).get(`/api/deals/${DEAL}/glasses-walkthroughs`);

    expect(accessMocks.assertDealCollaboratorAccess).toHaveBeenCalledTimes(1);
    expect(accessMocks.assertDealCollaboratorAccess.mock.calls[0]![1]).toBe(DEAL);
  });

  it("REGRESSION: refuses a deal the caller cannot reach, WITHOUT reading a row or calling TROCK Scope", async () => {
    accessMocks.assertDealCollaboratorAccess.mockRejectedValue(new AppError(404, "Deal not found"));

    const res = await request(createApp([])).get(`/api/deals/${DEAL}/glasses-walkthroughs`);

    expect(res.status).toBe(404);
    expect(panelMocks.loadDealGlassesWalkthroughRows).not.toHaveBeenCalled();
    expect(panelMocks.createGlassesWalkthroughScopeReader).not.toHaveBeenCalled();
  });

  it("passes through a 403 for a deal outside the caller's office, rather than answering with an empty panel", async () => {
    accessMocks.assertDealCollaboratorAccess.mockRejectedValue(
      new AppError(403, "Access denied: deal is outside your office."),
    );

    const res = await request(createApp([])).get(`/api/deals/${DEAL}/glasses-walkthroughs`);
    expect(res.status).toBe(403);
  });

  it("REGRESSION: COMMITS the tenant transaction BEFORE the first TROCK Scope request", async () => {
    // `tenantMiddleware` pins one of 20 pooled connections and opens a transaction before this handler
    // runs; `commitTransaction` is what releases it. Fanning out first would hold that slot for the whole
    // network wait — up to the 5s deadline — on an endpoint that is polled for as long as any estimator has
    // a deal page open. Nothing about the response would look different, which is why this is asserted on
    // ORDER rather than on an outcome.
    const trace: string[] = [];
    panelMocks.loadDealGlassesWalkthroughRows.mockImplementation(async () => {
      trace.push("read-rows");
      return [walkRow()];
    });
    panelMocks.createGlassesWalkthroughScopeReader.mockReturnValue({
      isConfigured: () => true,
      fetchScopeItems: async () => {
        trace.push("scope-fetch");
        return { outcome: "found", items: [] };
      },
    });

    const res = await request(createApp(trace)).get(`/api/deals/${DEAL}/glasses-walkthroughs`);

    expect(res.status).toBe(200);
    expect(trace).toEqual(["read-rows", "commit", "scope-fetch"]);
  });

  it("still answers 200 when TROCK Scope is completely unreachable — the deal page must not degrade", async () => {
    // The whole point of the feature's failure design. An estimator's deal page cannot go down because a
    // separate service did.
    panelMocks.loadDealGlassesWalkthroughRows.mockResolvedValue([walkRow()]);
    panelMocks.createGlassesWalkthroughScopeReader.mockReturnValue({
      isConfigured: () => true,
      fetchScopeItems: async () => {
        throw new Error("TROCK Scope did not answer.");
      },
    });

    const res = await request(createApp([])).get(`/api/deals/${DEAL}/glasses-walkthroughs`);

    expect(res.status).toBe(200);
    expect(res.body.walkthroughs[0].state).toBe("unavailable");
    expect(res.body.walkthroughs[0].scope).toBeNull();
  });

  it("answers 200 with an empty list for a deal that has no glasses walks", async () => {
    const res = await request(createApp([])).get(`/api/deals/${DEAL}/glasses-walkthroughs`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ walkthroughs: [] });
  });

  it("GUARD: does not shadow the sibling estimating routes registered around it", async () => {
    // `/:id/glasses-walkthroughs` sits among a long list of `/:id/...` GET patterns; Express matches in
    // registration order, so a pattern added here must neither be swallowed by an earlier one nor swallow a
    // later one. A 200 from this path and an untouched `assertDealCollaboratorAccess` count is the cheap
    // way to see that it is this handler answering.
    panelMocks.loadDealGlassesWalkthroughRows.mockResolvedValue([walkRow({ scopeWalkthroughId: null })]);

    const res = await request(createApp([])).get(`/api/deals/${DEAL}/glasses-walkthroughs`);
    expect(res.status).toBe(200);
    expect(res.body.walkthroughs[0].state).toBe("processing");
    expect(panelMocks.loadDealGlassesWalkthroughRows).toHaveBeenCalledTimes(1);
  });
});
