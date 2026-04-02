// server/src/modules/migration/validator.ts

import { eq, sql } from "drizzle-orm";
import {
  stagedDeals,
  stagedContacts,
  stagedActivities,
  pipelineStageConfig,
  users,
} from "@trock-crm/shared/schema";
import { db } from "../../db.js";

interface ValidationError {
  field: string;
  error: string;
}

interface ValidationWarning {
  field: string;
  warning: string;
}

// ---------------------------------------------------------------------------
// Validate all staged deals
// ---------------------------------------------------------------------------

export async function validateStagedDeals(): Promise<{
  valid: number;
  invalid: number;
  needsReview: number;
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
      } else if (!repEmails.has(deal.mappedRepEmail.toLowerCase())) {
        errors.push({
          field: "rep",
          error: `Rep email "${deal.mappedRepEmail}" does not match any active CRM user`,
        });
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

  return { valid, invalid, needsReview };
}

// ---------------------------------------------------------------------------
// Validate all staged contacts + detect duplicates
// ---------------------------------------------------------------------------

export async function validateStagedContacts(): Promise<{
  valid: number;
  invalid: number;
  needsReview: number;
  duplicates: number;
}> {
  const BATCH = 100;
  let valid = 0, invalid = 0, needsReview = 0, duplicates = 0;

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
      } else if (errors.length > 0) {
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

  return { valid, invalid, needsReview, duplicates };
}

// ---------------------------------------------------------------------------
// Validate staged activities
// ---------------------------------------------------------------------------

export async function validateStagedActivities(): Promise<{
  valid: number;
  invalid: number;
  orphans: number;
}> {
  const stagedDealIds = new Set(
    (await db.select({ id: stagedDeals.hubspotDealId }).from(stagedDeals)).map((r) => r.id)
  );
  const stagedContactIds = new Set(
    (await db.select({ id: stagedContacts.hubspotContactId }).from(stagedContacts)).map((r) => r.id)
  );

  const BATCH = 100;
  let valid = 0, invalid = 0, orphans = 0;

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

  return { valid, invalid, orphans };
}

// ---------------------------------------------------------------------------
// Summary stats for import run
// ---------------------------------------------------------------------------

export async function getValidationStats(): Promise<{
  deals: Record<string, number>;
  contacts: Record<string, number>;
  activities: Record<string, number>;
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
  };
}
