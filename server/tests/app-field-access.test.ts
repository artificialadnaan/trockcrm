import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/middleware/auth.js", () => ({
  authMiddleware: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.user = {
      id: "field-1",
      email: "field@example.com",
      displayName: "Field User",
      role: "field_contractor",
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    next();
  },
}));

vi.mock("../src/middleware/tenant.js", () => ({
  tenantMiddleware: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.tenantDb = {};
    next();
  },
}));

const { createApp } = await import("../src/app.js");

describe("field contractor app-level route access", () => {
  it("keeps the public health check available", async () => {
    const response = await request(createApp()).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("denies field contractors from CRM tenant routes before route handlers run", async () => {
    const response = await request(createApp()).get("/api/deals");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "CRM access required" } });
  });

  it.each([
    ["GET", "/api/files/deal/deal-1/photos"],
    ["GET", "/api/files/photo-targets/search"],
    ["GET", "/api/files/file-1"],
    ["POST", "/api/files/confirm-upload"],
    ["PATCH", "/api/files/file-1"],
    ["DELETE", "/api/files/file-1"],
  ])("denies field contractors from %s %s", async (method, path) => {
    const agent = request(createApp()) as any;
    const response = await agent[method.toLowerCase()](path);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "CRM access required" } });
  });
});
