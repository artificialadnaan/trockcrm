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

  it("renders owner labels next to company search results and the selected company without replacing the category label", () => {
    const source = normalize(companySelectorSource);

    expect(source).toContain('import { OwnerLabel } from "@/components/shared/owner-label";');
    expect(source).toContain("ownerUserId: string | null;");
    expect(source).toContain("ownerUserName: string | null;");
    expect(source).toContain("showOwnerLabel?: boolean;");
    expect(source).toContain("showOwnerLabel = false");
    expect(source).toContain("selectedOwner");
    expect(source).toContain("selectedCompanyId !== value");
    expect(source).toContain("showOwnerLabel && selectedName");
    expect(source).toContain("ownerId={selectedOwner?.ownerUserId ?? null}");
    expect(source).toContain("ownerName={selectedOwner?.ownerUserName ?? null}");
    expect(source).toContain("showOwnerLabel ? ( <OwnerLabel ownerId={company.ownerUserId}");
    expect(source).toContain("<OwnerLabel ownerId={company.ownerUserId} ownerName={company.ownerUserName}");
    expect(source).toContain('className="ml-2 text-xs text-muted-foreground"');
    expect(source).toContain("COMPANY_CATEGORY_LABELS[company.category] ?? company.category");
  });
});
