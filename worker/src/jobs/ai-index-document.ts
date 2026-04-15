import crypto from "crypto";
import { pool } from "../db.js";

const SERVER_AI_DOCUMENT_SERVICE_MODULES = [
  "../../../server/dist/modules/ai-copilot/document-service.js",
  "../../../server/src/modules/ai-copilot/document-service.js",
] as const;

async function importFirstAvailable<T>(paths: readonly string[]): Promise<T> {
  let lastError: unknown;

  for (const path of paths) {
    try {
      return (await import(path)) as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to import server AI document module");
}

export async function runAiIndexDocument(payload: {
  sourceType: string;
  sourceId: string;
  officeId?: string | null;
}, officeId: string | null): Promise<void> {
  console.log(
    `[Worker:ai-index-document] Index request sourceType=${payload.sourceType} sourceId=${payload.sourceId}`
  );

  const resolvedOfficeId = payload.officeId ?? officeId;
  if (!resolvedOfficeId) {
    throw new Error("ai_index_document requires officeId");
  }

  if (payload.sourceType !== "email_message") {
    console.log(`[Worker:ai-index-document] Skipping unsupported sourceType=${payload.sourceType}`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const officeResult = await client.query(
      "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true LIMIT 1",
      [resolvedOfficeId]
    );
    const officeSlug = officeResult.rows[0]?.slug;
    if (!officeSlug) {
      throw new Error(`Active office not found for ${resolvedOfficeId}`);
    }

    const schemaName = `office_${officeSlug}`;
    const { htmlToPlainText, buildDocumentChunks } = await importFirstAvailable<{
      htmlToPlainText: (html: string) => string;
      buildDocumentChunks: (input: {
        documentId: string;
        text: string;
        metadata: Record<string, unknown>;
      }) => Array<{
        documentId: string;
        chunkIndex: number;
        text: string;
        metadata: Record<string, unknown>;
      }>;
    }>(SERVER_AI_DOCUMENT_SERVICE_MODULES);

    const emailResult = await client.query(
      `SELECT id, deal_id, subject, body_html, body_preview, sent_at
       FROM ${schemaName}.emails
       WHERE id = $1
       LIMIT 1`,
      [payload.sourceId]
    );
    const email = emailResult.rows[0];
    if (!email) {
      throw new Error(`Email ${payload.sourceId} not found in ${schemaName}`);
    }

    const plainText = htmlToPlainText(email.body_html ?? email.body_preview ?? "");
    const normalizedText = [email.subject, plainText].filter(Boolean).join("\n\n").trim();
    const contentHash = crypto.createHash("sha256").update(normalizedText).digest("hex");

    const existingResult = await client.query(
      `SELECT id, content_hash
       FROM ${schemaName}.ai_document_index
       WHERE source_type = $1 AND source_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [payload.sourceType, payload.sourceId]
    );

    let documentId = existingResult.rows[0]?.id as string | undefined;
    const existingHash = existingResult.rows[0]?.content_hash as string | undefined;

    if (documentId && existingHash === contentHash) {
      await client.query(
        `UPDATE ${schemaName}.ai_document_index
         SET index_status = 'indexed', indexed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [documentId]
      );
      await client.query("COMMIT");
      return;
    }

    if (documentId) {
      await client.query(`DELETE FROM ${schemaName}.ai_embedding_chunks WHERE document_id = $1`, [documentId]);
      await client.query(
        `UPDATE ${schemaName}.ai_document_index
         SET deal_id = $2,
             index_status = 'indexing',
             content_hash = $3,
             metadata_json = $4::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          documentId,
          email.deal_id,
          contentHash,
          JSON.stringify({
            sourceType: payload.sourceType,
            sourceId: payload.sourceId,
            dealId: email.deal_id,
            subject: email.subject ?? null,
            sentAt: email.sent_at,
          }),
        ]
      );
    } else {
      const insertResult = await client.query(
        `INSERT INTO ${schemaName}.ai_document_index
           (source_type, source_id, deal_id, index_status, content_hash, metadata_json, updated_at)
         VALUES ($1, $2, $3, 'indexing', $4, $5::jsonb, NOW())
         RETURNING id`,
        [
          payload.sourceType,
          payload.sourceId,
          email.deal_id,
          contentHash,
          JSON.stringify({
            sourceType: payload.sourceType,
            sourceId: payload.sourceId,
            dealId: email.deal_id,
            subject: email.subject ?? null,
            sentAt: email.sent_at,
          }),
        ]
      );
      documentId = insertResult.rows[0]?.id as string | undefined;
    }

    if (!documentId) {
      throw new Error("Failed to create ai document index entry");
    }

    const chunks = buildDocumentChunks({
      documentId,
      text: normalizedText,
      metadata: {
        sourceType: payload.sourceType,
        sourceId: payload.sourceId,
        dealId: email.deal_id,
        subject: email.subject ?? null,
        sentAt: email.sent_at,
      },
    });

    for (const chunk of chunks) {
      await client.query(
        `INSERT INTO ${schemaName}.ai_embedding_chunks
           (document_id, chunk_index, text, embedding, token_count, metadata_json)
         VALUES ($1, $2, $3, NULL, $4, $5::jsonb)`,
        [
          chunk.documentId,
          chunk.chunkIndex,
          chunk.text,
          chunk.text.split(/\s+/).filter(Boolean).length,
          JSON.stringify(chunk.metadata),
        ]
      );
    }

    await client.query(
      `UPDATE ${schemaName}.ai_document_index
       SET index_status = 'indexed', indexed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [documentId]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
