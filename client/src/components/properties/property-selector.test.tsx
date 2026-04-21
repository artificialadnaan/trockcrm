import { describe, expect, it } from "vitest";
import propertySelectorSource from "./property-selector.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ").trim();
}

describe("PropertySelector inline create", () => {
  it("preserves the created property label until the refetch catches up", () => {
    const source = normalize(propertySelectorSource);

    expect(source).toContain("const { properties, loading, refetch } = useProperties");
    expect(source).toContain("if (match) { setSelectedLabel(formatPropertyLabel(match)); }");
    expect(source).not.toContain("setSelectedLabel(match ? formatPropertyLabel(match) : null)");
    expect(source).toContain("void refetch();");
  });
});
