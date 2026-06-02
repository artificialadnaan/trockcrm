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

// renderToStaticMarkup does not lay out / measure, so the virtualizer renders
// against its initialRect estimate rather than a real scroll viewport. We assert
// the NON-VISUAL contract: the full item set is windowed (preview cap gone), the
// empty state shows with no items, and the legacy children mode (the /pipeline
// board) is untouched. Smooth scroll-through-all is a browser behavior verified
// manually, not here.

function renderVirtualized(itemCount: number, prefix = "Card") {
  return renderToStaticMarkup(
    <KanbanScrollColumn
      header={<div>Header</div>}
      childCount={itemCount}
      itemCount={itemCount}
      estimateItemSize={120}
      getItemKey={(index) => `item-${index}`}
      renderItem={(index) => <div>{`${prefix} ${String(index + 1).padStart(4, "0")}`}</div>}
    >
      <div>EMPTY STATE</div>
    </KanbanScrollColumn>
  );
}

describe("KanbanScrollColumn (virtualized mode)", () => {
  it("windows a large column through ALL items (no ~8-card preview cap) without mounting them all", () => {
    const html = renderVirtualized(824);
    // The full 824-item set is handed to the virtualizer — the old preview cap is gone.
    expect(html).toContain('data-virtualized-card-count="824"');
    // ...but only a viewport-sized window is mounted, not all 824. Assert both a
    // mid-range and the last card are absent so a "render-all" / blown-out-window
    // regression can't slip through by only checking the tail.
    expect(html).toContain("Card 0001");
    expect(html).not.toContain("Card 0400");
    expect(html).not.toContain("Card 0824");
    // The empty-state children are ignored while there are items.
    expect(html).not.toContain("EMPTY STATE");
  });

  it("renders all items for a small column", () => {
    const html = renderVirtualized(3, "Small");
    expect(html).toContain('data-virtualized-card-count="3"');
    expect(html).toContain("Small 0001");
    expect(html).toContain("Small 0002");
    expect(html).toContain("Small 0003");
  });

  it("renders the empty-state children (no virtualization) when itemCount is 0", () => {
    const html = renderToStaticMarkup(
      <KanbanScrollColumn
        header={<div>Header</div>}
        childCount={0}
        itemCount={0}
        renderItem={() => <div>should not render</div>}
      >
        <div>EMPTY STATE</div>
      </KanbanScrollColumn>
    );
    expect(html).toContain("EMPTY STATE");
    expect(html).not.toContain("data-virtualized-card-count");
    expect(html).not.toContain("should not render");
  });

  it("renders children verbatim in legacy mode (the /pipeline board) — behavior unchanged", () => {
    const html = renderToStaticMarkup(
      <KanbanScrollColumn header={<div>Header</div>} childCount={2}>
        <div>Pipeline Card A</div>
        <div>Pipeline Card B</div>
      </KanbanScrollColumn>
    );
    expect(html).toContain("Pipeline Card A");
    expect(html).toContain("Pipeline Card B");
    expect(html).not.toContain("data-virtualized-card-count");
  });
});
