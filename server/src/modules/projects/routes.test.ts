import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routesSource = fs.readFileSync(path.resolve(import.meta.dirname, "./routes.ts"), "utf8");
const serviceSource = fs.readFileSync(path.resolve(import.meta.dirname, "./service.ts"), "utf8");

describe("projects API routes", () => {
  it("allows CRM users to read projects but gates manual backfill to admins", () => {
    expect(routesSource).toContain('router.get("/", async (req, res, next) =>');
    expect(routesSource).toContain('router.post("/backfill", requireRole("admin")');
  });

  it("uses tenant-scoped query clients and unqualified tenant tables for read APIs", () => {
    expect(routesSource).toContain("req.tenantClient!");
    expect(serviceSource).toContain("FROM projects p");
    expect(serviceSource).not.toContain("office_dallas.projects p");
  });
});
