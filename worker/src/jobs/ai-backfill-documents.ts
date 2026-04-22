import { pool } from "../db.js";

const SUPPORTED_SOURCE_TYPES = ["email_message", "activity_note", "estimate_snapshot", "deal_file"] as const;

type SupportedSourceType = (typeof SUPPORTED_SOURCE_TYPES)[number];

function isSupportedSourceType(value: string): value is SupportedSourceType {
  return SUPPORTED_SOURCE_TYPES.includes(value as SupportedSourceType);
}

export async function runAiBackfillDocuments(payload: {
  officeId?: string | null;
  sourceType?: string | null;
  batchSize?: number | null;
}, officeId: string | null): Promise<void> {
  const resolvedOfficeId = payload.officeId ?? officeId;
  if (!resolvedOfficeId) {
    throw new Error("ai_backfill_documents requires officeId");
  }

  const requestedSourceTypes = payload.sourceType && isSupportedSourceType(payload.sourceType)
    ? [payload.sourceType]
    : [...SUPPORTED_SOURCE_TYPES];
  const batchSize = Math.max(1, Math.min(payload.batchSize ?? 100, 250));

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

    let queuedCount = 0;
    let shouldContinue = false;

    for (const sourceType of requestedSourceTypes) {
      const rows = await loadBackfillCandidates(client, schemaName, sourceType, batchSize);

      for (const row of rows) {
        await client.query(
          `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
           VALUES ('ai_index_document', $1::jsonb, $2, 'pending', NOW())`,
          [
            JSON.stringify({
              sourceType,
              sourceId: row.id,
              officeId: resolvedOfficeId,
            }),
            resolvedOfficeId,
          ]
        );
        queuedCount += 1;
      }

      if (rows.length === batchSize) {
        shouldContinue = true;
      }
    }

    if (shouldContinue) {
      await client.query(
        `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
         VALUES ('ai_backfill_documents', $1::jsonb, $2, 'pending', NOW() + INTERVAL '10 seconds')`,
        [
          JSON.stringify({
            officeId: resolvedOfficeId,
            sourceType: requestedSourceTypes.length === 1 ? requestedSourceTypes[0] : null,
            batchSize,
          }),
          resolvedOfficeId,
        ]
      );
    }

    await client.query("COMMIT");
    console.log(
      `[Worker:ai-backfill-documents] Queued ${queuedCount} indexing jobs for office=${resolvedOfficeId} sourceTypes=${requestedSourceTypes.join(",")} continue=${shouldContinue}`
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function loadBackfillCandidates(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ id: string }> }> },
  schemaName: string,
  sourceType: SupportedSourceType,
  batchSize: number
) {
  if (sourceType === "email_message") {
    return (
      await client.query(
        `SELECT e.id
         FROM ${schemaName}.emails e
         LEFT JOIN ${schemaName}.ai_document_index idx
           ON idx.source_type = 'email_message'
          AND idx.source_id = e.id
         WHERE idx.id IS NULL
         ORDER BY e.sent_at DESC NULLS LAST, e.created_at DESC
         LIMIT $1`,
        [batchSize]
      )
    ).rows;
  }

  if (sourceType === "activity_note") {
    return (
      await client.query(
        `SELECT a.id
         FROM ${schemaName}.activities a
         LEFT JOIN ${schemaName}.ai_document_index idx
           ON idx.source_type = 'activity_note'
          AND idx.source_id = a.id
         WHERE idx.id IS NULL
           AND COALESCE(NULLIF(TRIM(a.body), ''), NULLIF(TRIM(a.subject), '')) IS NOT NULL
         ORDER BY a.occurred_at DESC NULLS LAST, a.created_at DESC
         LIMIT $1`,
        [batchSize]
      )
    ).rows;
  }

  if (sourceType === "deal_file") {
    return (
      await client.query(
        `SELECT f.id
         FROM ${schemaName}.files f
         LEFT JOIN ${schemaName}.ai_document_index idx
           ON idx.source_type = 'deal_file'
          AND idx.source_id = f.id
         WHERE idx.id IS NULL
           AND f.is_active = TRUE
           AND f.deal_id IS NOT NULL
           AND f.intake_requirement_key = 'scope_docs'
         ORDER BY f.updated_at DESC, f.created_at DESC
         LIMIT $1`,
        [batchSize]
      )
    ).rows;
  }

  return (
    await client.query(
      `SELECT d.id
       FROM ${schemaName}.deals d
       WHERE EXISTS (
         SELECT 1
         FROM ${schemaName}.estimate_sections s
         WHERE s.deal_id = d.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM ${schemaName}.ai_document_index idx
         WHERE idx.source_type = 'estimate_snapshot'
           AND idx.source_id = d.id
       )
       ORDER BY d.updated_at DESC, d.created_at DESC
       LIMIT $1`,
      [batchSize]
    )
  ).rows;
}
