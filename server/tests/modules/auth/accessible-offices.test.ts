import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authServiceMocks = vi.hoisted(() => ({
  getAccessibleOffices: vi.fn(),
}));

const authUser = {
  id: "director-1",
  role: "director" as const,
  displayName: "Director One",
  email: "director@trock.dev",
  officeId: "office-1",
  activeOfficeId: "office-1",
};

vi.mock("../../../src/middleware/auth.js", () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = authUser;
    next();
  },
}));

vi.mock("../../../src/modules/auth/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/auth/service.js")>(
    "../../../src/modules/auth/service.js"
  );

  return {
    ...actual,
    getAccessibleOffices: authServiceMocks.getAccessibleOffices,
  };
});

const { authRoutes } = await import("../../../src/modules/auth/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use(errorHandler);
  return app;
}

describe("accessible office auth route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the offices the current actor can access", async () => {
    authServiceMocks.getAccessibleOffices.mockResolvedValue([
      { id: "office-1", name: "North Office", slug: "north" },
      { id: "office-2", name: "South Office", slug: "south" },
    ]);

    const app = createTestApp();
    const res = await request(app).get("/api/auth/accessible-offices");

    expect(res.status).toBe(200);
    expect(res.body.offices).toEqual([
      { id: "office-1", name: "North Office", slug: "north" },
      { id: "office-2", name: "South Office", slug: "south" },
    ]);
    expect(authServiceMocks.getAccessibleOffices).toHaveBeenCalledWith("director-1", "director", "office-1");
  });
});
