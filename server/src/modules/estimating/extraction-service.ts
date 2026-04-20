export interface ExtractEstimateScopeRowsInput {
  documentId: string;
  dealId: string;
  projectId?: string | null;
  pages: Array<{
    pageId?: string | null;
    pageNumber: number;
    text: string;
    provider?: string | null;
    method?: string | null;
  }>;
}

export function extractEstimateScopeRows(input: ExtractEstimateScopeRowsInput) {
  return input.pages.flatMap((page) =>
    page.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 10)
      .map((line) => ({
        dealId: input.dealId,
        projectId: input.projectId ?? null,
        pageId: page.pageId ?? null,
        extractionType: "scope_line",
        rawLabel: line,
        normalizedLabel: line.toLowerCase(),
        quantity: null,
        unit: null,
        divisionHint: null,
        confidence: "0.50",
        evidenceText: line,
        evidenceBboxJson: {},
        provider: page.provider ?? "placeholder",
        method: page.method ?? "line_split",
      }))
  );
}
