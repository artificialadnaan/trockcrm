import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { files } from "./files.js";

export const estimateSourceDocuments = pgTable(
  "estimate_source_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    projectId: uuid("project_id"),
    fileId: uuid("file_id")
      .references(() => files.id)
      .notNull(),
    rootFileId: uuid("root_file_id").references(() => files.id),
    documentType: text("document_type").notNull(),
    filename: text("filename").notNull(),
    storageKey: text("storage_key"),
    mimeType: varchar("mime_type", { length: 255 }).notNull(),
    fileSize: bigint("file_size", { mode: "number" }),
    versionLabel: varchar("version_label", { length: 100 }),
    uploadedByUserId: uuid("uploaded_by_user_id"),
    contentHash: text("content_hash"),
    parseStatus: text("parse_status").default("queued").notNull(),
    activeParseRunId: uuid("active_parse_run_id").references(() => estimateDocumentParseRuns.id, {
      onDelete: "set null",
    }),
    parseProfile: text("parse_profile"),
    parseProvider: text("parse_provider"),
    parseErrorSummary: text("parse_error_summary"),
    ocrStatus: text("ocr_status").default("queued").notNull(),
    parsedAt: timestamp("parsed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("estimate_source_documents_deal_idx").on(table.dealId, table.createdAt),
    index("estimate_source_documents_file_idx").on(table.fileId),
  ]
);

export const estimateDocumentParseRuns = pgTable(
  "estimate_document_parse_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .references(() => estimateSourceDocuments.id, { onDelete: "cascade" })
      .notNull(),
    status: text("status").default("queued").notNull(),
    parseProfile: text("parse_profile"),
    parseProvider: text("parse_provider"),
    errorSummary: text("error_summary"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("estimate_document_parse_runs_document_idx").on(table.documentId, table.startedAt),
  ]
);

export const estimateDocumentPages = pgTable(
  "estimate_document_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .references(() => estimateSourceDocuments.id, { onDelete: "cascade" })
      .notNull(),
    pageNumber: integer("page_number").notNull(),
    sheetLabel: text("sheet_label"),
    sheetType: text("sheet_type"),
    ocrText: text("ocr_text"),
    pageImageKey: text("page_image_key"),
    metadataJson: jsonb("metadata_json").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("estimate_document_pages_document_idx").on(table.documentId, table.pageNumber),
  ]
);
