import { describe, expect, it } from "vitest";
import projectDetailSource from "./project-detail-page.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("ProjectDetailPage shell", () => {
  const source = normalize(projectDetailSource);

  it("includes loading, not-found, back navigation, and read-only portfolio details", () => {
    expect(source).toContain("Projects");
    expect(source).toContain("Back to Projects");
    expect(source).toContain("Project not found");
    expect(source).toContain("Project References");
    expect(source).toContain("Stage History");
    expect(source).toContain("Procore Project ID");
    expect(source).not.toContain('role="tab"');
    expect(source).not.toContain("method: \"PATCH\"");
    expect(source).not.toContain("method: \"POST\"");
  });
});
