import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function normalize(source: string) {
  return source.replace(/\s+/g, " ").trim();
}

describe("deal assignment task wiring", () => {
  it("creates a deal assignment task during deal creation", () => {
    const source = normalize(
      readFileSync(resolve(import.meta.dirname, "./service.ts"), "utf8")
    );

    expect(source).toContain("await createAssignmentTaskIfNeeded(tenantDb, {");
    expect(source).toContain('entityType: "deal"');
    expect(source).toContain("previousAssignedRepId: null");
    expect(source).toContain("nextAssignedRepId: newDeal.assignedRepId");
    expect(source).toContain("actorUserId: input.actorUserId");
  });

  it("passes the request actor through deal creation paths", () => {
    const routeSource = normalize(
      readFileSync(resolve(import.meta.dirname, "./routes.ts"), "utf8")
    );
    const conversionSource = normalize(
      readFileSync(resolve(import.meta.dirname, "../leads/conversion-service.ts"), "utf8")
    );

    expect(routeSource).toContain("actorUserId: req.user!.id");
    expect(conversionSource).toContain("actorUserId: input.userId");
  });
});
