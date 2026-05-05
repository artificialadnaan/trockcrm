import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

const serviceMocks = vi.hoisted(() => ({
  decideDueDiligenceByToken: vi.fn(),
  renderDueDiligenceDecisionPage: vi.fn(),
  renderDueDiligenceNotFoundPage: vi.fn(),
}));

vi.mock("../../../src/middleware/rate-limit.js", () => ({
  publicDueDiligenceGetLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  publicDueDiligencePostLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../../src/modules/leads/due-diligence-service.js", () => ({
  decideDueDiligenceByToken: serviceMocks.decideDueDiligenceByToken,
  renderDueDiligenceDecisionPage: serviceMocks.renderDueDiligenceDecisionPage,
  renderDueDiligenceNotFoundPage: serviceMocks.renderDueDiligenceNotFoundPage,
}));

async function loadRoutes() {
  const { leadDueDiligencePublicRoutes } = await import("../../../src/modules/leads/public-due-diligence-routes.js");
  return leadDueDiligencePublicRoutes;
}

function findRouteHandler(routes: unknown, method: "get" | "post", path: string) {
  const layer = (routes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  const routeLayer = [...layer.route.stack].reverse().find((entry: any) => entry.method === method);
  if (!routeLayer) throw new Error(`Route handler ${method.toUpperCase()} ${path} not found`);
  return routeLayer.handle as (req: any, res: any, next: (err?: unknown) => void) => unknown;
}

async function invokePost(body: Record<string, unknown>) {
  const routes = await loadRoutes();
  const handler = findRouteHandler(routes, "post", "/decide");
  const req = { body } as any;
  const res = {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    send(payload: string) {
      this.body = payload;
      return this;
    },
  } as any;
  const next = vi.fn((err?: unknown) => {
    if (err) throw err;
  });

  await handler(req, res, next);
  return { res, next };
}

async function invokeGet(query: Record<string, unknown>) {
  const routes = await loadRoutes();
  const handler = findRouteHandler(routes, "get", "/");
  const req = { query } as any;
  const res = {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    send(payload: string) {
      this.body = payload;
      return this;
    },
  } as any;
  const next = vi.fn((err?: unknown) => {
    if (err) throw err;
  });

  await handler(req, res, next);
  return { res, next };
}

beforeEach(() => {
  serviceMocks.decideDueDiligenceByToken.mockReset();
  serviceMocks.renderDueDiligenceDecisionPage.mockReset();
  serviceMocks.renderDueDiligenceNotFoundPage.mockReset();
  serviceMocks.renderDueDiligenceNotFoundPage.mockReturnValue("<html>not found</html>");
  serviceMocks.renderDueDiligenceDecisionPage.mockResolvedValue("<html>decision</html>");
});

describe("public due diligence routes", () => {
  it("renders the decision page on GET", async () => {
    const { res } = await invokeGet({ token: "a".repeat(64) });

    expect(serviceMocks.renderDueDiligenceDecisionPage).toHaveBeenCalledWith("a".repeat(64));
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toBe("<html>decision</html>");
  });

  it("renders styled 404 HTML for invalid GET tokens", async () => {
    serviceMocks.renderDueDiligenceDecisionPage.mockRejectedValueOnce(
      new AppError(404, "Due Diligence decision not found")
    );

    const { res } = await invokeGet({ token: "bad" });

    expect(res.statusCode).toBe(404);
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toBe("<html>not found</html>");
  });

  it("renders styled 400 HTML when reject reason is too short", async () => {
    serviceMocks.decideDueDiligenceByToken.mockRejectedValueOnce(
      new AppError(400, "Rejection reason must be at least 10 characters")
    );
    serviceMocks.renderDueDiligenceDecisionPage.mockResolvedValueOnce("<html>error page</html>");

    const { res } = await invokePost({
      token: "a".repeat(64),
      decision: "reject",
      reason: "short",
    });

    expect(serviceMocks.renderDueDiligenceDecisionPage).toHaveBeenCalledWith("a".repeat(64), {
      error: "Rejection reason must be at least 10 characters",
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toBe("<html>error page</html>");
  });

  it("renders styled 400 HTML for invalid decision values", async () => {
    serviceMocks.renderDueDiligenceDecisionPage.mockResolvedValueOnce("<html>invalid decision</html>");

    const { res } = await invokePost({
      token: "a".repeat(64),
      decision: "maybe",
    });

    expect(serviceMocks.decideDueDiligenceByToken).not.toHaveBeenCalled();
    expect(serviceMocks.renderDueDiligenceDecisionPage).toHaveBeenCalledWith("a".repeat(64), {
      error: "Decision must be approve or reject",
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("<html>invalid decision</html>");
  });

  it("renders styled 404 HTML for invalid POST tokens", async () => {
    serviceMocks.decideDueDiligenceByToken.mockRejectedValueOnce(
      new AppError(404, "Due Diligence decision not found")
    );

    const { res } = await invokePost({
      token: "not-a-token",
      decision: "approve",
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toBe("<html>not found</html>");
  });

  it("renders success HTML after approve decision", async () => {
    serviceMocks.decideDueDiligenceByToken.mockResolvedValueOnce({ status: "approved" });
    serviceMocks.renderDueDiligenceDecisionPage.mockResolvedValueOnce("<html>approved</html>");

    const { res } = await invokePost({
      token: "a".repeat(64),
      decision: "approve",
    });

    expect(serviceMocks.decideDueDiligenceByToken).toHaveBeenCalledWith({
      token: "a".repeat(64),
      decision: "approve",
      reason: null,
    });
    expect(serviceMocks.renderDueDiligenceDecisionPage).toHaveBeenCalledWith("a".repeat(64), {
      notice: "Decision recorded as approved.",
    });
    expect(res.body).toBe("<html>approved</html>");
  });
});
