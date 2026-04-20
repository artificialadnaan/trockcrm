export interface NormalizedEstimatePage {
  pageNumber: number;
  sourceKind: "pdf_page" | "image";
  pageImageKey: string | null;
  width: number | null;
  height: number | null;
}

function isSupportedImageMimeType(mimeType: string) {
  return mimeType.startsWith("image/");
}

export async function normalizeEstimateDocumentPages(input: {
  filename: string;
  mimeType: string;
  storageKey: string | null;
}): Promise<NormalizedEstimatePage[]> {
  if (input.mimeType === "application/pdf") {
    return [
      {
        pageNumber: 1,
        sourceKind: "pdf_page",
        pageImageKey: input.storageKey,
        width: null,
        height: null,
      },
    ];
  }

  if (isSupportedImageMimeType(input.mimeType)) {
    return [
      {
        pageNumber: 1,
        sourceKind: "image",
        pageImageKey: input.storageKey,
        width: null,
        height: null,
      },
    ];
  }

  throw new Error(`Unsupported estimate document type: ${input.mimeType}`);
}
