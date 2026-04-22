import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function normalize(source: string) {
  return source.replace(/\s+/g, " ").trim();
}

describe("lead assignment task wiring", () => {
  it("creates a lead assignment task during lead creation", () => {
    const source = normalize(
      readFileSync(resolve(import.meta.dirname, "./service.ts"), "utf8")
    );

    expect(source).toContain("await createAssignmentTaskIfNeeded(tenantDb, {");
    expect(source).toContain('entityType: "lead"');
    expect(source).toContain("previousAssignedRepId: null");
    expect(source).toContain("nextAssignedRepId: input.assignedRepId");
    expect(source).toContain("actorUserId: input.actorUserId");
  });

  it("passes the request actor through lead creation routes", () => {
    const source = normalize(
      readFileSync(resolve(import.meta.dirname, "./routes.ts"), "utf8")
    );

    expect(source).toContain("actorUserId: req.user!.id");
  });
});
