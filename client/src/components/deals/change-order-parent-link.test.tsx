// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("react-router-dom", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { ChangeOrderParentLink } from "./change-order-parent-link";

describe("ChangeOrderParentLink", () => {
  it("links a change-order child to its parent deal with the shared project label", () => {
    const html = renderToStaticMarkup(
      <ChangeOrderParentLink parentDealId="parent-123" parentLabel="DFW-1-12826-aa" />
    );

    expect(html).toContain('href="/deals/parent-123"');
    expect(html).toContain("DFW-1-12826-aa");
    expect(html).toContain("Change order");
    expect(html).toContain('data-testid="change-order-parent-link"');
  });

  it("falls back to a generic label when no parent label is available", () => {
    const html = renderToStaticMarkup(<ChangeOrderParentLink parentDealId="parent-9" />);

    expect(html).toContain('href="/deals/parent-9"');
    expect(html).toContain("parent deal");
  });
});
