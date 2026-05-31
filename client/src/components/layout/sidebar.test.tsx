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

  it("keeps the personal commissions navigation item rep-only", () => {
    expect(source).toContain('{ to: "/commissions", icon: DollarSign, label: "Commissions", roles: ["rep"] }');
  });

  it("includes director team commissions and admin global commissions entries", () => {
    expect(source).toContain('{ to: "/director/commissions", icon: DollarSign, label: "Team Commissions", roles: ["admin", "director"] }');
    expect(source).toContain('{ to: "/admin/commissions", icon: DollarSign, label: "Global Commissions", roles: ["admin"] }');
  });

  it("includes the admin field users page in system navigation", () => {
    expect(source).toContain('{ to: "/admin/field-users", icon: Users, label: "Field Users", roles: ["admin"] }');
  });

  it("renders Deals and Pipeline as distinct nav entries pointing to their own routes", () => {
    expect(source).toContain('{ to: "/deals", icon: Handshake, label: "Deals Dashboard", roles: ["admin", "director", "rep"] }');
    expect(source).toContain('{ to: "/pipeline", icon: Kanban, label: "Pipeline", roles: ["admin", "director", "rep"] }');
    expect(source).toContain("function getNavItemKey");
    expect(source).toContain("key={getNavItemKey(item)}");
    expect(source).not.toContain("key={item.to}");
    expect(mobileSource).toContain("function getNavItemKey");
    expect(mobileSource).toContain("key={getNavItemKey(item)}");
  });

  it("defines Capture as an external trockcam link rather than an internal route", () => {
    expect(source).toContain(
      '{ to: "https://trockcam.com", icon: Camera, label: "Capture", roles: ["admin", "director", "rep", "construction"], external: true, ariaLabel: "Open Capture in a new tab", }',
    );
    expect(mobileSource).toContain(
      '{ to: "https://trockcam.com", icon: Camera, label: "Capture", external: true, ariaLabel: "Open Capture in a new tab" }',
    );
    expect(source).not.toContain('to: "/photos/capture", icon: Camera, label: "Capture"');
    expect(mobileSource).not.toContain('to: "/photos/capture", icon: Camera, label: "Capture"');
  });
});
