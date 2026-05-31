import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { NotificationCenter } from "./notification-center";

// renderToStaticMarkup never runs effects, so the SSE/fetch hooks stay offline here.
function render(node: React.ReactNode) {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("NotificationCenter", () => {
  it("keeps the default trigger byte-equivalent when no props are given (topbar usage unchanged)", () => {
    const html = render(<NotificationCenter />);

    // Default trigger is the compact `size-8` ghost icon button — no toolbar sizing leaks in.
    expect(html).toContain("size-8");
    expect(html).not.toContain("size-11");
    expect(html).not.toContain("rounded-full");
    // And no aria-label attribute is emitted, exactly as before this change.
    expect(html).not.toContain("aria-label");
  });

  it("applies an opt-in triggerClassName so callers can match their own toolbar", () => {
    const html = render(
      <NotificationCenter triggerClassName="size-11 rounded-full border border-slate-200 md:size-10" />
    );

    expect(html).toContain("size-11");
    expect(html).toContain("md:size-10");
    expect(html).toContain("rounded-full");
    // Same `size-*` group, so tailwind-merge cleanly drops the default `size-8`:
    // the 44px touch target wins instead of colliding with the 32px default.
    expect(html).not.toContain("size-8");
  });

  it("gives the icon-only trigger an accessible name via opt-in triggerAriaLabel", () => {
    const html = render(<NotificationCenter triggerAriaLabel="Notifications" />);

    // Icon-only buttons need an accessible name (WCAG 4.1.2); callers opt in.
    expect(html).toContain('aria-label="Notifications"');
  });
});
