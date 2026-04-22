import { describe, expect, it } from "vitest";
import { extractEstimateScopeRows } from "../../../src/modules/estimating/extraction-service.js";

describe("extractEstimateScopeRows", () => {
  it("writes normalized pricing-scope metadata into live extraction rows", () => {
    const rows = extractEstimateScopeRows({
      documentId: "doc-1",
      dealId: "deal-1",
      parseRunId: "parse-run-1",
      pages: [
        {
          pageId: "page-1",
          pageNumber: 1,
          text: "Roofing tearoff",
          metadata: {
            activeArtifact: true,
          },
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dealId: "deal-1",
      projectId: null,
      pageId: "page-1",
      extractionType: "scope_line",
      rawLabel: "Roofing tearoff",
      normalizedLabel: "roofing tearoff",
      divisionHint: null,
    });
    expect(rows[0].metadataJson).toMatchObject({
      sourceParseRunId: "parse-run-1",
      sourcePageNumber: 1,
      extractionProvider: "deterministic_parser",
      extractionMethod: "structured_normalizer",
      pricingScopeType: "trade",
      pricingScopeKey: "roofing",
    });
  });
});
