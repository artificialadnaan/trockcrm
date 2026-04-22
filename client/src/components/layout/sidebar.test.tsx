import { describe, expect, it } from "vitest";
import sidebarSource from "./sidebar.tsx?raw";
import mobileNavSource from "./mobile-nav.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("Sidebar navigation metadata", () => {
  const source = normalize(sidebarSource);
  const mobileSource = normalize(mobileNavSource);

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

  it("does not key navigation entries by route alone when duplicate routes exist", () => {
    expect(source).toContain('{ to: "/deals", icon: Handshake, label: "Deals", roles: ["admin", "director", "rep"] }');
    expect(source).toContain('{ to: "/deals", icon: Kanban, label: "Pipeline", roles: ["admin", "director", "rep"] }');
    expect(source).toContain("function getNavItemKey");
    expect(source).toContain("key={getNavItemKey(item)}");
    expect(source).not.toContain("key={item.to}");
    expect(mobileSource).toContain("function getNavItemKey");
    expect(mobileSource).toContain("key={getNavItemKey(item)}");
  });
});
