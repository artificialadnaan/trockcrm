import { describe, expect, it } from "vitest";
import leadNewPageSource from "./lead-new-page.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ").trim();
}

describe("LeadNewPage select labels", () => {
  it("uses native SelectValue placeholders instead of rendering raw ids", () => {
    const source = normalize(leadNewPageSource);

    expect(source).toContain('<SelectValue placeholder="Select lead stage" />');
    expect(source).toContain('<SelectValue placeholder="Select rep" />');
    expect(source).not.toContain("getSelectedOptionLabel");
  });
});
