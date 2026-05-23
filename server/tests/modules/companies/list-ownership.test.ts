import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const serviceSource = readFileSync(resolve(__dirname, "../../../src/modules/companies/service.ts"), "utf8");
const routesSource = readFileSync(resolve(__dirname, "../../../src/modules/companies/routes.ts"), "utf8");

describe("company list ownership contract", () => {
  it("joins owner users into company list responses", () => {
    expect(serviceSource).toContain("ownerUserId: companies.ownerId");
    expect(serviceSource).toContain("ownerUserName: users.displayName");
    expect(serviceSource).toContain(".leftJoin(users, eq(users.id, companies.ownerId))");
  });

  it("supports Mine scope by filtering owner_id to the requesting user", () => {
    expect(routesSource).toContain("ownerScope");
    expect(routesSource).toContain('ownerScope === "mine" ? req.user!.id : undefined');
    expect(serviceSource).toContain("ownerUserId?: string");
    expect(serviceSource).toContain("eq(companies.ownerId, options.ownerUserId)");
  });
});
