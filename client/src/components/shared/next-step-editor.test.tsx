import { describe, expect, it } from "vitest";
import componentSource from "./next-step-editor.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("NextStepEditor", () => {
  const source = normalize(componentSource);

  it("includes next-step, support, and decision fields", () => {
    expect(source).toContain("Save Next Step");
    expect(source).toContain("Support Needed");
    expect(source).toContain("Decision Maker");
    expect(source).toContain("supportNeededType");
    expect(source).toContain("nextStepDueAt");
  });
});
