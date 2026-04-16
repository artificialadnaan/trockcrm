import { inArray } from "drizzle-orm";
import {
  stagedActivities,
  stagedCompanies,
  stagedContacts,
  stagedDeals,
  stagedLeads,
  stagedProperties,
} from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { getStagedActivityAssociationIds } from "./activity-associations.js";

export type MigrationExceptionBucket =
  | "unknown_company"
  | "ambiguous_property"
  | "ambiguous_contact"
  | "ambiguous_deal_association"
  | "lead_vs_deal_conflict"
  | "ambiguous_email_activity_attribution"
  | "missing_owner_assignment";

export type MigrationExceptionEntityType =
  | "company"
  | "property"
  | "lead"
  | "deal"
  | "contact"
  | "activity";

export interface MigrationExceptionClassification {
  bucket: MigrationExceptionBucket;
  reason: string;
}

export interface MigrationExceptionItem {
  id: string;
  entityType: MigrationExceptionEntityType;
  bucket: MigrationExceptionBucket;
  title: string;
  detail: string;
  validationStatus: string;
  reviewNotes: string | null;
  reviewable: boolean;
  reviewHint: string;
}

export interface MigrationExceptionBucketGroup {
  bucket: MigrationExceptionBucket;
  label: string;
  count: number;
  items: MigrationExceptionItem[];
}

const BUCKET_LABELS: Record<MigrationExceptionBucket, string> = {
  unknown_company: "Unknown company",
  ambiguous_property: "Ambiguous property",
  ambiguous_contact: "Ambiguous contact",
  ambiguous_deal_association: "Ambiguous deal association",
  lead_vs_deal_conflict: "Lead vs deal conflict",
  ambiguous_email_activity_attribution: "Ambiguous email/activity attribution",
  missing_owner_assignment: "Missing owner assignment",
};

const REVIEW_LIMIT_PER_BUCKET = 10;

export function assertNoUnresolvedMigrationBucket(input: {
  entityType: MigrationExceptionEntityType;
  validationStatus?: string;
  exceptionBucket?: MigrationExceptionBucket | null;
  exceptionReason?: string | null;
}): void {
  if (!input.exceptionBucket) return;

  const label = BUCKET_LABELS[input.exceptionBucket];
  throw new AppError(
    400,
    `${input.entityType} cannot be promoted while it still has an unresolved ${label.toLowerCase()} exception.`
  );
}

function hasFieldIssue(
  entries: Array<{ field: string }> | undefined,
  field: string
): boolean {
  return (entries ?? []).some((entry) => entry.field === field);
}

export function classifyCompanyException(input: {
  mappedName: string | null;
  mappedDomain: string | null;
}): MigrationExceptionClassification | null {
  if (!input.mappedName?.trim() && !input.mappedDomain?.trim()) {
    return {
      bucket: "unknown_company",
      reason: "Company cannot be matched because both name and domain are missing.",
    };
  }

  return null;
}

export function classifyPropertyException(input: {
  mappedName: string | null;
  mappedCompanyName: string | null;
  candidateCompanyCount: number;
}): MigrationExceptionClassification | null {
  if ((input.candidateCompanyCount ?? 0) > 1) {
    return {
      bucket: "ambiguous_property",
      reason: `Property matches ${input.candidateCompanyCount} candidate companies.`,
    };
  }

  if (!input.mappedName?.trim() || !input.mappedCompanyName?.trim()) {
    return {
      bucket: "ambiguous_property",
      reason: "Property cannot be tied to one company with the current mapping.",
    };
  }

  return null;
}

export function classifyContactException(input: {
  mappedEmail: string | null;
  mappedPhone: string | null;
  duplicateOfStagedId: string | null;
  duplicateOfLiveId: string | null;
  candidateContactCount: number;
}): MigrationExceptionClassification | null {
  if (input.duplicateOfStagedId || input.duplicateOfLiveId || (input.candidateContactCount ?? 0) > 1) {
    return {
      bucket: "ambiguous_contact",
      reason: "Contact matches more than one existing or staged record.",
    };
  }

  if (!input.mappedEmail?.trim() && !input.mappedPhone?.trim()) {
    return {
      bucket: "ambiguous_contact",
      reason: "Contact has no email or phone for a unique match.",
    };
  }

  return null;
}

export function classifyLeadException(input: {
  mappedName: string | null;
  mappedOwnerEmail: string | null;
  mappedCompanyName: string | null;
  mappedPropertyName: string | null;
  mappedDealName: string | null;
  candidateDealCount: number;
  candidatePropertyCount: number;
}): MigrationExceptionClassification | null {
  if (!input.mappedOwnerEmail?.trim()) {
    return {
      bucket: "missing_owner_assignment",
      reason: "Lead does not have an assigned owner.",
    };
  }

  if ((input.candidateDealCount ?? 0) > 1) {
    return {
      bucket: "ambiguous_deal_association",
      reason: "Lead matches more than one possible deal.",
    };
  }

  if ((input.candidatePropertyCount ?? 0) > 1) {
    return {
      bucket: "lead_vs_deal_conflict",
      reason: "Lead points at conflicting property matches.",
    };
  }

  if (!input.mappedName?.trim() || !input.mappedCompanyName?.trim()) {
    return {
      bucket: "lead_vs_deal_conflict",
      reason: "Lead mapping does not uniquely resolve a company and successor deal.",
    };
  }

  return null;
}

export function classifyActivityException(input: {
  hubspotDealId: string | null;
  hubspotContactId: string | null;
  hubspotDealIds?: string[] | null;
  hubspotContactIds?: string[] | null;
  candidateCount: number;
}): MigrationExceptionClassification | null {
  const dealCount = input.hubspotDealIds?.filter(Boolean).length ?? (input.hubspotDealId ? 1 : 0);
  const contactCount =
    input.hubspotContactIds?.filter(Boolean).length ?? (input.hubspotContactId ? 1 : 0);
  const candidateCount = Math.max(input.candidateCount ?? 0, dealCount + contactCount);

  if (candidateCount > 1) {
    return {
      bucket: "ambiguous_email_activity_attribution",
      reason: "Activity matches more than one possible deal/contact target.",
    };
  }

  if (candidateCount === 0) {
    return {
      bucket: "ambiguous_email_activity_attribution",
      reason: "Activity cannot be assigned to a unique deal or contact.",
    };
  }

  return null;
}

export function classifyOwnerAssignmentException(input: {
  mappedOwnerEmail: string | null;
  mappedOwnerId?: string | null;
}): MigrationExceptionClassification | null {
  if (!input.mappedOwnerEmail?.trim() && !input.mappedOwnerId?.trim()) {
    return {
      bucket: "missing_owner_assignment",
      reason: "Record does not have a resolved owner.",
    };
  }

  return null;
}

function itemForBucket(args: {
  id: string;
  entityType: MigrationExceptionEntityType;
  classification: MigrationExceptionClassification | null;
  title: string;
  detailFallback: string;
  validationStatus: string;
  reviewNotes: string | null;
  reviewable: boolean;
  reviewHint: string;
}): MigrationExceptionItem | null {
  if (!args.classification) return null;

  return {
    id: args.id,
    entityType: args.entityType,
    bucket: args.classification.bucket,
    title: args.title,
    detail: args.classification.reason || args.detailFallback,
    validationStatus: args.validationStatus,
    reviewNotes: args.reviewNotes,
    reviewable: args.reviewable,
    reviewHint: args.reviewHint,
  };
}

function groupItems(items: MigrationExceptionItem[]): MigrationExceptionBucketGroup[] {
  const groups = new Map<MigrationExceptionBucket, MigrationExceptionItem[]>();

  for (const item of items) {
    const current = groups.get(item.bucket) ?? [];
    current.push(item);
    groups.set(item.bucket, current);
  }

  return (Object.keys(BUCKET_LABELS) as MigrationExceptionBucket[])
    .map((bucket) => {
      const itemsForBucket = (groups.get(bucket) ?? [])
        .sort((a, b) => a.title.localeCompare(b.title))
        .slice(0, REVIEW_LIMIT_PER_BUCKET);
      return {
        bucket,
        label: BUCKET_LABELS[bucket],
        count: groups.get(bucket)?.length ?? 0,
        items: itemsForBucket,
      };
    })
    .filter((group) => group.count > 0);
}

async function loadCompanyExceptions(): Promise<MigrationExceptionItem[]> {
  const rows = await db
    .select()
    .from(stagedCompanies)
    .where(inArray(stagedCompanies.validationStatus, ["pending", "needs_review", "invalid"] as any[]));

  return rows
    .map((row) =>
      itemForBucket({
        id: row.id,
        entityType: "company",
        classification:
          row.exceptionBucket === "unknown_company"
            ? { bucket: "unknown_company", reason: row.exceptionReason ?? "Company could not be resolved." }
            : classifyCompanyException({
                mappedName: row.mappedName,
                mappedDomain: row.mappedDomain,
              }),
        title: row.mappedName ?? row.mappedDomain ?? `Company ${row.hubspotCompanyId}`,
        detailFallback: row.exceptionReason ?? "Company requires review.",
        validationStatus: row.validationStatus,
        reviewNotes: row.reviewNotes ?? null,
        reviewable: true,
        reviewHint: "Review in the migration dashboard.",
      })
    )
    .filter((item): item is MigrationExceptionItem => item != null);
}

async function loadPropertyExceptions(): Promise<MigrationExceptionItem[]> {
  const rows = await db
    .select()
    .from(stagedProperties)
    .where(inArray(stagedProperties.validationStatus, ["pending", "needs_review", "invalid"] as any[]));

  return rows
    .map((row) =>
      itemForBucket({
        id: row.id,
        entityType: "property",
        classification:
          row.exceptionBucket === "ambiguous_property"
            ? { bucket: "ambiguous_property", reason: row.exceptionReason ?? "Property requires review." }
            : classifyPropertyException({
                mappedName: row.mappedName,
                mappedCompanyName: row.mappedCompanyName,
                candidateCompanyCount: row.candidateCompanyCount ?? 0,
              }),
        title: row.mappedName ?? row.mappedCompanyName ?? `Property ${row.hubspotPropertyId}`,
        detailFallback: row.exceptionReason ?? "Property requires review.",
        validationStatus: row.validationStatus,
        reviewNotes: row.reviewNotes ?? null,
        reviewable: true,
        reviewHint: "Review in the migration dashboard.",
      })
    )
    .filter((item): item is MigrationExceptionItem => item != null);
}

async function loadLeadExceptions(): Promise<MigrationExceptionItem[]> {
  const rows = await db
    .select()
    .from(stagedLeads)
    .where(inArray(stagedLeads.validationStatus, ["pending", "needs_review", "invalid"] as any[]));

  return rows
    .map((row) =>
      itemForBucket({
        id: row.id,
        entityType: "lead",
        classification:
          row.exceptionBucket === "lead_vs_deal_conflict" ||
          row.exceptionBucket === "ambiguous_deal_association" ||
          row.exceptionBucket === "missing_owner_assignment"
            ? {
                bucket: row.exceptionBucket as MigrationExceptionBucket,
                reason: row.exceptionReason ?? "Lead requires review.",
              }
            : classifyLeadException({
                mappedName: row.mappedName,
                mappedOwnerEmail: row.mappedOwnerEmail,
                mappedCompanyName: row.mappedCompanyName,
                mappedPropertyName: row.mappedPropertyName,
                mappedDealName: row.mappedDealName,
                candidateDealCount: row.candidateDealCount ?? 0,
                candidatePropertyCount: row.candidatePropertyCount ?? 0,
              }) ??
              (hasFieldIssue(row.validationErrors as Array<{ field: string }> | undefined, "owner") ||
              hasFieldIssue(row.validationWarnings as Array<{ field: string }> | undefined, "owner")
                ? classifyOwnerAssignmentException({ mappedOwnerEmail: row.mappedOwnerEmail })
                : null),
        title: row.mappedName ?? row.mappedDealName ?? `Lead ${row.hubspotLeadId}`,
        detailFallback: row.exceptionReason ?? "Lead requires review.",
        validationStatus: row.validationStatus,
        reviewNotes: row.reviewNotes ?? null,
        reviewable: true,
        reviewHint: "Review in the migration dashboard.",
      })
    )
    .filter((item): item is MigrationExceptionItem => item != null);
}

async function loadDealExceptions(): Promise<MigrationExceptionItem[]> {
  const rows = await db
    .select()
    .from(stagedDeals)
    .where(inArray(stagedDeals.validationStatus, ["pending", "needs_review", "invalid"] as any[]));

  return rows
    .map((row) =>
      itemForBucket({
        id: row.id,
        entityType: "deal",
        classification:
          classifyOwnerAssignmentException({
            mappedOwnerEmail: row.mappedRepEmail,
          }) ??
          (hasFieldIssue(row.validationErrors as Array<{ field: string }> | undefined, "rep") ||
          hasFieldIssue(row.validationWarnings as Array<{ field: string }> | undefined, "rep")
            ? classifyOwnerAssignmentException({ mappedOwnerEmail: row.mappedRepEmail })
            : null),
        title: row.mappedName ?? `Deal ${row.hubspotDealId}`,
        detailFallback:
          (row.validationWarnings as Array<{ warning: string }> | undefined)?.[0]?.warning ??
          "Deal requires review.",
        validationStatus: row.validationStatus,
        reviewNotes: row.reviewNotes ?? null,
        reviewable: false,
        reviewHint: "Review on the staged deals page.",
      })
    )
    .filter((item): item is MigrationExceptionItem => item != null);
}

async function loadContactExceptions(): Promise<MigrationExceptionItem[]> {
  const rows = await db
    .select()
    .from(stagedContacts)
    .where(inArray(stagedContacts.validationStatus, ["pending", "needs_review", "invalid", "duplicate"] as any[]));

  return rows
    .map((row) =>
      itemForBucket({
        id: row.id,
        entityType: "contact",
        classification: classifyContactException({
          mappedEmail: row.mappedEmail,
          mappedPhone: row.mappedPhone,
          duplicateOfStagedId: row.duplicateOfStagedId ?? null,
          duplicateOfLiveId: row.duplicateOfLiveId ?? null,
          candidateContactCount: row.duplicateOfStagedId ? 2 : 0,
        }),
        title: [row.mappedFirstName, row.mappedLastName].filter(Boolean).join(" ") || `Contact ${row.hubspotContactId}`,
        detailFallback:
          (row.validationWarnings as Array<{ warning: string }> | undefined)?.[0]?.warning ??
          "Contact requires review.",
        validationStatus: row.validationStatus,
        reviewNotes: row.reviewNotes ?? null,
        reviewable: false,
        reviewHint: "Review on the staged contacts page.",
      })
    )
    .filter((item): item is MigrationExceptionItem => item != null);
}

async function loadActivityExceptions(): Promise<MigrationExceptionItem[]> {
  const rows = await db
    .select()
    .from(stagedActivities)
    .where(inArray(stagedActivities.validationStatus, ["pending", "invalid", "orphan"] as any[]));

  return rows
    .map((row) =>
      {
        const associationIds = getStagedActivityAssociationIds({
          rawData: row.rawData as Record<string, unknown> | null | undefined,
          hubspotDealId: row.hubspotDealId ?? null,
          hubspotDealIds: (row as any).hubspotDealIds,
          hubspotContactId: row.hubspotContactId ?? null,
          hubspotContactIds: (row as any).hubspotContactIds,
        });

        return itemForBucket({
          id: row.id,
          entityType: "activity",
          classification: classifyActivityException({
            hubspotDealId: associationIds.hubspotDealId,
            hubspotContactId: associationIds.hubspotContactId,
            hubspotDealIds: associationIds.hubspotDealIds,
            hubspotContactIds: associationIds.hubspotContactIds,
            candidateCount: associationIds.candidateCount,
          }),
          title: row.mappedSubject ?? `Activity ${row.hubspotActivityId}`,
          detailFallback:
            (row.validationErrors as Array<{ error: string }> | undefined)?.[0]?.error ??
            "Activity requires review.",
          validationStatus: row.validationStatus,
          reviewNotes: null,
          reviewable: false,
          reviewHint: "Review on the staged activities list.",
        });
      }
    )
    .filter((item): item is MigrationExceptionItem => item != null);
}

export async function getMigrationExceptionGroups(): Promise<MigrationExceptionBucketGroup[]> {
  const items = [
    ...(await loadCompanyExceptions()),
    ...(await loadPropertyExceptions()),
    ...(await loadLeadExceptions()),
    ...(await loadDealExceptions()),
    ...(await loadContactExceptions()),
    ...(await loadActivityExceptions()),
  ];

  return groupItems(items);
}

export async function getMigrationExceptionCounts(): Promise<Record<MigrationExceptionBucket, number>> {
  const groups = await getMigrationExceptionGroups();
  const counts: Record<MigrationExceptionBucket, number> = {
    unknown_company: 0,
    ambiguous_property: 0,
    ambiguous_contact: 0,
    ambiguous_deal_association: 0,
    lead_vs_deal_conflict: 0,
    ambiguous_email_activity_attribution: 0,
    missing_owner_assignment: 0,
  };

  for (const group of groups) {
    counts[group.bucket] = group.count;
  }

  return counts;
}
