import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";
import { estimateSourceDocuments } from "@trock-crm/shared/schema";
import { pool } from "../db.js";
import { runEstimateDocumentParse } from "../../../server/src/modules/estimating/document-parse-orchestrator.js";

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

export async function runEstimateDocumentOcr(payload: { documentId: string; dealId?: string }, officeId: string | null) {
  const schemaName = await resolveSchemaName(officeId);
  const tenantDb = drizzle(pool, { schema, casing: "snake_case" as any });
  await tenantDb.execute(sql.raw(`SET search_path TO ${schemaName}, public`));

  const [document] = await tenantDb
    .select()
    .from(estimateSourceDocuments)
    .where(eq(estimateSourceDocuments.id, payload.documentId))
    .limit(1);

  if (!document) {
    throw new Error(`Estimate document ${payload.documentId} not found`);
  }

  const result = await runEstimateDocumentParse({
    tenantDb: tenantDb as any,
    document,
    options: {
      provider: document.parseProvider ?? "default",
      profile: document.parseProfile ?? "balanced",
    },
  });

  if (result.extractionCount === 0) {
    return;
  }

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
}
