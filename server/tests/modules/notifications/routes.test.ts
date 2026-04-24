import cors from "cors";
import express from "express";
import helmet from "helmet";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const authMiddlewareMock = vi.hoisted(() => vi.fn((req, _res, next) => {
  req.user = {
    id: "rep-1",
    email: "rep@trock.dev",
    displayName: "Rep User",
    role: "rep",
    officeId: "office-1",
    activeOfficeId: "office-1",
    mustChangePassword: false,
    authMethod: "dev",
  };
  next();
}));

const sseManagerMocks = vi.hoisted(() => ({
  registerSseConnection: vi.fn(() => vi.fn()),
  canAdmitSseConnection: vi.fn(() => true),
  writeSse: vi.fn((res, payload: string) => {
    res.write(payload);
    if (payload.includes("event: connected")) {
      res.end();
    }
  }),
  buildSsePaddingComment: vi.fn(() => ": pad\n\n"),
}));

vi.mock("../../../src/middleware/auth.js", () => ({
  authMiddleware: authMiddlewareMock,
}));

vi.mock("../../../src/modules/notifications/sse-manager.js", () => ({
  registerSseConnection: sseManagerMocks.registerSseConnection,
  canAdmitSseConnection: sseManagerMocks.canAdmitSseConnection,
  writeSse: sseManagerMocks.writeSse,
  buildSsePaddingComment: sseManagerMocks.buildSsePaddingComment,
}));

const { notificationRoutes } = await import("../../../src/modules/notifications/routes.js");

function createApp() {
  const app = express();
  app.use(helmet());
  app.use(
    cors({
      origin: ["https://frontend-production-bcab.up.railway.app"],
      credentials: true,
    })
  );
  app.use("/api/notifications", notificationRoutes);
  return app;
}

describe("notification stream route", () => {
  it("marks the SSE stream as cross-origin embeddable for the production frontend", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/notifications/stream")
      .set("Origin", "https://frontend-production-bcab.up.railway.app");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://frontend-production-bcab.up.railway.app"
    );
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });
});
