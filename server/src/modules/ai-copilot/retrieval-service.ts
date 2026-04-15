import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

type QueryResultRow = Record<string, any>;

function getRows(result: unknown): QueryResultRow[] {
  if (Array.isArray(result)) return result as QueryResultRow[];
  if (result && typeof result === "object" && "rows" in result) {
    return ((result as { rows?: QueryResultRow[] }).rows ?? []) as QueryResultRow[];
  }
  return [];
}

export interface DealKnowledgeSearchInput {
  dealId: string;
  embedding: number[];
  limit?: number;
}

export interface DealKnowledgeChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  metadata: Record<string, unknown>;
  distance: number;
}

export async function searchDealKnowledge(
  tenantDb: TenantDb,
  input: DealKnowledgeSearchInput
): Promise<DealKnowledgeChunk[]> {
  const limit = input.limit ?? 5;
  const embeddingLiteral = `[${input.embedding.join(",")}]`;
  const result = await tenantDb.execute(sql.raw(`
    SELECT
      c.id,
      c.document_id,
      c.chunk_index,
      c.text,
      c.metadata_json,
      (c.embedding <=> '${embeddingLiteral}'::vector) AS distance
    FROM ai_embedding_chunks c
    JOIN ai_document_index d ON d.id = c.document_id
    WHERE d.deal_id = '${input.dealId}'
    ORDER BY c.embedding <=> '${embeddingLiteral}'::vector
    LIMIT ${limit}
  `));

  return getRows(result).map((row) => ({
    id: row.id,
    documentId: row.document_id,
    chunkIndex: Number(row.chunk_index ?? 0),
    text: row.text,
    metadata: row.metadata_json ?? {},
    distance: Number(row.distance ?? 0),
  }));
}
