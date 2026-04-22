import { describe, expect, it } from "vitest";
import companySelectorSource from "./company-selector.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ").trim();
}

describe("CompanySelector inline create", () => {
  it("avoids nested forms and intercepts Enter for inline company creation", () => {
    const source = normalize(companySelectorSource);

    expect(source).toContain("function submitInlineCompanyCreate");
    expect(source).toContain("const handleInlineCreateKeyDown");
    expect(source).toContain("event.preventDefault();");
    expect(source).toContain("event.stopPropagation();");
    expect(source).not.toContain("<form onSubmit={handleCreateSubmit}");
    expect(source).toContain('type="button" size="sm" disabled={creating} onClick={() => void handleCreateSubmit()}');
  });

  it("uses a trimmed fast debounce for search instead of the older slower delay", () => {
    const source = normalize(companySelectorSource);

    expect(source).toContain("const SEARCH_DEBOUNCE_MS = 150");
    expect(source).toContain("const trimmedQuery = query.trim();");
    expect(source).toContain("setTimeout(async () =>");
    expect(source).toContain("}, SEARCH_DEBOUNCE_MS);");
    expect(source).not.toContain("}, 300);");
  });
});
