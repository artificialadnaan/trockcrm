import type { NormalizedEstimatePage } from "./document-page-extractor.js";
import type { EstimateDocumentOcrResult } from "./document-ocr-adapter.js";

export interface EstimateScaleDetectionResult {
  provider: string;
  method: string;
  status: "detected" | "ambiguous" | "unavailable";
  normalizedScale: string | null;
  confidence: number | null;
  evidence: Array<{
    text: string;
    bbox?: Record<string, unknown>;
  }>;
}

export interface ScaleDetectionProvider {
  detectScale(
    page: NormalizedEstimatePage,
    ocr: EstimateDocumentOcrResult
  ): Promise<EstimateScaleDetectionResult>;
}
