import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DirectorFunnelTable } from "./director-funnel-table";

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("DirectorFunnelTable", () => {
  it("renders the director rep-by-rep funnel table with exact bucket columns", () => {
    const html = normalize(
      renderToStaticMarkup(
        <DirectorFunnelTable
          rows={[
            { repId: "rep-1", repName: "Alex Rep", leads: 3, qualifiedLeads: 1, opportunities: 1, dueDiligence: 2, estimating: 2 },
          ]}
        />
      )
    );

    expect(html).toContain("Representative");
    expect(html).toContain("Qualified Leads");
    expect(html).toContain("Due Diligence");
    expect(html).toContain("Bid Board Pipeline");
    expect(html).toContain("Alex Rep");
  });
});
