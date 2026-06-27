import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./system-prompt.js";
import { isNumberFree } from "./chart-seam.js";

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt();

  it("makes the SQL tools the sole source of numbers and forbids fabrication", () => {
    expect(prompt).toMatch(/own every number/i);
    expect(prompt).toMatch(/never fabricate/i);
    expect(prompt).toMatch(/describe_capabilities/);
  });

  it("ships the verbatim chart contract: trock-chart fence, dataRef/spec, no numbers rule", () => {
    expect(prompt).toContain("`trock-chart`");
    expect(prompt).toContain("`dataRef`");
    expect(prompt).toContain("NEVER write numeric values anywhere in the chart block");
    expect(prompt).toContain("A chart block containing any number will be discarded.");
  });

  it("includes a one-shot example that is itself number-free", () => {
    const fence = prompt.split("```trock-chart\n")[1]?.split("\n```")[0];
    expect(fence).toBeTruthy();
    const parsed = JSON.parse(fence as string);
    // The example the model imitates must satisfy the seam's own number-free check.
    expect(isNumberFree(parsed.spec)).toBe(true);
  });
});
