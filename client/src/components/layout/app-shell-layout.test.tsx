import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("react-router-dom", () => ({
  Outlet: () => <span data-slot="outlet">Route content</span>,
}));

vi.mock("./sidebar", () => ({
  Sidebar: () => <aside data-slot="sidebar" />,
}));

vi.mock("./topbar", () => ({
  Topbar: () => <header data-slot="topbar" />,
}));

vi.mock("./mobile-nav", () => ({
  MobileNav: () => <nav data-slot="mobile-nav" />,
}));

import { AppShell } from "./app-shell";

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("AppShell layout", () => {
  it("wraps routed content in a shared page stack container", () => {
    const html = normalize(renderToStaticMarkup(<AppShell />));

    expect(html).toContain(
      '<main class="flex-1 overflow-auto bg-slate-50 p-4 pb-20 md:p-6 md:pb-6">',
    );
    expect(html).toContain('<div class="space-y-6"><span data-slot="outlet">Route content</span>');
    expect(html).toContain('data-slot="outlet"');
    expect(html.indexOf('<div class="space-y-6">')).toBeLessThan(html.indexOf('data-slot="outlet"'));
  });
});
