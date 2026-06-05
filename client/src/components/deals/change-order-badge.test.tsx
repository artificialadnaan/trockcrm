// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangeOrderBadge } from "./change-order-badge";

describe("ChangeOrderBadge", () => {
  it("renders nothing when the deal is not a change order", () => {
    expect(renderToStaticMarkup(<ChangeOrderBadge isChangeOrder={false} />)).toBe("");
    expect(renderToStaticMarkup(<ChangeOrderBadge isChangeOrder={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<ChangeOrderBadge isChangeOrder={null} />)).toBe("");
  });

  it("renders the Change Order flag with a data hook + accessible label when isChangeOrder is true", () => {
    const html = renderToStaticMarkup(<ChangeOrderBadge isChangeOrder />);

    expect(html).toContain('data-change-order="true"');
    expect(html).toContain("Change Order");
    expect(html).toContain('aria-label="Change order"');
    expect(html).toContain("title=");
  });

  it("renders the compact 'CO' label without the full word", () => {
    const html = renderToStaticMarkup(<ChangeOrderBadge isChangeOrder compact />);

    expect(html).toContain('data-change-order="true"');
    expect(html).toContain(">CO<");
    expect(html).not.toContain("Change Order");
  });

  it("merges a caller className onto the badge", () => {
    const html = renderToStaticMarkup(<ChangeOrderBadge isChangeOrder className="ml-2" />);

    expect(html).toContain("ml-2");
  });
});
