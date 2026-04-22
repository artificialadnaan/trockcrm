export interface NormalizedEstimatePage {
  pageNumber: number;
  sourceKind: "pdf_page" | "image";
  pageImageKey: string | null;
  width: number | null;
  height: number | null;
}

export const SUPPORTED_ESTIMATE_DOCUMENT_MIME_TYPES = ["application/pdf"] as const;
export const SUPPORTED_ESTIMATE_DOCUMENT_MIME_PREFIXES = ["image/"] as const;

function resolvePageImageKey(input: {
  sourceObjectKey?: string | null;
  storageKey?: string | null;
}) {
  return input.sourceObjectKey ?? input.storageKey ?? null;
}

export function isSupportedEstimateDocumentMimeType(mimeType: string) {
  return (
    SUPPORTED_ESTIMATE_DOCUMENT_MIME_TYPES.includes(mimeType as (typeof SUPPORTED_ESTIMATE_DOCUMENT_MIME_TYPES)[number]) ||
    SUPPORTED_ESTIMATE_DOCUMENT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))
  );
}

export async function normalizeEstimateDocumentPages(input: {
  filename: string;
  mimeType: string;
  storageKey?: string | null;
  sourceObjectKey?: string | null;
}): Promise<NormalizedEstimatePage[]> {
  if (input.mimeType === "application/pdf") {
    // Placeholder behavior until the real PDF parser lands: one deterministic page per document.
    return [
      {
        pageNumber: 1,
        sourceKind: "pdf_page",
        pageImageKey: resolvePageImageKey(input),
        width: null,
        height: null,
      },
    ];
  }

  if (input.mimeType.startsWith("image/")) {
    return [
      {
        pageNumber: 1,
        sourceKind: "image",
        pageImageKey: resolvePageImageKey(input),
        width: null,
        height: null,
      },
    ];
  }

  throw new Error(`Unsupported estimate document type: ${input.mimeType}`);
}
