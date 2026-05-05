import { Router } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.fieldUser = {
      id: "field-1",
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
      role: "field_contractor",
      tenantId: "office-1",
      active: true,
    };
    req.user = {
      id: "field-1",
      email: "field@example.com",
      role: "field_contractor",
      activeOfficeId: "office-1",
    };
    next();
  },
  requireCrmUser: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.user = req.user ?? { id: "crm-1", role: "admin", activeOfficeId: "office-1" };
    next();
  },
}));

vi.mock("../src/middleware/auth.js", () => ({
  authMiddleware: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.user = { id: "crm-1", role: "admin", activeOfficeId: "office-1" };
    next();
  },
}));

vi.mock("../src/middleware/tenant.js", () => ({
  tenantMiddleware: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.tenantDb = { execute: vi.fn() };
    req.commitTransaction = vi.fn(async () => undefined);
    next();
  },
}));

const projectMocks = vi.hoisted(() => ({
  starFieldProject: vi.fn(),
}));

const fieldUserServiceMocks = vi.hoisted(() => ({
  acceptFieldInvite: vi.fn(),
}));

vi.mock("../src/modules/field/projects-service.js", async () => {
  const actual = await vi.importActual<typeof import("../src/modules/field/projects-service.js")>(
    "../src/modules/field/projects-service.js"
  );
  return {
    ...actual,
    starFieldProject: projectMocks.starFieldProject,
  };
});

vi.mock("../src/modules/files/routes.js", () => {
  const fileRoutes = Router();
  fileRoutes.patch("/:id", (req, res) => {
    void req;
    res.json({ ok: true });
  });
  return { fileRoutes };
});

vi.mock("../src/modules/field-users/service.js", async () => {
  const actual = await vi.importActual<typeof import("../src/modules/field-users/service.js")>(
    "../src/modules/field-users/service.js"
  );
  return {
    ...actual,
    acceptFieldInvite: fieldUserServiceMocks.acceptFieldInvite,
  };
});

const { createApp } = await import("../src/app.js");

const origin = "http://localhost:5174";
const authCookies = ["token=field-session", "csrf_token=server-token"];

describe("app CSRF cross-origin field support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "test";
    process.env.FIELD_APP_URL = origin;
    projectMocks.starFieldProject.mockResolvedValue({ starred: true });
    fieldUserServiceMocks.acceptFieldInvite.mockResolvedValue({
      user: {
        id: "field-1",
        email: "field@example.com",
        firstName: "Field",
        lastName: "User",
        role: "field_contractor",
        tenantId: "office-1",
        active: true,
      },
      token: "field-session",
    });
  });

  it("allows unsafe field requests with the cross-origin requested-with header", async () => {
    const response = await request(createApp())
      .post("/api/field/projects/deal-1/star")
      .set("Origin", origin)
      .set("Cookie", authCookies)
      .set("X-Requested-With", "XMLHttpRequest")
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ starred: true });
    expect(projectMocks.starFieldProject).toHaveBeenCalledWith(expect.anything(), "field-1", "deal-1");
  });

  it("rejects unsafe field requests without the cross-origin requested-with header", async () => {
    const response = await request(createApp())
      .post("/api/field/projects/deal-1/star")
      .set("Origin", origin)
      .set("Cookie", authCookies)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Missing required header for cross-origin request." } });
    expect(projectMocks.starFieldProject).not.toHaveBeenCalled();
  });

  it("rejects unsafe field requests with the wrong requested-with header value", async () => {
    const response = await request(createApp())
      .post("/api/field/projects/deal-1/star")
      .set("Origin", origin)
      .set("Cookie", authCookies)
      .set("X-Requested-With", "fetch")
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Missing required header for cross-origin request." } });
    expect(projectMocks.starFieldProject).not.toHaveBeenCalled();
  });

  it("preserves cookie-pair CSRF behavior for CRM files endpoints", async () => {
    const response = await request(createApp())
      .patch("/api/files/file-1")
      .set("Origin", origin)
      .set("Cookie", authCookies)
      .set("X-CSRF-Token", "server-token")
      .send({ description: "Updated" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("keeps rejecting CRM files endpoints without the CSRF cookie pair", async () => {
    const response = await request(createApp())
      .patch("/api/files/file-1")
      .set("Origin", origin)
      .set("Cookie", authCookies)
      .send({ description: "Updated" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Invalid CSRF token" } });
  });

  it("keeps public auth exemptions independent from the field requested-with header", async () => {
    const response = await request(createApp())
      .post("/api/auth/accept-invite")
      .set("Origin", origin)
      .set("Cookie", authCookies)
      .send({ token: "invite-token", password: "Password123!" });

    expect(response.status).not.toBe(403);
  });

  it("keeps logout protected by the existing CSRF cookie pair", async () => {
    const response = await request(createApp())
      .post("/api/auth/logout")
      .set("Origin", origin)
      .set("Cookie", authCookies)
      .set("X-Requested-With", "XMLHttpRequest")
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Invalid CSRF token" } });
  });

  it("allows the requested-with header in CORS preflight responses", async () => {
    const response = await request(createApp())
      .options("/api/field/projects/deal-1/star")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "x-requested-with,content-type");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-headers"].toLowerCase()).toContain("x-requested-with");
  });
});
