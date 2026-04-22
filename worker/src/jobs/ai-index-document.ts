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

  if (!["email_message", "activity_note", "estimate_snapshot", "deal_file"].includes(payload.sourceType)) {
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

    let dealId: string | null = null;
    let normalizedText = "";
    let metadata: Record<string, unknown> = {
      sourceType: payload.sourceType,
      sourceId: payload.sourceId,
    };

    if (payload.sourceType === "email_message") {
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
      normalizedText = [email.subject, plainText].filter(Boolean).join("\n\n").trim();
      dealId = email.deal_id;
      metadata = {
        ...metadata,
        dealId,
        subject: email.subject ?? null,
        sentAt: email.sent_at,
      };
    } else if (payload.sourceType === "activity_note") {
      const activityResult = await client.query(
        `SELECT id, deal_id, type, subject, body, occurred_at
         FROM ${schemaName}.activities
         WHERE id = $1
         LIMIT 1`,
        [payload.sourceId]
      );
      const activity = activityResult.rows[0];
      if (!activity) {
        throw new Error(`Activity ${payload.sourceId} not found in ${schemaName}`);
      }

      normalizedText = [activity.type, activity.subject, activity.body].filter(Boolean).join("\n\n").trim();
      dealId = activity.deal_id;
      metadata = {
        ...metadata,
        dealId,
        activityType: activity.type,
        subject: activity.subject ?? null,
        occurredAt: activity.occurred_at,
      };
    } else if (payload.sourceType === "estimate_snapshot") {
      const estimateResult = await client.query(
        `SELECT
           s.id AS section_id,
           s.name AS section_name,
           i.id AS item_id,
           i.description,
           i.quantity,
           i.unit,
           i.total_price,
           i.notes
         FROM ${schemaName}.estimate_sections s
         LEFT JOIN ${schemaName}.estimate_line_items i ON i.section_id = s.id
         WHERE s.deal_id = $1
         ORDER BY s.display_order ASC, i.display_order ASC`,
        [payload.sourceId]
      );

      dealId = payload.sourceId;
      const sections = new Map<string, { name: string; lines: string[] }>();
      for (const row of estimateResult.rows) {
        if (!sections.has(row.section_id)) {
          sections.set(row.section_id, { name: row.section_name, lines: [] });
        }
        if (row.item_id) {
          sections.get(row.section_id)!.lines.push(
            [row.description, row.quantity ? `qty ${row.quantity}` : null, row.unit, row.total_price ? `total ${row.total_price}` : null, row.notes]
              .filter(Boolean)
              .join(" | ")
          );
        }
      }

      normalizedText = Array.from(sections.values())
        .map((section) => [section.name, ...section.lines].join("\n"))
        .join("\n\n")
        .trim();
      metadata = {
        ...metadata,
        dealId,
        sectionCount: sections.size,
        lineItemCount: estimateResult.rows.filter((row) => row.item_id).length,
      };
    } else {
      const fileResult = await client.query(
        `SELECT
           id,
           deal_id,
           category,
           display_name,
           original_filename,
           description,
           notes,
           tags,
           intake_requirement_key,
           created_at
         FROM ${schemaName}.files
         WHERE id = $1
           AND is_active = TRUE
         LIMIT 1`,
        [payload.sourceId]
      );
      const file = fileResult.rows[0];
      if (!file) {
        throw new Error(`File ${payload.sourceId} not found in ${schemaName}`);
      }

      dealId = file.deal_id;
      normalizedText = [
        file.display_name,
        file.original_filename && file.original_filename !== file.display_name
          ? file.original_filename
          : null,
        file.description,
        file.notes,
        Array.isArray(file.tags) && file.tags.length > 0 ? file.tags.join(" ") : null,
        file.intake_requirement_key === "scope_docs" ? "scope document uploaded for estimating" : null,
      ]
        .filter((value): value is string => Boolean(value && String(value).trim()))
        .join("\n\n")
        .trim();
      metadata = {
        ...metadata,
        dealId,
        category: file.category ?? null,
        displayName: file.display_name ?? null,
        originalFilename: file.original_filename ?? null,
        intakeRequirementKey: file.intake_requirement_key ?? null,
        uploadedAt: file.created_at ?? null,
      };
    }

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
          dealId,
          contentHash,
          JSON.stringify(metadata),
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
          dealId,
          contentHash,
          JSON.stringify(metadata),
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
      metadata,
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
