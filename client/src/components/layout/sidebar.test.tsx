import { describe, expect, it } from "vitest";
import sidebarSource from "./sidebar.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("Sidebar navigation metadata", () => {
  const source = normalize(sidebarSource);

  it("keeps migration visible to directors inside the system admin group", () => {
    expect(source).toContain('{ to: "/admin/migration", icon: ArrowRightLeft, label: "Migration", roles: ["admin", "director"] }');
    expect(source).toContain('id: "system"');
    expect(source).toContain('label: "System"');
  });

  it("keeps merge queue under operations while leaving the director dashboard separate", () => {
    expect(source).toContain('{ to: "/director", icon: Shield, label: "Director", roles: ["admin", "director"] }');
    expect(source).toContain('{ to: "/admin/merge-queue", icon: GitMerge, label: "Merge Queue", roles: ["admin", "director"] }');
  });

  it("adds a rep-only commissions navigation item", () => {
    expect(source).toContain('{ to: "/commissions", icon: DollarSign, label: "Commissions", roles: ["rep"] }');
  });

  it("includes director team commissions and admin global commissions entries", () => {
    expect(source).toContain('{ to: "/director/commissions", icon: DollarSign, label: "Team Commissions", roles: ["admin", "director"] }');
    expect(source).toContain('{ to: "/admin/commissions", icon: DollarSign, label: "Global Commissions", roles: ["admin"] }');
  });
});
