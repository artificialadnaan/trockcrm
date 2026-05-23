import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const serviceSource = readFileSync(resolve(__dirname, "../../../src/modules/contacts/service.ts"), "utf8");
const routesSource = readFileSync(resolve(__dirname, "../../../src/modules/contacts/routes.ts"), "utf8");

describe("contact list ownership contract", () => {
  it("joins owner users into contact list responses", () => {
    expect(serviceSource).toContain("ownerUserId: contacts.ownerId");
    expect(serviceSource).toContain("ownerUserName: users.displayName");
    expect(serviceSource).toContain(".leftJoin(users, eq(users.id, contacts.ownerId))");
  });

  it("supports Mine scope by filtering owner_id to the requesting user", () => {
    expect(routesSource).toContain("ownerScope");
    expect(routesSource).toContain('ownerScope === "mine" ? req.user!.id : undefined');
    expect(serviceSource).toContain("ownerUserId?: string");
    expect(serviceSource).toContain("eq(contacts.ownerId, filters.ownerUserId)");
  });

  it("keeps tenantDb list queries sequential", () => {
    expect(serviceSource).not.toContain("Promise.all([");
  });
});
