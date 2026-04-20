import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EstimatingWorkflowShell } from "./estimating-workflow-shell";

describe("EstimatingWorkflowShell", () => {
  it("shows the document upload and pricing review states", () => {
    const html = renderToStaticMarkup(
      <EstimatingWorkflowShell
        dealId="deal-1"
        documents={[]}
        extractionRows={[]}
        matchRows={[]}
        pricingRows={[]}
        reviewEvents={[]}
        copilotEnabled
      />
    );

    expect(html).toContain("Overview");
    expect(html).toContain("Documents");
    expect(html).toContain("Draft Pricing");
    expect(html).toContain("Review Log");
  });
});
