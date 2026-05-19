import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { companies, contacts, deals, emails, leads } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export type EmailStatsEntityType = "company" | "deal" | "lead" | "contact";

export type EmailStatTarget = {
  entityType: EmailStatsEntityType;
  entityId: string | null | undefined;
};

export type EmailStatEmailRecord = {
  assignedEntityType?: string | null;
  assignedEntityId?: string | null;
  dealId?: string | null;
  contactId?: string | null;
};

function canExecuteRawSql(tenantDb: TenantDb): tenantDb is TenantDb & { execute: (query: unknown) => Promise<unknown> } {
  return typeof (tenantDb as { execute?: unknown }).execute === "function";
}

export async function refreshEntityEmailStats(
  tenantDb: TenantDb,
  entityType: EmailStatsEntityType,
  entityId: string
) {
  if (entityType === "company") {
    if (canExecuteRawSql(tenantDb)) {
      await tenantDb.execute(sql`
        UPDATE "companies" AS c
        SET
          "email_count" = (
            SELECT COUNT(*)::int
            FROM "emails" e
            WHERE e.assignment_status <> 'ignored'
              AND (
                (e.assigned_entity_type = 'company' AND e.assigned_entity_id = ${entityId})
                OR e.deal_id IN (SELECT id FROM "deals" WHERE company_id = ${entityId})
                OR e.contact_id IN (SELECT id FROM "contacts" WHERE company_id = ${entityId})
                OR (e.assigned_entity_type = 'lead' AND e.assigned_entity_id IN (SELECT id FROM "leads" WHERE company_id = ${entityId}))
                OR (e.assigned_entity_type = 'deal' AND e.assigned_entity_id IN (SELECT id FROM "deals" WHERE company_id = ${entityId}))
                OR (e.assigned_entity_type = 'contact' AND e.assigned_entity_id IN (SELECT id FROM "contacts" WHERE company_id = ${entityId}))
              )
          ),
          "last_email_at" = (
            SELECT MAX(e.sent_at)
            FROM "emails" e
            WHERE e.assignment_status <> 'ignored'
              AND (
                (e.assigned_entity_type = 'company' AND e.assigned_entity_id = ${entityId})
                OR e.deal_id IN (SELECT id FROM "deals" WHERE company_id = ${entityId})
                OR e.contact_id IN (SELECT id FROM "contacts" WHERE company_id = ${entityId})
                OR (e.assigned_entity_type = 'lead' AND e.assigned_entity_id IN (SELECT id FROM "leads" WHERE company_id = ${entityId}))
                OR (e.assigned_entity_type = 'deal' AND e.assigned_entity_id IN (SELECT id FROM "deals" WHERE company_id = ${entityId}))
                OR (e.assigned_entity_type = 'contact' AND e.assigned_entity_id IN (SELECT id FROM "contacts" WHERE company_id = ${entityId}))
              )
          )
        WHERE c.id = ${entityId}
      `);
    } else {
      await tenantDb
        .update(companies)
        .set({
          emailCount: sql<number>`(
            SELECT COUNT(*)::int
            FROM ${emails} e
            WHERE e.assignment_status <> 'ignored'
              AND (
                (e.assigned_entity_type = 'company' AND e.assigned_entity_id = ${entityId})
                OR e.deal_id IN (SELECT id FROM ${deals} WHERE ${deals.companyId} = ${entityId})
                OR e.contact_id IN (SELECT id FROM ${contacts} WHERE ${contacts.companyId} = ${entityId})
                OR (e.assigned_entity_type = 'lead' AND e.assigned_entity_id IN (SELECT id FROM ${leads} WHERE ${leads.companyId} = ${entityId}))
                OR (e.assigned_entity_type = 'deal' AND e.assigned_entity_id IN (SELECT id FROM ${deals} WHERE ${deals.companyId} = ${entityId}))
                OR (e.assigned_entity_type = 'contact' AND e.assigned_entity_id IN (SELECT id FROM ${contacts} WHERE ${contacts.companyId} = ${entityId}))
              )
          )`,
          lastEmailAt: sql<Date | null>`(
            SELECT MAX(e.sent_at)
            FROM ${emails} e
            WHERE e.assignment_status <> 'ignored'
              AND (
                (e.assigned_entity_type = 'company' AND e.assigned_entity_id = ${entityId})
                OR e.deal_id IN (SELECT id FROM ${deals} WHERE ${deals.companyId} = ${entityId})
                OR e.contact_id IN (SELECT id FROM ${contacts} WHERE ${contacts.companyId} = ${entityId})
                OR (e.assigned_entity_type = 'lead' AND e.assigned_entity_id IN (SELECT id FROM ${leads} WHERE ${leads.companyId} = ${entityId}))
                OR (e.assigned_entity_type = 'deal' AND e.assigned_entity_id IN (SELECT id FROM ${deals} WHERE ${deals.companyId} = ${entityId}))
                OR (e.assigned_entity_type = 'contact' AND e.assigned_entity_id IN (SELECT id FROM ${contacts} WHERE ${contacts.companyId} = ${entityId}))
              )
          )`,
        })
        .where(eq(companies.id, entityId));
    }
    return;
  }

  if (entityType === "deal") {
    if (canExecuteRawSql(tenantDb)) {
      await tenantDb.execute(sql`
        UPDATE "deals" AS d
        SET
          "email_count" = (
            SELECT COUNT(e.id)::int
            FROM "emails" e
            WHERE e.assignment_status <> 'ignored'
              AND (
                (e.assigned_entity_type = 'deal' AND e.assigned_entity_id = d.id)
                OR e.deal_id = d.id
                OR (
                  d.source_lead_id IS NOT NULL
                  AND e.assigned_entity_type = 'lead'
                  AND e.assigned_entity_id = d.source_lead_id
                )
              )
          ),
          "last_email_at" = (
            SELECT MAX(e.sent_at)
            FROM "emails" e
            WHERE e.assignment_status <> 'ignored'
              AND (
                (e.assigned_entity_type = 'deal' AND e.assigned_entity_id = d.id)
                OR e.deal_id = d.id
                OR (
                  d.source_lead_id IS NOT NULL
                  AND e.assigned_entity_type = 'lead'
                  AND e.assigned_entity_id = d.source_lead_id
                )
              )
          )
        WHERE d.id = ${entityId}
      `);
    } else {
      await tenantDb
        .update(deals)
        .set({
          emailCount: sql<number>`(
            SELECT COUNT(e.id)::int
            FROM ${deals} d
            LEFT JOIN "emails" e
              ON e.assignment_status <> 'ignored'
             AND (
               (e.assigned_entity_type = 'deal' AND e.assigned_entity_id = d.id)
               OR e.deal_id = d.id
               OR (
                 d.source_lead_id IS NOT NULL
                 AND e.assigned_entity_type = 'lead'
                 AND e.assigned_entity_id = d.source_lead_id
               )
             )
            WHERE d.id = ${entityId}
          )`,
          lastEmailAt: sql<Date | null>`(
            SELECT MAX(e.sent_at)
            FROM ${deals} d
            LEFT JOIN "emails" e
              ON e.assignment_status <> 'ignored'
             AND (
               (e.assigned_entity_type = 'deal' AND e.assigned_entity_id = d.id)
               OR e.deal_id = d.id
               OR (
                 d.source_lead_id IS NOT NULL
                 AND e.assigned_entity_type = 'lead'
                 AND e.assigned_entity_id = d.source_lead_id
               )
             )
            WHERE d.id = ${entityId}
          )`,
        })
        .where(eq(deals.id, entityId));
    }
    return;
  }

  if (entityType === "lead") {
    if (canExecuteRawSql(tenantDb)) {
      await tenantDb.execute(sql`
        UPDATE "leads" AS l
        SET
          "email_count" = (
            SELECT COUNT(*)::int
            FROM "emails" e
            WHERE e.assignment_status <> 'ignored'
              AND e.assigned_entity_type = 'lead'
              AND e.assigned_entity_id = ${entityId}
          ),
          "last_email_at" = (
            SELECT MAX(e.sent_at)
            FROM "emails" e
            WHERE e.assignment_status <> 'ignored'
              AND e.assigned_entity_type = 'lead'
              AND e.assigned_entity_id = ${entityId}
          )
        WHERE l.id = ${entityId}
      `);
    } else {
      await tenantDb
        .update(leads)
        .set({
          emailCount: sql<number>`(
            SELECT COUNT(*)::int
            FROM "emails" e
            WHERE e.assignment_status <> 'ignored'
              AND e.assigned_entity_type = 'lead'
              AND e.assigned_entity_id = ${entityId}
          )`,
          lastEmailAt: sql<Date | null>`(
            SELECT MAX(e.sent_at)
            FROM "emails" e
            WHERE e.assignment_status <> 'ignored'
              AND e.assigned_entity_type = 'lead'
              AND e.assigned_entity_id = ${entityId}
          )`,
        })
        .where(eq(leads.id, entityId));
    }
    return;
  }

  if (canExecuteRawSql(tenantDb)) {
    await tenantDb.execute(sql`
      UPDATE "contacts" AS c
      SET
        "email_count" = (
          SELECT COUNT(*)::int
          FROM "emails" e
          WHERE e.assignment_status <> 'ignored'
            AND (
              (e.assigned_entity_type = 'contact' AND e.assigned_entity_id = ${entityId})
              OR e.contact_id = ${entityId}
            )
        ),
        "last_email_at" = (
          SELECT MAX(e.sent_at)
          FROM "emails" e
          WHERE e.assignment_status <> 'ignored'
            AND (
              (e.assigned_entity_type = 'contact' AND e.assigned_entity_id = ${entityId})
              OR e.contact_id = ${entityId}
            )
        )
      WHERE c.id = ${entityId}
    `);
  } else {
    await tenantDb
      .update(contacts)
      .set({
        emailCount: sql<number>`(
          SELECT COUNT(*)::int
          FROM ${emails} e
          WHERE e.assignment_status <> 'ignored'
            AND (
              (e.assigned_entity_type = 'contact' AND e.assigned_entity_id = ${entityId})
              OR e.contact_id = ${entityId}
            )
        )`,
        lastEmailAt: sql<Date | null>`(
          SELECT MAX(e.sent_at)
          FROM ${emails} e
          WHERE e.assignment_status <> 'ignored'
            AND (
              (e.assigned_entity_type = 'contact' AND e.assigned_entity_id = ${entityId})
              OR e.contact_id = ${entityId}
            )
        )`,
      })
      .where(eq(contacts.id, entityId));
  }
}

export async function refreshEmailStatsForTargets(
  tenantDb: TenantDb,
  targets: EmailStatTarget[]
) {
  const seen = new Set<string>();
  for (const target of targets) {
    if (!target.entityId) continue;
    const key = `${target.entityType}:${target.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await refreshEntityEmailStats(tenantDb, target.entityType, target.entityId);
  }
  return seen.size;
}

export function deriveEmailStatTargetsFromEmail(email: EmailStatEmailRecord) {
  const targets: Array<{ entityType: EmailStatsEntityType; entityId: string | null }> = [];

  if (email.assignedEntityType === "company" && email.assignedEntityId) {
    targets.push({ entityType: "company", entityId: email.assignedEntityId });
  }
  if (email.assignedEntityType === "deal" && email.assignedEntityId) {
    targets.push({ entityType: "deal", entityId: email.assignedEntityId });
  }
  if (email.assignedEntityType === "lead" && email.assignedEntityId) {
    targets.push({ entityType: "lead", entityId: email.assignedEntityId });
  }
  if (email.assignedEntityType === "contact" && email.assignedEntityId) {
    targets.push({ entityType: "contact", entityId: email.assignedEntityId });
  }
  if (email.dealId) {
    targets.push({ entityType: "deal", entityId: email.dealId });
  }
  if (email.contactId) {
    targets.push({ entityType: "contact", entityId: email.contactId });
  }

  return targets;
}

export async function deriveDealStatTargetsFromEmail(
  tenantDb: TenantDb,
  email: EmailStatEmailRecord
) {
  const dealIds = new Set<string>();

  if (email.assignedEntityType === "lead" && email.assignedEntityId) {
    const linkedDeals = await tenantDb
      .select({ id: deals.id })
      .from(deals)
      .where(eq(deals.sourceLeadId, email.assignedEntityId));
    for (const deal of linkedDeals) {
      if (deal?.id) dealIds.add(deal.id);
    }
  }

  return Array.from(dealIds).map((dealId) => ({ entityType: "deal" as const, entityId: dealId }));
}

export async function deriveCompanyStatTargetsFromEmail(
  tenantDb: TenantDb,
  email: EmailStatEmailRecord
) {
  const companyIds = new Set<string>();

  if (email.assignedEntityType === "company" && email.assignedEntityId) {
    companyIds.add(email.assignedEntityId);
  }

  const candidateDealIds = new Set<string>();
  if (email.dealId) candidateDealIds.add(email.dealId);
  if (email.assignedEntityType === "deal" && email.assignedEntityId) {
    candidateDealIds.add(email.assignedEntityId);
  }
  for (const dealId of candidateDealIds) {
    const [dealRow] = await tenantDb
      .select({ companyId: deals.companyId })
      .from(deals)
      .where(eq(deals.id, dealId))
      .limit(1);
    if (dealRow?.companyId) companyIds.add(dealRow.companyId);
  }

  const candidateContactIds = new Set<string>();
  if (email.contactId) candidateContactIds.add(email.contactId);
  if (email.assignedEntityType === "contact" && email.assignedEntityId) {
    candidateContactIds.add(email.assignedEntityId);
  }
  for (const contactId of candidateContactIds) {
    const [contactRow] = await tenantDb
      .select({ companyId: contacts.companyId })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    if (contactRow?.companyId) companyIds.add(contactRow.companyId);
  }

  const candidateLeadIds = new Set<string>();
  if (email.assignedEntityType === "lead" && email.assignedEntityId) {
    candidateLeadIds.add(email.assignedEntityId);
  }
  for (const leadId of candidateLeadIds) {
    const [leadRow] = await tenantDb
      .select({ companyId: leads.companyId })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (leadRow?.companyId) companyIds.add(leadRow.companyId);
  }

  return Array.from(companyIds).map((companyId) => ({ entityType: "company" as const, entityId: companyId }));
}

export async function collectEmailStatTargetsForEmail(
  tenantDb: TenantDb,
  email: EmailStatEmailRecord
) {
  return [
    ...deriveEmailStatTargetsFromEmail(email),
    ...(await deriveDealStatTargetsFromEmail(tenantDb, email)),
    ...(await deriveCompanyStatTargetsFromEmail(tenantDb, email)),
  ];
}

export async function refreshEmailStatsForEmailRecord(
  tenantDb: TenantDb,
  email: EmailStatEmailRecord
) {
  const targets = await collectEmailStatTargetsForEmail(tenantDb, email);
  return refreshEmailStatsForTargets(tenantDb, targets);
}

export async function refreshEmailStatsForEmailRecords(
  tenantDb: TenantDb,
  emailRecords: EmailStatEmailRecord[]
) {
  const targets: EmailStatTarget[] = [];
  for (const email of emailRecords) {
    targets.push(...(await collectEmailStatTargetsForEmail(tenantDb, email)));
  }
  return refreshEmailStatsForTargets(tenantDb, targets);
}
