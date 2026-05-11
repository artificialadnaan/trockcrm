import { describe, expect, it } from "vitest";
import projectDetailSource from "./project-detail-page.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("ProjectDetailPage shell", () => {
  const source = normalize(projectDetailSource);

  it("includes the loading, not-found, back navigation, and tab shell states", () => {
    expect(source).toContain("Projects");
    expect(source).toContain("Back to Projects");
    expect(source).toContain("Project not found");
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain("aria-selected={activeTab === tab.id}");
    expect(source).toContain('aria-label="Project detail tabs"');
    expect(source).toContain('"overview" | "team" | "documents" | "phase-history" | "source-deal"');
    expect(source).toContain("Display-only mirror");
    expect(source).not.toContain("Procore project id");
  });
});
