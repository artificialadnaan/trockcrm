// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SortHeaderButton } from "./sort-header-button";

describe("SortHeaderButton", () => {
  it("renders the neutral chevron + accessible label when not active", () => {
    const html = renderToStaticMarkup(
      <SortHeaderButton label="Value" active={false} dir={null} onClick={() => {}} />,
    );
    expect(html).toContain('aria-label="Sort by Value"');
    expect(html).toContain('data-sort="none"');
    expect(html).toContain("text-slate-300"); // muted neutral chevron
  });

  it("marks ascending state in both data-sort and the accessible name", () => {
    const html = renderToStaticMarkup(
      <SortHeaderButton label="Value" active dir="asc" onClick={() => {}} />,
    );
    expect(html).toContain('data-sort="ascending"');
    expect(html).toContain('aria-label="Sort by Value, sorted ascending"');
  });

  it("marks descending state in both data-sort and the accessible name", () => {
    const html = renderToStaticMarkup(
      <SortHeaderButton label="Value" active dir="desc" onClick={() => {}} />,
    );
    expect(html).toContain('data-sort="descending"');
    expect(html).toContain('aria-label="Sort by Value, sorted descending"');
  });

  it("does not announce a direction when active but dir is null", () => {
    // Not reachable through the hook, but the prop type allows it — must not claim "descending".
    const html = renderToStaticMarkup(
      <SortHeaderButton label="Value" active dir={null} onClick={() => {}} />,
    );
    expect(html).toContain('data-sort="none"');
    expect(html).toContain('aria-label="Sort by Value"');
    expect(html).not.toContain("sorted descending");
  });
});
