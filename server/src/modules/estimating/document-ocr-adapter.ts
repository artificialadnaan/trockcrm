import type { NormalizedEstimatePage } from "./document-page-extractor.js";

export interface EstimateDocumentOcrBlock {
  text: string;
  bbox?: Record<string, unknown>;
}

export interface EstimateDocumentOcrResult {
  provider: string;
  method: string;
  text: string;
  blocks: EstimateDocumentOcrBlock[];
}

export interface DocumentOcrAdapter {
  run(page: NormalizedEstimatePage): Promise<EstimateDocumentOcrResult>;
}
