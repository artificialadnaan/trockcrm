// server/src/modules/migration/validator.ts

import { eq, sql } from "drizzle-orm";
import {
  stagedCompanies,
  stagedProperties,
  stagedLeads,
  stagedDeals,
  stagedContacts,
  stagedActivities,
  pipelineStageConfig,
  users,
} from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import {
  classifyActivityException,
  classifyCompanyException,
  classifyContactException,
  classifyLeadException,
  classifyOwnerAssignmentException,
  classifyPropertyException,
  type MigrationExceptionBucket,
} from "./exception-service.js";

interface ValidationError {
  field: string;
  error: string;
}

interface ValidationWarning {
  field: string;
  warning: string;
}

type ValidationExceptionCounts = Record<MigrationExceptionBucket, number>;

function createExceptionCounts(): ValidationExceptionCounts {
  return {
    unknown_company: 0,
    ambiguous_property: 0,
    ambiguous_contact: 0,
    lead_vs_deal_conflict: 0,
    ambiguous_email_activity_attribution: 0,
    missing_owner_assignment: 0,
  };
}

// ---------------------------------------------------------------------------
// Validate all staged deals
// ---------------------------------------------------------------------------

export async function validateStagedDeals(): Promise<{
  valid: number;
  invalid: number;
  needsReview: number;
  exceptions: ValidationExceptionCounts;
}> {
  const allStages = await db
    .select({ id: pipelineStageConfig.id, slug: pipelineStageConfig.slug })
    .from(pipelineStageConfig);

  const stageSlugs = new Set(allStages.map((s) => s.slug));

  const allReps = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.isActive, true));

  const repEmails = new Set(allReps.map((r) => r.email.toLowerCase()));

  const BATCH = 100;
  let valid = 0, invalid = 0, needsReview = 0;
  const exceptions = createExceptionCounts();

  // Fetch pending rows WITHOUT offset — each batch updates rows out of
  // 'pending' status, so the next fetch naturally gets the next batch.
  while (true) {
    const batch = await db
      .select()
      .from(stagedDeals)
      .where(eq(stagedDeals.validationStatus, "pending"))
      .limit(BATCH);

    if (batch.length === 0) break;

    for (const deal of batch) {
      const errors: ValidationError[] = [];
      const warnings: ValidationWarning[] = [];

      if (!deal.mappedName) {
        errors.push({ field: "name", error: "Deal name is blank" });
      }

      if (!deal.mappedStage) {
        errors.push({ field: "stage", error: "No stage mapped" });
      } else if (!stageSlugs.has(deal.mappedStage)) {
        errors.push({
          field: "stage",
          error: `Unknown CRM stage: "${deal.mappedStage}" — update HUBSPOT_STAGE_MAP in field-mapper.ts`,
        });
      }

      if (!deal.mappedRepEmail) {
        warnings.push({ field: "rep", warning: "No rep email — deal will be unassigned" });
        exceptions.missing_owner_assignment++;
      } else if (!repEmails.has(deal.mappedRepEmail.toLowerCase())) {
        errors.push({
          field: "rep",
          error: `Rep email "${deal.mappedRepEmail}" does not match any active CRM user`,
        });
        exceptions.missing_owner_assignment++;
      }

      if (deal.mappedAmount == null || Number(deal.mappedAmount) === 0) {
        warnings.push({ field: "amount", warning: "Deal amount is $0 or blank" });
      }

      let validationStatus: "valid" | "invalid" | "needs_review";
      if (errors.length > 0) {
        validationStatus = "invalid";
        invalid++;
      } else if (warnings.length > 0) {
        validationStatus = "needs_review";
        needsReview++;
      } else {
        validationStatus = "valid";
        valid++;
      }

      await db
        .update(stagedDeals)
        .set({
          validationStatus,
          validationErrors: errors,
          validationWarnings: warnings,
        })
        .where(eq(stagedDeals.id, deal.id));
    }
  }

  return { valid, invalid, needsReview, exceptions };
}

// ---------------------------------------------------------------------------
// Validate all staged contacts + detect duplicates
// ---------------------------------------------------------------------------

export async function validateStagedContacts(): Promise<{
  valid: number;
  invalid: number;
  needsReview: number;
  duplicates: number;
  exceptions: ValidationExceptionCounts;
}> {
  const BATCH = 100;
  let valid = 0, invalid = 0, needsReview = 0, duplicates = 0;
  const exceptions = createExceptionCounts();

  // Build in-memory email map for staged duplicate detection
  const allStaged = await db
    .select({
      id: stagedContacts.id,
      mappedEmail: stagedContacts.mappedEmail,
      mappedFirstName: stagedContacts.mappedFirstName,
      mappedLastName: stagedContacts.mappedLastName,
    })
    .from(stagedContacts);

  const stagedEmailMap = new Map<string, string>();
  const stagedNameMap = new Map<string, string>();

  for (const row of allStaged) {
    const email = row.mappedEmail?.toLowerCase().trim();
    if (email) {
      if (!stagedEmailMap.has(email)) {
        stagedEmailMap.set(email, row.id);
      }
    }
    const name = `${row.mappedFirstName ?? ""} ${row.mappedLastName ?? ""}`.toLowerCase().trim();
    if (name.length > 2) {
      if (!stagedNameMap.has(name)) {
        stagedNameMap.set(name, row.id);
      }
    }
  }

  while (true) {
    const batch = await db
      .select()
      .from(stagedContacts)
      .where(eq(stagedContacts.validationStatus, "pending"))
      .limit(BATCH);

    if (batch.length === 0) break;

    for (const contact of batch) {
      const errors: ValidationError[] = [];
      const warnings: ValidationWarning[] = [];

      if (!contact.mappedEmail && !contact.mappedPhone) {
        errors.push({
          field: "email/phone",
          error: "Contact has neither email nor phone — cannot be reliably identified",
        });
      }

      if (!contact.mappedFirstName && !contact.mappedLastName) {
        errors.push({ field: "name", error: "Contact has no first or last name" });
      }

      let duplicateOfStagedId: string | null = null;
      if (contact.mappedEmail) {
        const email = contact.mappedEmail.toLowerCase().trim();
        const firstId = stagedEmailMap.get(email);
        if (firstId && firstId !== contact.id) {
          duplicateOfStagedId = firstId;
          duplicates++;
        }
      }

      if (!duplicateOfStagedId) {
        const name = `${contact.mappedFirstName ?? ""} ${contact.mappedLastName ?? ""}`.toLowerCase().trim();
        if (name.length > 2) {
          const firstId = stagedNameMap.get(name);
          if (firstId && firstId !== contact.id) {
            warnings.push({
              field: "name",
              warning: `Possible duplicate of staged contact ${firstId} (same normalized name)`,
            });
          }
        }
      }

      let validationStatus: "valid" | "invalid" | "needs_review" | "duplicate";
      if (duplicateOfStagedId) {
        validationStatus = "duplicate";
        exceptions.ambiguous_contact++;
      } else if (errors.length > 0) {
        validationStatus = "invalid";
        invalid++;
        if (!contact.mappedEmail && !contact.mappedPhone) {
          exceptions.ambiguous_contact++;
        }
      } else if (warnings.length > 0) {
        validationStatus = "needs_review";
        needsReview++;
        exceptions.ambiguous_contact++;
      } else {
        validationStatus = "valid";
        valid++;
      }

      await db
        .update(stagedContacts)
        .set({
          validationStatus,
          validationErrors: errors,
          validationWarnings: warnings,
          duplicateOfStagedId: duplicateOfStagedId ?? null,
        })
        .where(eq(stagedContacts.id, contact.id));
    }
  }

  return { valid, invalid, needsReview, duplicates, exceptions };
}

// ---------------------------------------------------------------------------
// Validate staged activities
// ---------------------------------------------------------------------------

export async function validateStagedActivities(): Promise<{
  valid: number;
  invalid: number;
  orphans: number;
  exceptions: ValidationExceptionCounts;
}> {
  const stagedDealIds = new Set(
    (await db.select({ id: stagedDeals.hubspotDealId }).from(stagedDeals)).map((r) => r.id)
  );
  const stagedContactIds = new Set(
    (await db.select({ id: stagedContacts.hubspotContactId }).from(stagedContacts)).map((r) => r.id)
  );

  const BATCH = 100;
  let valid = 0, invalid = 0, orphans = 0;
  const exceptions = createExceptionCounts();

  while (true) {
    const batch = await db
      .select()
      .from(stagedActivities)
      .where(eq(stagedActivities.validationStatus, "pending"))
      .limit(BATCH);

    if (batch.length === 0) break;

    for (const activity of batch) {
      const errors: ValidationError[] = [];

      if (!activity.mappedType) {
        errors.push({ field: "type", error: "Activity type could not be mapped" });
      }

      const dealExists = activity.hubspotDealId ? stagedDealIds.has(activity.hubspotDealId) : false;
      const contactExists = activity.hubspotContactId
        ? stagedContactIds.has(activity.hubspotContactId)
        : false;

      let validationStatus: "valid" | "invalid" | "orphan";
      if (!dealExists && !contactExists) {
        validationStatus = "orphan";
        orphans++;
        exceptions.ambiguous_email_activity_attribution++;
      } else if (errors.length > 0) {
        validationStatus = "invalid";
        invalid++;
      } else {
        validationStatus = "valid";
        valid++;
      }

      await db
        .update(stagedActivities)
        .set({ validationStatus, validationErrors: errors })
        .where(eq(stagedActivities.id, activity.id));
    }
  }

  return { valid, invalid, orphans, exceptions };
}

// ---------------------------------------------------------------------------
// Validate staged companies / properties / leads
// ---------------------------------------------------------------------------

export async function validateStagedCompanies(): Promise<{
  valid: number;
  invalid: number;
  needsReview: number;
  exceptions: ValidationExceptionCounts;
}> {
  const BATCH = 100;
  let valid = 0;
  let invalid = 0;
  let needsReview = 0;
  const exceptions = createExceptionCounts();

  while (true) {
    const batch = await db
      .select()
      .from(stagedCompanies)
      .where(eq(stagedCompanies.validationStatus, "pending"))
      .limit(BATCH);

    if (batch.length === 0) break;

    for (const company of batch) {
      const errors: ValidationError[] = [];
      const warnings: ValidationWarning[] = [];

      const classification = classifyCompanyException({
        mappedName: company.mappedName,
        mappedDomain: company.mappedDomain,
      });

      if (classification?.bucket === "unknown_company") {
        warnings.push({ field: "company", warning: classification.reason });
        company.exceptionBucket = classification.bucket;
        company.exceptionReason = classification.reason;
        exceptions.unknown_company++;
      }

      if (company.mappedOwnerEmail && company.mappedOwnerEmail.trim().length === 0) {
        company.mappedOwnerEmail = null;
      }

      if (!company.mappedName && !company.mappedDomain) {
        errors.push({ field: "company", error: "Company cannot be matched to a unique record" });
      }

      let validationStatus: "valid" | "invalid" | "needs_review";
      if (errors.length > 0) {
        validationStatus = "invalid";
        invalid++;
      } else if (warnings.length > 0) {
        validationStatus = "needs_review";
        needsReview++;
      } else {
        validationStatus = "valid";
        valid++;
      }

      await db
        .update(stagedCompanies)
        .set({
          validationStatus,
          validationErrors: errors,
          validationWarnings: warnings,
          exceptionBucket: company.exceptionBucket ?? null,
          exceptionReason: company.exceptionReason ?? null,
        })
        .where(eq(stagedCompanies.id, company.id));
    }
  }

  return { valid, invalid, needsReview, exceptions };
}

export async function validateStagedProperties(): Promise<{
  valid: number;
  invalid: number;
  needsReview: number;
  exceptions: ValidationExceptionCounts;
}> {
  const BATCH = 100;
  let valid = 0;
  let invalid = 0;
  let needsReview = 0;
  const exceptions = createExceptionCounts();

  while (true) {
    const batch = await db
      .select()
      .from(stagedProperties)
      .where(eq(stagedProperties.validationStatus, "pending"))
      .limit(BATCH);

    if (batch.length === 0) break;

    for (const property of batch) {
      const errors: ValidationError[] = [];
      const warnings: ValidationWarning[] = [];
      const classification = classifyPropertyException({
        mappedName: property.mappedName,
        mappedCompanyName: property.mappedCompanyName,
        candidateCompanyCount: property.candidateCompanyCount,
      });

      if (classification?.bucket === "ambiguous_property") {
        warnings.push({ field: "property", warning: classification.reason });
        property.exceptionBucket = classification.bucket;
        property.exceptionReason = classification.reason;
        exceptions.ambiguous_property++;
      }

      if (!property.mappedName) {
        errors.push({ field: "property", error: "Property name is blank" });
      }

      let validationStatus: "valid" | "invalid" | "needs_review";
      if (errors.length > 0) {
        validationStatus = "invalid";
        invalid++;
      } else if (warnings.length > 0) {
        validationStatus = "needs_review";
        needsReview++;
      } else {
        validationStatus = "valid";
        valid++;
      }

      await db
        .update(stagedProperties)
        .set({
          validationStatus,
          validationErrors: errors,
          validationWarnings: warnings,
          exceptionBucket: property.exceptionBucket ?? null,
          exceptionReason: property.exceptionReason ?? null,
        })
        .where(eq(stagedProperties.id, property.id));
    }
  }

  return { valid, invalid, needsReview, exceptions };
}

export async function validateStagedLeads(): Promise<{
  valid: number;
  invalid: number;
  needsReview: number;
  exceptions: ValidationExceptionCounts;
}> {
  const BATCH = 100;
  let valid = 0;
  let invalid = 0;
  let needsReview = 0;
  const exceptions = createExceptionCounts();

  while (true) {
    const batch = await db
      .select()
      .from(stagedLeads)
      .where(eq(stagedLeads.validationStatus, "pending"))
      .limit(BATCH);

    if (batch.length === 0) break;

    for (const lead of batch) {
      const errors: ValidationError[] = [];
      const warnings: ValidationWarning[] = [];
      const ownerClassification = classifyOwnerAssignmentException({
        mappedOwnerEmail: lead.mappedOwnerEmail,
      });
      const leadClassification = classifyLeadException({
        mappedName: lead.mappedName,
        mappedOwnerEmail: lead.mappedOwnerEmail,
        mappedCompanyName: lead.mappedCompanyName,
        mappedPropertyName: lead.mappedPropertyName,
        mappedDealName: lead.mappedDealName,
        candidateDealCount: lead.candidateDealCount,
        candidatePropertyCount: lead.candidatePropertyCount,
      });

      if (ownerClassification?.bucket === "missing_owner_assignment") {
        warnings.push({ field: "owner", warning: ownerClassification.reason });
        lead.exceptionBucket = ownerClassification.bucket;
        lead.exceptionReason = ownerClassification.reason;
        exceptions.missing_owner_assignment++;
      } else if (leadClassification?.bucket === "lead_vs_deal_conflict") {
        warnings.push({ field: "lead", warning: leadClassification.reason });
        lead.exceptionBucket = leadClassification.bucket;
        lead.exceptionReason = leadClassification.reason;
        exceptions.lead_vs_deal_conflict++;
      }

      if (!lead.mappedName) {
        errors.push({ field: "lead", error: "Lead name is blank" });
      }

      let validationStatus: "valid" | "invalid" | "needs_review";
      if (errors.length > 0) {
        validationStatus = "invalid";
        invalid++;
      } else if (warnings.length > 0) {
        validationStatus = "needs_review";
        needsReview++;
      } else {
        validationStatus = "valid";
        valid++;
      }

      await db
        .update(stagedLeads)
        .set({
          validationStatus,
          validationErrors: errors,
          validationWarnings: warnings,
          exceptionBucket: lead.exceptionBucket ?? null,
          exceptionReason: lead.exceptionReason ?? null,
        })
        .where(eq(stagedLeads.id, lead.id));
    }
  }

  return { valid, invalid, needsReview, exceptions };
}

// ---------------------------------------------------------------------------
// Summary stats for import run
// ---------------------------------------------------------------------------

export async function getValidationStats(): Promise<{
  deals: Record<string, number>;
  contacts: Record<string, number>;
  activities: Record<string, number>;
  companies: Record<string, number>;
  properties: Record<string, number>;
  leads: Record<string, number>;
}> {
  const dealStats = await db.execute(sql`
    SELECT validation_status, COUNT(*)::int AS count
    FROM migration.staged_deals
    GROUP BY validation_status
  `);
  const contactStats = await db.execute(sql`
    SELECT validation_status, COUNT(*)::int AS count
    FROM migration.staged_contacts
    GROUP BY validation_status
  `);
  const activityStats = await db.execute(sql`
    SELECT validation_status, COUNT(*)::int AS count
    FROM migration.staged_activities
    GROUP BY validation_status
  `);
  const companyStats = await db.execute(sql`
    SELECT validation_status, COUNT(*)::int AS count
    FROM migration.staged_companies
    GROUP BY validation_status
  `);
  const propertyStats = await db.execute(sql`
    SELECT validation_status, COUNT(*)::int AS count
    FROM migration.staged_properties
    GROUP BY validation_status
  `);
  const leadStats = await db.execute(sql`
    SELECT validation_status, COUNT(*)::int AS count
    FROM migration.staged_leads
    GROUP BY validation_status
  `);

  function toRecord(rows: any): Record<string, number> {
    const result: Record<string, number> = {};
    const arr = (rows as any).rows ?? rows;
    for (const r of arr) {
      result[r.validation_status] = Number(r.count ?? 0);
    }
    return result;
  }

  return {
    deals: toRecord(dealStats),
    contacts: toRecord(contactStats),
    activities: toRecord(activityStats),
    companies: toRecord(companyStats),
    properties: toRecord(propertyStats),
    leads: toRecord(leadStats),
  };
}
