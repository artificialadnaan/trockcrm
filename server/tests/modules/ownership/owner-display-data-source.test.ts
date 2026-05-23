import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function normalize(source: string) {
  return source.replace(/\s+/g, " ").trim();
}

describe("owner display data sources for lead/deal contexts", () => {
  it("exposes company owner fields from the company autocomplete used by New Lead", () => {
    const source = normalize(readFileSync("server/src/modules/companies/service.ts", "utf8"));

    expect(source).toContain("ownerUserId: companies.ownerId");
    expect(source).toContain("ownerUserName: users.displayName");
    expect(source).toContain(".leftJoin(users, eq(users.id, companies.ownerId))");
  });

  it("exposes contact owner fields from company contact picker rows", () => {
    const source = normalize(readFileSync("server/src/modules/companies/service.ts", "utf8"));

    expect(source).toContain("ownerUserId: contacts.ownerId");
    expect(source).toContain("ownerUserName: users.displayName");
    expect(source).toContain(".leftJoin(users, eq(users.id, contacts.ownerId))");
  });

  it("decorates lead detail payloads with associated company and primary contact owners", () => {
    const source = normalize(readFileSync("server/src/modules/leads/service.ts", "utf8"));

    expect(source).toContain("companyOwnerUserId");
    expect(source).toContain("companyOwnerUserName");
    expect(source).toContain("primaryContactOwnerUserId");
    expect(source).toContain("primaryContactOwnerUserName");
  });

  it("decorates deal detail payloads with associated company and primary contact owners", () => {
    const source = normalize(readFileSync("server/src/modules/deals/service.ts", "utf8"));

    expect(source).toContain("companyOwnerUserId");
    expect(source).toContain("companyOwnerUserName");
    expect(source).toContain("primaryContactOwnerUserId");
    expect(source).toContain("primaryContactOwnerUserName");
  });
});
