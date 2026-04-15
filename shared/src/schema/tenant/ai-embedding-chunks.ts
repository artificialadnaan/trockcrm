import {
  pgTable,
  uuid,
  integer,
  text,
  jsonb,
  timestamp,
  index,
  customType,
} from "drizzle-orm/pg-core";

const vector = customType<{ data: number[] | null }>({
  dataType() {
    return "vector(1536)";
  },
});

export const aiEmbeddingChunks = pgTable(
  "ai_embedding_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding"),
    tokenCount: integer("token_count"),
    metadataJson: jsonb("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("ai_embedding_chunks_document_idx").on(table.documentId, table.chunkIndex),
  ]
);
