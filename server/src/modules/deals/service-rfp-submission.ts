import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { aliasedIsServiceProjectSql } from "../shared/deal-value-sql.js";

/** Normalized outbox payloads carry the configured project-type digit; only service history qualifies. */
export function serviceRfpJobSql(alias: string) {
  const body = sql.raw(`${alias}.payload->'body'->'deal'`);
  return sql`(lower(COALESCE(${body}->>'projectType', '')) IN ('4', 'service')
    OR (COALESCE(${body}->>'projectType', '') = '' AND ${body}->>'workflowRoute' = 'service'))`;
}

/** Called inside the RFP reservation/outbox transaction. Conflict preserves the FIRST attribution. */
export async function recordServiceRfpSubmission(
  db: NodePgDatabase<typeof schema>,
  officeId: string | null,
  dealId: string,
  sourceEventId: string,
  jobId: number,
) {
  if (!officeId) throw new Error("An office is required to record a service RFP submission");
  await db.execute(sql`
    INSERT INTO public.service_rfp_submissions
      (office_id, deal_id, submitted_at, assigned_rep_id, assigned_rep_name, source_event_id, evidence_basis)
    SELECT ${officeId}::uuid, d.id, COALESCE(prior.submitted_at, current_job.created_at),
           d.assigned_rep_id, u.display_name, ${sourceEventId},
           CASE WHEN prior.submitted_at IS NULL THEN 'first_submission' ELSE 'historical' END
    FROM deals d
    LEFT JOIN public.users u ON u.id = d.assigned_rep_id
    JOIN public.job_queue current_job ON current_job.id = ${jobId}
      AND current_job.office_id = ${officeId}::uuid
      AND current_job.payload->>'dealId' = d.id::text
      AND current_job.job_type IN ('rfp_request_delivery', 'rfp_bidboard_create')
    LEFT JOIN LATERAL (
      SELECT MIN(q.created_at) AS submitted_at
      FROM public.job_queue q
      WHERE q.office_id = ${officeId}::uuid AND q.payload->>'dealId' = d.id::text
        AND q.job_type IN ('rfp_request_delivery', 'rfp_bidboard_create')
        AND ${serviceRfpJobSql("q")}
        AND q.id <> ${jobId} AND q.created_at <= current_job.created_at
    ) prior ON true
    WHERE d.id = ${dealId}::uuid AND ${aliasedIsServiceProjectSql("d")}
    ON CONFLICT (office_id, deal_id) DO NOTHING
  `);
}
