import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const serviceSource = readFileSync(resolve(__dirname, "../../../src/modules/companies/service.ts"), "utf8");

describe("company detail metadata contract", () => {
  it("joins owner users into company detail responses", () => {
    expect(serviceSource).toContain("ownerUserId: companies.ownerId");
    expect(serviceSource).toContain("ownerUserName: users.displayName");
    expect(serviceSource).toContain(".leftJoin(users, eq(users.id, companies.ownerId))");
  });
});
