import { describe, expect, it } from "vitest";
import leadNewPageSource from "./lead-new-page.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ").trim();
}

describe("LeadNewPage select labels", () => {
  it("renders explicit user-facing labels for selected values", () => {
    const source = normalize(leadNewPageSource);

    expect(source).toContain('getSelectedOptionLabel(leadStages, formData.stageId, "Select lead stage")');
    expect(source).toContain('getSelectedOptionLabel(repOptions, formData.assignedRepId, "Select rep")');
  });
});
