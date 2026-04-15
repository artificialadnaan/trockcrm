export interface DocumentChunkInput {
  documentId: string;
  text: string;
  chunkSize?: number;
  metadata: Record<string, unknown>;
}

export interface DocumentChunk {
  documentId: string;
  chunkIndex: number;
  text: string;
  metadata: Record<string, unknown>;
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildDocumentChunks(input: DocumentChunkInput): DocumentChunk[] {
  const chunkSize = Math.max(1, input.chunkSize ?? 120);
  const words = input.text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: DocumentChunk[] = [];
  for (let index = 0; index < words.length; index += chunkSize) {
    chunks.push({
      documentId: input.documentId,
      chunkIndex: Math.floor(index / chunkSize),
      text: words.slice(index, index + chunkSize).join(" "),
      metadata: input.metadata,
    });
  }
  return chunks;
}
