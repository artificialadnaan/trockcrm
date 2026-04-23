import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { FunnelBucketRow } from "./funnel-bucket-row";

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("FunnelBucketRow", () => {
  it("renders ordered funnel bucket cards with count-only and value buckets", () => {
    const html = normalize(
      renderToStaticMarkup(
        <MemoryRouter>
          <FunnelBucketRow
            buckets={[
              { key: "lead", label: "Leads", count: 4, totalValue: null, route: "/leads", bucket: "lead" },
              { key: "qualified_lead", label: "Qualified Leads", count: 2, totalValue: null, route: "/leads", bucket: "qualified_lead" },
              { key: "opportunity", label: "Opportunities", count: 3, totalValue: null, route: "/leads", bucket: "opportunity" },
              { key: "due_diligence", label: "Due Diligence", count: 5, totalValue: 120000, route: "/deals", bucket: "due_diligence" },
              { key: "estimating", label: "Estimating", count: 6, totalValue: 300000, route: "/deals", bucket: "estimating" },
            ]}
          />
        </MemoryRouter>
      )
    );

    expect(html.indexOf("Leads")).toBeLessThan(html.indexOf("Qualified Leads"));
    expect(html.indexOf("Qualified Leads")).toBeLessThan(html.indexOf("Opportunities"));
    expect(html).toContain("$120K");
    expect(html).toContain("$300K");
  });
});
