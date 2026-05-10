// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KanbanScrollColumn } from "./kanban-scroll-column";

describe("KanbanScrollColumn", () => {
  it("renders a sticky header and a scrollable body region", () => {
    const html = renderToStaticMarkup(
      <KanbanScrollColumn
        header={
          <div>
            <h3>Opportunity</h3>
            <span>5</span>
          </div>
        }
        childCount={3}
      >
        <div>card-a</div>
        <div>card-b</div>
        <div>card-c</div>
      </KanbanScrollColumn>
    );

    // Sticky header
    expect(html).toContain("sticky top-0");
    // Body marked with overflow-y-auto so it scrolls internally
    expect(html).toContain("overflow-y-auto");
    // Header content
    expect(html).toContain("Opportunity");
    // All cards present in DOM (will scroll internally past the cap)
    expect(html).toContain("card-a");
    expect(html).toContain("card-b");
    expect(html).toContain("card-c");
  });

  it("uses fixed-width column shell so the parent can horizontally scroll", () => {
    const html = renderToStaticMarkup(
      <KanbanScrollColumn header={<span>Stage</span>} childCount={0}>
        <div>empty</div>
      </KanbanScrollColumn>
    );

    expect(html).toContain("w-80");
    expect(html).toContain("flex-shrink-0");
  });

  it("places the scroll body behind a min-h-0 flex-1 container so the column itself doesn't grow", () => {
    const html = renderToStaticMarkup(
      <KanbanScrollColumn header={<span>Stage</span>} childCount={0}>
        <div>empty</div>
      </KanbanScrollColumn>
    );

    expect(html).toContain("min-h-0 flex-1");
  });

  it("applies caller className to the outer column shell", () => {
    const html = renderToStaticMarkup(
      <KanbanScrollColumn
        header={<span>Stage</span>}
        childCount={0}
        className="ring-2 ring-brand-red/40"
      >
        <div>empty</div>
      </KanbanScrollColumn>
    );

    expect(html).toContain("ring-2");
    expect(html).toContain("ring-brand-red/40");
  });
});
