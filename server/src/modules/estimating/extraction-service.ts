import { resolvePricingScopeFromExtraction } from "./pricing-service.js";

export interface ExtractEstimateScopeRowsInput {
  documentId: string;
  dealId: string;
  projectId?: string | null;
  parseRunId?: string | null;
  pages: Array<{
    pageId?: string | null;
    pageNumber: number;
    text: string;
    provider?: string | null;
    method?: string | null;
    blocks?: Array<{
      text: string;
      bbox?: Record<string, unknown> | null;
    }>;
    metadata?: Record<string, unknown>;
  }>;
}

function collectStructuredLines(page: ExtractEstimateScopeRowsInput["pages"][number]) {
  const blockLines =
    page.blocks
      ?.map((block, index) => ({
        rawLabel: block.text.trim(),
        evidenceText: block.text.trim(),
        evidenceBboxJson: block.bbox ?? {},
        sourceBlockIndex: index,
      }))
      .filter((line) => line.rawLabel.length > 0) ?? [];

  if (blockLines.length > 0) {
    return blockLines.slice(0, 10);
  }

  return page.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((line, index) => ({
      rawLabel: line,
      evidenceText: line,
      evidenceBboxJson: {},
      sourceBlockIndex: index,
    }));
}

export function extractEstimateScopeRows(input: ExtractEstimateScopeRowsInput) {
  return input.pages.flatMap((page) =>
    collectStructuredLines(page).map((line) => ({
        dealId: input.dealId,
        projectId: input.projectId ?? null,
        pageId: page.pageId ?? null,
        extractionType: "scope_line",
        rawLabel: line.rawLabel,
        normalizedLabel: line.rawLabel.toLowerCase(),
        quantity: null,
        unit: null,
        divisionHint: null,
        confidence: "0.50",
        evidenceText: line.evidenceText,
        evidenceBboxJson: line.evidenceBboxJson,
        provider: page.provider ?? "deterministic_parser",
        method: page.method ?? "structured_normalizer",
        metadataJson: {
          ...(page.metadata ?? {}),
          sourceParseRunId: input.parseRunId ?? null,
          sourcePageNumber: page.pageNumber,
          sourceBlockIndex: line.sourceBlockIndex,
          extractionProvider: page.provider ?? "deterministic_parser",
          extractionMethod: page.method ?? "structured_normalizer",
          ...resolvePricingScopeFromExtraction({
            divisionHint: page.metadata?.divisionHint ?? null,
            metadataJson: page.metadata ?? {},
            normalizedIntent: line.rawLabel,
            rawLabel: line.rawLabel,
          }),
        },
      }))
  );
}
