import { describe, expect, it } from "vitest";
import pageSource from "./pipeline-hygiene-page.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("PipelineHygienePage", () => {
  const source = normalize(pageSource);

  it("adapts the hygiene queue into a rep cleanup surface", () => {
    expect(source).toContain('title={isRep ? "My Cleanup" : "Pipeline Hygiene"}');
    expect(source).toContain("Decision maker:");
    expect(source).toContain("Ownership sync:");
    expect(source).toContain('row.assignedRepName ?? "Unassigned"');
  });
});
