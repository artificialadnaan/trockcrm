import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";
import {
  estimateDocumentPages,
  estimateExtractions,
  estimateSourceDocuments,
} from "@trock-crm/shared/schema";
import { pool } from "../db.js";
import { extractEstimateScopeRows } from "../../../server/src/modules/estimating/extraction-service.js";

async function resolveSchemaName(officeId: string | null) {
  if (!officeId) throw new Error("Unable to resolve office schema for estimating OCR");

  const result = await pool.query<{ slug: string }>(
    "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true LIMIT 1",
    [officeId]
  );

  const slug = result.rows[0]?.slug;
  if (!slug) throw new Error("Unable to resolve office schema for estimating OCR");

  return `office_${slug}`;
}

export async function markEstimateDocumentOcrFailed(
  tenantDb: ReturnType<typeof drizzle>,
  documentId: string
) {
  await tenantDb
    .update(estimateSourceDocuments)
    .set({ ocrStatus: "failed" })
    .where(eq(estimateSourceDocuments.id, documentId));
}

export async function runEstimateDocumentOcr(payload: { documentId: string; dealId?: string }, officeId: string | null) {
  const schemaName = await resolveSchemaName(officeId);
  const tenantDb = drizzle(pool, { schema, casing: "snake_case" as any });

  try {
    await tenantDb.execute(sql.raw(`SET search_path TO ${schemaName}, public`));

    const [document] = await tenantDb
      .select()
      .from(estimateSourceDocuments)
      .where(eq(estimateSourceDocuments.id, payload.documentId))
      .limit(1);

    if (!document) {
      throw new Error(`Estimate document ${payload.documentId} not found`);
    }

    const pageText = `${document.filename}\n${document.documentType}`;
    const [page] = await tenantDb
      .insert(estimateDocumentPages)
      .values({
        documentId: payload.documentId,
        pageNumber: 1,
        sheetLabel: "AUTO-1",
        sheetType: document.documentType,
        ocrText: pageText,
        metadataJson: {
          extractionProvider: "placeholder",
          reprocessedAt: new Date().toISOString(),
        },
      })
      .returning();

    const extractionRows = extractEstimateScopeRows({
      documentId: payload.documentId,
      dealId: document.dealId,
      projectId: document.projectId,
      pages: [
        {
          pageId: page.id,
          pageNumber: 1,
          text: pageText,
          provider: "placeholder",
          method: "filename_seed",
        },
      ],
    });

    for (const row of extractionRows) {
      await tenantDb.insert(estimateExtractions).values({
        dealId: row.dealId,
        projectId: row.projectId,
        documentId: payload.documentId,
        pageId: row.pageId,
        extractionType: row.extractionType,
        rawLabel: row.rawLabel,
        normalizedLabel: row.normalizedLabel,
        quantity: row.quantity,
        unit: row.unit,
        divisionHint: row.divisionHint,
        confidence: row.confidence,
        evidenceText: row.evidenceText,
        evidenceBboxJson: row.evidenceBboxJson,
        metadataJson: {
          extractionProvider: row.provider,
          extractionMethod: row.method,
        },
      });
    }

    await tenantDb
      .update(estimateSourceDocuments)
      .set({ ocrStatus: "completed", parsedAt: new Date() })
      .where(eq(estimateSourceDocuments.id, payload.documentId));

    await tenantDb.execute(
      sql`INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
          VALUES (
            'estimate_generation',
            ${JSON.stringify({ documentId: payload.documentId, dealId: document.dealId })}::jsonb,
            ${officeId}::uuid,
            'pending',
            NOW()
          )`
    );
  } catch (error) {
    await tenantDb.execute(sql.raw(`SET search_path TO ${schemaName}, public`));
    await markEstimateDocumentOcrFailed(tenantDb, payload.documentId);
    throw error;
  }
}
