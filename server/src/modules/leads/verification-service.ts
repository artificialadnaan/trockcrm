import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import type {
  ExistingCustomerDecision,
  ExistingCustomerSignal,
} from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

export async function isExistingCustomer(
  tenantDb: Partial<Pick<TenantDb, "execute">>,
  companyId: string,
  primaryContactId: string | null | undefined,
  propertyId: string | null | undefined,
  asOf: Date,
  options: {
    excludeLeadId?: string | null;
  } = {}
): Promise<ExistingCustomerDecision> {
  if (typeof tenantDb.execute !== "function") {
    return { isExisting: false, signal: null };
  }

  const excludeLeadId = options.excludeLeadId ?? null;
  const contactId = primaryContactId ?? null;
  const resolvedPropertyId = propertyId ?? null;

  type ExistingCustomerSignalRow = {
    source: ExistingCustomerSignal["source"];
    type: string;
    occurred_at: Date | string;
    detail: string;
  };

  const result = await tenantDb.execute<ExistingCustomerSignalRow>(sql`
    WITH cutoff AS (
      SELECT (${asOf}::timestamptz - INTERVAL '12 months') AS cutoff_at
    ),
    signal_candidates AS (
      SELECT 'company'::text AS source,
             'lead'::text AS type,
             GREATEST(l.created_at, COALESCE(l.last_activity_at, l.created_at)) AS occurred_at,
             'Recent lead activity on company'::text AS detail
        FROM leads l
       WHERE l.company_id = ${companyId}
         AND (${excludeLeadId}::uuid IS NULL OR l.id <> ${excludeLeadId}::uuid)
      UNION ALL
      SELECT 'company', 'deal',
             GREATEST(d.created_at, COALESCE(d.last_activity_at, d.created_at)),
             'Recent deal activity on company'
        FROM deals d
       WHERE d.company_id = ${companyId}
      UNION ALL
      SELECT 'company', 'activity', a.occurred_at, COALESCE(a.subject, 'Recent activity on company')
        FROM activities a
       WHERE a.company_id = ${companyId}
      UNION ALL
      SELECT 'company', 'email', e.sent_at, COALESCE(e.subject, 'Recent email on company')
        FROM emails e
        LEFT JOIN contacts c ON c.id = e.contact_id
        LEFT JOIN deals d ON d.id = e.deal_id
       WHERE e.direction IN ('inbound','outbound')
         AND (
           c.company_id = ${companyId}
           OR d.company_id = ${companyId}
           OR (e.assigned_entity_type = 'company' AND e.assigned_entity_id = ${companyId})
         )
      UNION ALL
      SELECT 'company', 'task',
             GREATEST(t.created_at, t.updated_at, COALESCE(t.completed_at, t.created_at)),
             COALESCE(t.title, 'Recent task on company')
        FROM tasks t
        LEFT JOIN contacts c ON c.id = t.contact_id
        LEFT JOIN deals d ON d.id = t.deal_id
       WHERE c.company_id = ${companyId}
          OR d.company_id = ${companyId}
      UNION ALL
      SELECT 'company', 'lead_stage_history', h.created_at, 'Recent lead stage change on company'
        FROM lead_stage_history h
        JOIN leads l ON l.id = h.lead_id
       WHERE l.company_id = ${companyId}
         AND (${excludeLeadId}::uuid IS NULL OR l.id <> ${excludeLeadId}::uuid)
      UNION ALL
      SELECT 'company', 'deal_stage_history', h.created_at, 'Recent deal stage change on company'
       FROM deal_stage_history h
        JOIN deals d ON d.id = h.deal_id
       WHERE d.company_id = ${companyId}

      UNION ALL
      SELECT 'contact', 'lead',
             GREATEST(l.created_at, COALESCE(l.last_activity_at, l.created_at)),
             'Recent lead activity on primary contact'
        FROM leads l
       WHERE ${contactId}::uuid IS NOT NULL
         AND l.primary_contact_id = ${contactId}::uuid
         AND (${excludeLeadId}::uuid IS NULL OR l.id <> ${excludeLeadId}::uuid)
      UNION ALL
      SELECT 'contact', 'deal',
             GREATEST(d.created_at, COALESCE(d.last_activity_at, d.created_at)),
             'Recent deal activity on primary contact'
        FROM deals d
       WHERE ${contactId}::uuid IS NOT NULL
         AND d.primary_contact_id = ${contactId}::uuid
      UNION ALL
      SELECT 'contact', 'activity', a.occurred_at, COALESCE(a.subject, 'Recent activity on primary contact')
        FROM activities a
       WHERE ${contactId}::uuid IS NOT NULL
         AND a.contact_id = ${contactId}::uuid
      UNION ALL
      SELECT 'contact', 'email', e.sent_at, COALESCE(e.subject, 'Recent email on primary contact')
        FROM emails e
       WHERE ${contactId}::uuid IS NOT NULL
         AND e.direction IN ('inbound','outbound')
         AND (e.contact_id = ${contactId}::uuid OR (e.assigned_entity_type = 'contact' AND e.assigned_entity_id = ${contactId}::uuid))
      UNION ALL
      SELECT 'contact', 'task',
             GREATEST(t.created_at, t.updated_at, COALESCE(t.completed_at, t.created_at)),
             COALESCE(t.title, 'Recent task on primary contact')
        FROM tasks t
       WHERE ${contactId}::uuid IS NOT NULL
         AND t.contact_id = ${contactId}::uuid

      -- Property signals: broader than the original spec (which only required
      -- deal/lead created in 12 months) to include activities, tasks, and
      -- stage history on the property. Intentional: any of these represents
      -- real engagement with the property and should mark it as existing.
      UNION ALL
      SELECT 'property', 'lead',
             GREATEST(l.created_at, COALESCE(l.last_activity_at, l.created_at)),
             'Recent lead activity on property'
        FROM leads l
       WHERE ${resolvedPropertyId}::uuid IS NOT NULL
         AND l.property_id = ${resolvedPropertyId}::uuid
         AND (${excludeLeadId}::uuid IS NULL OR l.id <> ${excludeLeadId}::uuid)
      UNION ALL
      SELECT 'property', 'deal',
             GREATEST(d.created_at, COALESCE(d.last_activity_at, d.created_at)),
             'Recent deal activity on property'
        FROM deals d
       WHERE ${resolvedPropertyId}::uuid IS NOT NULL
         AND d.property_id = ${resolvedPropertyId}::uuid
      UNION ALL
      SELECT 'property', 'activity', a.occurred_at, COALESCE(a.subject, 'Recent activity on property')
        FROM activities a
       WHERE ${resolvedPropertyId}::uuid IS NOT NULL
         AND a.property_id = ${resolvedPropertyId}::uuid
      UNION ALL
      SELECT 'property', 'task',
             GREATEST(t.created_at, t.updated_at, COALESCE(t.completed_at, t.created_at)),
             COALESCE(t.title, 'Recent task on property')
        FROM tasks t
        JOIN deals d ON d.id = t.deal_id
       WHERE ${resolvedPropertyId}::uuid IS NOT NULL
         AND d.property_id = ${resolvedPropertyId}::uuid
      UNION ALL
      SELECT 'property', 'lead_stage_history', h.created_at, 'Recent lead stage change on property'
        FROM lead_stage_history h
        JOIN leads l ON l.id = h.lead_id
       WHERE ${resolvedPropertyId}::uuid IS NOT NULL
         AND l.property_id = ${resolvedPropertyId}::uuid
         AND (${excludeLeadId}::uuid IS NULL OR l.id <> ${excludeLeadId}::uuid)
      UNION ALL
      SELECT 'property', 'deal_stage_history', h.created_at, 'Recent deal stage change on property'
        FROM deal_stage_history h
        JOIN deals d ON d.id = h.deal_id
       WHERE ${resolvedPropertyId}::uuid IS NOT NULL
         AND d.property_id = ${resolvedPropertyId}::uuid
    )
    SELECT source, type, occurred_at, detail
      FROM signal_candidates, cutoff
     WHERE occurred_at >= cutoff.cutoff_at
     ORDER BY occurred_at DESC, source ASC, type ASC
     LIMIT 1
  `);

  const rows = result.rows;
  const row = rows?.[0];
  if (!row) {
    return { isExisting: false, signal: null };
  }

  return {
    isExisting: true,
    signal: {
      source: row.source as ExistingCustomerSignal["source"],
      type: row.type,
      occurredAt: row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at),
      detail: row.detail,
    },
  };
}
