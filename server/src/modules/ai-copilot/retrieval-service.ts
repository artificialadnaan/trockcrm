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
  queryText?: string;
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

function mapRowsToChunks(rows: QueryResultRow[]): DealKnowledgeChunk[] {
  return rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    chunkIndex: Number(row.chunk_index ?? 0),
    text: row.text,
    metadata: row.metadata_json ?? {},
    distance: row.distance == null ? 1 : Number(row.distance ?? 1),
  }));
}

export async function searchDealKnowledge(
  tenantDb: TenantDb,
  input: DealKnowledgeSearchInput
): Promise<DealKnowledgeChunk[]> {
  const limit = input.limit ?? 5;
  const embeddingLiteral = `[${input.embedding.join(",")}]`;
  const result = await tenantDb.execute(sql`
    SELECT
      c.id,
      c.document_id,
      c.chunk_index,
      c.text,
      c.metadata_json,
      (c.embedding <=> ${embeddingLiteral}::vector) AS distance
    FROM ai_embedding_chunks c
    JOIN ai_document_index d ON d.id = c.document_id
    WHERE d.deal_id = ${input.dealId}
      AND c.embedding IS NOT NULL
    ORDER BY c.embedding <=> ${embeddingLiteral}::vector
    LIMIT ${limit}
  `);
  const rows = getRows(result);

  if (rows.length > 0) {
    return mapRowsToChunks(rows);
  }

  const normalizedQuery = input.queryText?.trim();
  if (normalizedQuery) {
    const lexicalResult = await tenantDb.execute(sql`
      WITH ranked_chunks AS (
        SELECT
          c.id,
          c.document_id,
          c.chunk_index,
          c.text,
          c.metadata_json,
          ts_rank_cd(
            to_tsvector('english', c.text),
            websearch_to_tsquery('english', ${normalizedQuery})
          ) AS rank
        FROM ai_embedding_chunks c
        JOIN ai_document_index d ON d.id = c.document_id
        WHERE d.deal_id = ${input.dealId}
          AND to_tsvector('english', c.text) @@ websearch_to_tsquery('english', ${normalizedQuery})
      )
      SELECT
        id,
        document_id,
        chunk_index,
        text,
        metadata_json,
        (1 - rank)::float8 AS distance
      FROM ranked_chunks
      ORDER BY rank DESC, chunk_index ASC
      LIMIT ${limit}
    `);

    const lexicalRows = getRows(lexicalResult);
    if (lexicalRows.length > 0) {
      return mapRowsToChunks(lexicalRows);
    }
  }

  const fallbackResult = await tenantDb.execute(sql`
    SELECT
      c.id,
      c.document_id,
      c.chunk_index,
      c.text,
      c.metadata_json,
      NULL::float8 AS distance
    FROM ai_embedding_chunks c
    JOIN ai_document_index d ON d.id = c.document_id
    WHERE d.deal_id = ${input.dealId}
    ORDER BY
      COALESCE(
        NULLIF(c.metadata_json->>'sentAt', '')::timestamptz,
        d.indexed_at,
        d.updated_at,
        d.created_at,
        c.created_at
      ) DESC,
      c.chunk_index ASC
    LIMIT ${limit}
  `);

  return mapRowsToChunks(getRows(fallbackResult));
}
