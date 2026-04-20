import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("renders exactly one route-level h1 and keeps description/meta ordering", () => {
    const markup = renderToStaticMarkup(
      <PageHeader
        title="Deals"
        description="Track active pipeline"
        meta="24 deals"
      />,
    );

    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(markup).toContain(">Deals</h1>");
    expect(markup.indexOf(">Deals</h1>")).toBeLessThan(markup.indexOf("Track active pipeline"));
    expect(markup.indexOf("Track active pipeline")).toBeLessThan(markup.indexOf("24 deals"));
  });

  it("keeps the primary CTA in the title row and moves overflow actions into the secondary row", () => {
    const markup = renderToStaticMarkup(
      <PageHeader
        title="Users"
        actions={{
          primary: <button>Invite user</button>,
          secondaryAction: <button>Refresh</button>,
          overflow: (
            <>
              <button>Export</button>
              <button>Audit</button>
            </>
          ),
        }}
      />,
    );

    expect(markup).toContain('data-slot="page-header-actions"');
    expect(markup).toContain('data-slot="page-header-secondary-row"');
    expect(markup.indexOf('data-slot="page-header-actions"')).toBeLessThan(
      markup.indexOf("Refresh"),
    );
    expect(markup.indexOf("Invite user")).toBeLessThan(markup.indexOf("Refresh"));
    expect(markup.indexOf('data-slot="page-header-secondary-row"')).toBeLessThan(
      markup.indexOf("Export"),
    );
    expect(markup.indexOf("Export")).toBeLessThan(markup.indexOf("Audit"));
  });
});
