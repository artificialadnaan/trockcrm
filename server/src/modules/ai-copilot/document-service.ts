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

interface DealRetrievalContext {
  deal: {
    name: string;
    stageName: string;
    proposalStatus: string | null;
  };
  recentActivities: Array<{
    subject: string | null;
    body: string | null;
  }>;
  recentEmails: Array<{
    subject: string | null;
    bodyPreview: string | null;
  }>;
}

interface DealRetrievalSignal {
  signalType: string;
  summary: string;
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

function compactSnippet(text: string | null | undefined, maxWords = 16) {
  if (!text) return null;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return words.slice(0, maxWords).join(" ");
}

export function buildDealRetrievalQuery(input: {
  context: DealRetrievalContext;
  signals: DealRetrievalSignal[];
}): string {
  const parts = [
    input.context.deal.name,
    input.context.deal.stageName,
    input.context.deal.proposalStatus?.replace(/_/g, " ") ?? null,
    ...input.signals.slice(0, 3).map((signal) => `${signal.signalType.replace(/_/g, " ")} ${signal.summary}`),
    ...input.context.recentEmails.slice(0, 2).flatMap((email) => [
      compactSnippet(email.subject, 10),
      compactSnippet(email.bodyPreview, 18),
    ]),
    ...input.context.recentActivities.slice(0, 2).flatMap((activity) => [
      compactSnippet(activity.subject, 10),
      compactSnippet(activity.body, 18),
    ]),
  ].filter(Boolean);

  return Array.from(new Set(parts)).join(" ").trim();
}
