import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";
import { estimateSourceDocuments } from "@trock-crm/shared/schema";
import { pool } from "../db.js";

const SERVER_ESTIMATING_PARSE_MODULES = [
  "../../../server/dist/modules/estimating/document-parse-orchestrator.js",
  "../../../server/src/modules/estimating/document-parse-orchestrator.js",
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

  throw lastError instanceof Error ? lastError : new Error("Unable to import estimating parse module");
}

export async function markEstimateDocumentOcrFailed(
  tenantDb: Pick<ReturnType<typeof drizzle>, "update">,
  documentId: string
) {
  await tenantDb
    .update(estimateSourceDocuments)
    .set({ ocrStatus: "failed" })
    .where(eq(estimateSourceDocuments.id, documentId));
}

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

export async function runEstimateDocumentOcr(
  payload: {
    documentId: string;
    dealId?: string;
    parseProvider?: string | null;
    parseProfile?: string | null;
    parseMeasurementsEnabled?: boolean;
  },
  officeId: string | null
) {
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

  const { runEstimateDocumentParse } = await importFirstAvailable<{
    runEstimateDocumentParse: (input: {
      tenantDb: unknown;
      document: typeof document;
      options: {
        provider: string;
        profile: string;
        measurementsEnabled: boolean;
      };
    }) => Promise<{
      extractionCount: number;
      parseRun: { id: string };
    }>;
  }>(SERVER_ESTIMATING_PARSE_MODULES);

  const result = await runEstimateDocumentParse({
    tenantDb: tenantDb as any,
    document,
    options: {
      provider: payload.parseProvider ?? document.parseProvider ?? "default",
      profile: payload.parseProfile ?? document.parseProfile ?? "balanced",
      measurementsEnabled:
        payload.parseMeasurementsEnabled ?? document.parseMeasurementsEnabled ?? false,
    },
  });

  if (result.extractionCount === 0) {
    return;
  }

  await tenantDb.execute(
    sql`
      insert into public.job_queue (job_type, payload, office_id, status, run_after)
      select
        'estimate_generation',
        jsonb_build_object(
          'documentId',
          document.id,
          'dealId',
          document.deal_id,
          'parseRunId',
          ${result.parseRun.id}
        ),
        ${officeId}::uuid,
        'pending',
        now()
      from estimate_source_documents as document
      where document.id = ${payload.documentId}
        and document.active_parse_run_id = ${result.parseRun.id}
        and document.parse_status = 'completed'
        and document.ocr_status = 'completed'
    `
  );
}
