import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  activities,
  companies,
  contacts,
  deals,
  emails,
  hubspotOwnerMappings,
  users,
} from "@trock-crm/shared/schema";
import { hubspotActivityBackfillLedger } from "../../../../shared/src/schema/public/hubspot-activity-backfill-ledger.js";

export type BackfillObjectType = "note" | "call" | "meeting" | "email";

export interface HubSpotActivityLike {
  id: string;
  objectType: BackfillObjectType;
  properties: Record<string, string | undefined>;
  associations?: {
    deals?: { results: Array<{ id: string }> };
    companies?: { results: Array<{ id: string }> };
    contacts?: { results: Array<{ id: string }> };
  };
}

export interface BackfillDealRecord {
  id: string;
  name?: string | null;
  hubspotDealId?: string | null;
}

export interface BackfillCompanyRecord {
  id: string;
  name: string;
  hubspotCompanyId?: string | null;
  hubspotId?: string | null;
}

export interface BackfillContactRecord {
  id: string;
  firstName: string;
  lastName: string;
  companyId?: string | null;
  hubspotContactId?: string | null;
}

export interface BackfillUserRecord {
  id: string;
  email: string;
  displayName?: string | null;
}

export interface OrphanResolution {
  type: "orphan";
  hubspotDealIds: string[];
  hubspotCompanyIds: string[];
  hubspotContactIds: string[];
  reason: string;
}

export interface AmbiguousResolution {
  type: "ambiguous";
  hubspotDealIds: string[];
  hubspotCompanyIds: string[];
  hubspotContactIds: string[];
  reason: string;
}

export interface DealResolution {
  type: "deal";
  id: string;
  entity: BackfillDealRecord;
  hubspotDealIds: string[];
  hubspotCompanyIds: string[];
  hubspotContactIds: string[];
}

export interface CompanyResolution {
  type: "company";
  id: string;
  entity: BackfillCompanyRecord;
  hubspotDealIds: string[];
  hubspotCompanyIds: string[];
  hubspotContactIds: string[];
}

export interface ContactResolution {
  type: "contact";
  id: string;
  entity: BackfillContactRecord;
  hubspotDealIds: string[];
  hubspotCompanyIds: string[];
  hubspotContactIds: string[];
}

export type EntityResolution =
  | DealResolution
  | CompanyResolution
  | ContactResolution
  | OrphanResolution
  | AmbiguousResolution;

export type ResolvedTarget = DealResolution | CompanyResolution | ContactResolution;
export type DealLookupResult =
  | { status: "deal"; deal: BackfillDealRecord; hubspotDealIds: string[] }
  | { status: "orphan"; hubspotDealIds: string[] }
  | { status: "ambiguous"; hubspotDealIds: string[] };

export interface LedgerWriteInput {
  tenantSchema: string;
  hubspotObjectType: BackfillObjectType;
  hubspotObjectId: string;
  targetEntityType: "deal" | "company" | "contact" | null;
  targetEntityId: string | null;
  status: "imported" | "skipped_orphan" | "skipped_ambiguous" | "skipped_unmapped_user" | "failed";
  skipReason?: string | null;
  sourcePayload?: Record<string, unknown> | null;
}

export interface AtomicWriteInput {
  ledger: LedgerWriteInput;
  activity: typeof activities.$inferInsert;
  email?: typeof emails.$inferInsert;
}

type HubSpotAssociations = HubSpotActivityLike["associations"];

function parseDate(value: string | undefined): Date {
  if (!value) throw new Error("HubSpot engagement timestamp is required");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid HubSpot engagement timestamp: ${value}`);
  }
  return parsed;
}

function normalizeText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const HTML_ENTITY_MAP: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  "#39": "'",
};

function normalizeEmail(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function clampText(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function decodeHtmlEntity(entity: string): string {
  if (HTML_ENTITY_MAP[entity]) return HTML_ENTITY_MAP[entity];
  if (entity.startsWith("#x")) {
    const codePoint = Number.parseInt(entity.slice(2), 16);
    return isValidUnicodeScalar(codePoint) ? String.fromCodePoint(codePoint) : `&${entity};`;
  }
  if (entity.startsWith("#")) {
    const codePoint = Number.parseInt(entity.slice(1), 10);
    return isValidUnicodeScalar(codePoint) ? String.fromCodePoint(codePoint) : `&${entity};`;
  }
  return `&${entity};`;
}

function isValidUnicodeScalar(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
}

export function htmlToPlainText(input: string | null | undefined): string {
  if (!input) return "";

  return input
    .replace(/<\s*br\s*\/?>/gi, " ")
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([^;\s]+);/g, (_match, entity: string) => decodeHtmlEntity(entity))
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

function looksLikeHtml(input: string): boolean {
  return /<\/?[a-z][\w:-]*(?:\s[^>]*)?>/i.test(input) || /&(?:nbsp|amp|lt|gt|quot|apos|#39|#\d+|#x[0-9a-f]+);/i.test(input);
}

function plainTextOrNull(input: string | null | undefined): string | null {
  if (!input) return null;
  if (!looksLikeHtml(input)) return normalizeText(input);
  const normalized = htmlToPlainText(input);
  return normalized.length > 0 ? normalized : null;
}

function stripHtml(input: string): string {
  return htmlToPlainText(input);
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildBodyPreview(bodyHtml: string | null, bodyText: string | null) {
  const source = bodyHtml ? stripHtml(bodyHtml) : bodyText ?? "";
  return source.slice(0, 500) || null;
}

function parseCreatedAt(properties: Record<string, string | undefined>, fallback: Date): Date {
  const rawValue = properties.createdate ?? properties.hs_timestamp;
  if (!rawValue) return fallback;
  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed;
}

function buildImportedBody(input: {
  body: string | undefined;
  fallback: string;
  attachmentIds?: string | undefined;
}) {
  const textBody = plainTextOrNull(input.body);
  if (textBody) return textBody;
  if (hasHubSpotAttachments(input.attachmentIds)) {
    return `${input.fallback} Attachments were present in HubSpot, but no inline text was available.`;
  }
  return `${input.fallback} HubSpot did not provide inline text for this activity.`;
}

function parseDurationMinutes(value: string | undefined): number | null {
  if (!value) return null;
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return Math.max(1, Math.round(millis / 60_000));
}

function normalizeCallOutcome(properties: Record<string, string | undefined>): string | null {
  const outcome = plainTextOrNull(properties.hs_call_outcome);
  if (outcome) return outcome;

  const disposition = plainTextOrNull(properties.hs_call_disposition);
  if (disposition && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(disposition)) {
    return disposition;
  }

  return plainTextOrNull(properties.hs_call_status);
}

function hasHubSpotAttachments(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return trimmed
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .some(Boolean);
}

function parseHeaderAddresses(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .flatMap((entry) => parseHeaderAddresses(entry))
      .filter((value, index, values) => values.indexOf(value) === index);
  }

  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const direct = normalizeEmail(
      typeof record.email === "string"
        ? record.email
        : typeof record.address === "string"
          ? record.address
          : typeof record.value === "string"
            ? record.value
            : undefined
    );
    if (direct) return [direct];
    return Object.values(record).flatMap((entry) => parseHeaderAddresses(entry));
  }

  if (typeof raw === "string") {
    return raw
      .split(/[;,]/)
      .map((part) => {
        const match = part.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
        return normalizeEmail(match?.[0]);
      })
      .filter((value): value is string => Boolean(value));
  }

  return [];
}

function parseEmailHeaders(rawHeaders: string | undefined) {
  if (!rawHeaders) {
    return {
      fromAddress: "unknown@hubspot.invalid",
      toAddresses: [] as string[],
      ccAddresses: [] as string[],
    };
  }

  try {
    const parsed = JSON.parse(rawHeaders) as Record<string, unknown>;
    const fromAddress =
      parseHeaderAddresses(parsed.from ?? parsed.sender ?? parsed.fromAddress)[0] ?? "unknown@hubspot.invalid";
    return {
      fromAddress,
      toAddresses: parseHeaderAddresses(parsed.to ?? parsed.toEmail ?? parsed.recipients),
      ccAddresses: parseHeaderAddresses(parsed.cc),
    };
  } catch {
    return {
      fromAddress: "unknown@hubspot.invalid",
      toAddresses: [],
      ccAddresses: [],
    };
  }
}

function mapDirection(value: string | undefined): "inbound" | "outbound" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "email" || normalized?.includes("outgoing") || normalized === "outbound") return "outbound";
  return "inbound";
}

function resolveEntityLinkFields(target: ResolvedTarget) {
  return {
    dealId: target.type === "deal" ? target.entity.id : null,
    companyId:
      target.type === "company"
        ? target.entity.id
        : target.type === "contact"
          ? target.entity.companyId ?? null
          : null,
    contactId: target.type === "contact" ? target.entity.id : null,
  };
}

function uniqueAssociationIds(results: Array<{ id: string }> | undefined) {
  return Array.from(new Set((results ?? []).map((row) => row.id).filter(Boolean)));
}

function baseResolutionContext(associations: HubSpotAssociations | undefined) {
  return {
    hubspotDealIds: uniqueAssociationIds(associations?.deals?.results),
    hubspotCompanyIds: uniqueAssociationIds(associations?.companies?.results),
    hubspotContactIds: uniqueAssociationIds(associations?.contacts?.results),
  };
}

export function mapNoteToActivity(input: {
  engagement: HubSpotActivityLike;
  targetEntity: ResolvedTarget;
  userId: string;
}) {
  const links = resolveEntityLinkFields(input.targetEntity);
  const occurredAt = parseDate(input.engagement.properties.hs_timestamp);
  return {
    type: "note" as const,
    responsibleUserId: input.userId,
    performedByUserId: input.userId,
    sourceEntityType: input.targetEntity.type,
    sourceEntityId: input.targetEntity.id,
    ...links,
    subject: clampText("HubSpot Note", 500),
    body: buildImportedBody({
      body: input.engagement.properties.hs_note_body,
      fallback: "HubSpot note imported without a text body.",
      attachmentIds: input.engagement.properties.hs_attachment_ids,
    }),
    occurredAt,
    createdAt: parseCreatedAt(input.engagement.properties, occurredAt),
  };
}

export function mapCallToActivity(input: {
  engagement: HubSpotActivityLike;
  targetEntity: ResolvedTarget;
  userId: string;
}) {
  const links = resolveEntityLinkFields(input.targetEntity);
  const occurredAt = parseDate(input.engagement.properties.hs_timestamp);
  return {
    type: "call" as const,
    responsibleUserId: input.userId,
    performedByUserId: input.userId,
    sourceEntityType: input.targetEntity.type,
    sourceEntityId: input.targetEntity.id,
    ...links,
    subject: clampText(plainTextOrNull(input.engagement.properties.hs_call_title) ?? "HubSpot Call", 500),
    body: buildImportedBody({
      body: input.engagement.properties.hs_call_body,
      fallback: "HubSpot call imported without a transcript body.",
      attachmentIds: input.engagement.properties.hs_attachment_ids,
    }),
    outcome: normalizeCallOutcome(input.engagement.properties),
    durationMinutes: parseDurationMinutes(input.engagement.properties.hs_call_duration),
    occurredAt,
    createdAt: parseCreatedAt(input.engagement.properties, occurredAt),
  };
}

export function mapMeetingToActivity(input: {
  engagement: HubSpotActivityLike;
  targetEntity: ResolvedTarget;
  userId: string;
}) {
  const links = resolveEntityLinkFields(input.targetEntity);
  const occurredAt = parseDate(
    input.engagement.properties.hs_meeting_start_time ?? input.engagement.properties.hs_timestamp
  );
  return {
    type: "meeting" as const,
    responsibleUserId: input.userId,
    performedByUserId: input.userId,
    sourceEntityType: input.targetEntity.type,
    sourceEntityId: input.targetEntity.id,
    ...links,
    subject: clampText(plainTextOrNull(input.engagement.properties.hs_meeting_title) ?? "HubSpot Meeting", 500),
    body: buildImportedBody({
      body: input.engagement.properties.hs_meeting_body ?? input.engagement.properties.hs_internal_meeting_notes,
      fallback: "HubSpot meeting imported without agenda notes.",
      attachmentIds: input.engagement.properties.hs_attachment_ids,
    }),
    occurredAt,
    createdAt: parseCreatedAt(input.engagement.properties, occurredAt),
  };
}

export function mapEmailToRecords(input: {
  engagement: HubSpotActivityLike;
  targetEntity: ResolvedTarget;
  userId: string;
}) {
  const bodyHtml =
    normalizeText(input.engagement.properties.hs_email_html) ??
    (normalizeText(input.engagement.properties.hs_email_text)
      ? `<pre>${escapeHtml(input.engagement.properties.hs_email_text as string)}</pre>`
      : null);
  const bodyText =
    plainTextOrNull(input.engagement.properties.hs_email_text) ??
    (bodyHtml ? stripHtml(bodyHtml) : null);
  const participants = parseEmailHeaders(input.engagement.properties.hs_email_headers);
  const subject = plainTextOrNull(input.engagement.properties.hs_email_subject) ?? "HubSpot Email";
  const activitySubject = clampText(subject, 500);
  const sentAt = parseDate(input.engagement.properties.hs_timestamp);
  const createdAt = parseCreatedAt(input.engagement.properties, sentAt);
  const links = resolveEntityLinkFields(input.targetEntity);

  return {
    email: {
      graphMessageId: `hubspot:${input.engagement.id}`,
      graphConversationId: null,
      direction: mapDirection(input.engagement.properties.hs_email_direction),
      fromAddress: participants.fromAddress,
      toAddresses: participants.toAddresses,
      ccAddresses: participants.ccAddresses,
      subject,
      bodyPreview: buildBodyPreview(bodyHtml, bodyText),
      bodyHtml,
      hasAttachments: hasHubSpotAttachments(input.engagement.properties.hs_attachment_ids),
      contactId: input.targetEntity.type === "contact" ? input.targetEntity.entity.id : null,
      dealId: input.targetEntity.type === "deal" ? input.targetEntity.entity.id : null,
      assignedEntityType: input.targetEntity.type,
      assignedEntityId: input.targetEntity.id,
      assignmentStatus: "assigned",
      assignmentConfidence: "high",
      assignmentAmbiguityReason: null,
      userId: input.userId,
      sentAt,
    } satisfies typeof emails.$inferInsert,
    activity: {
      type: "email" as const,
      responsibleUserId: input.userId,
      performedByUserId: input.userId,
      sourceEntityType: input.targetEntity.type,
      sourceEntityId: input.targetEntity.id,
      ...links,
      subject: activitySubject,
      body: bodyText?.slice(0, 1000) ?? null,
      occurredAt: sentAt,
      createdAt,
    } satisfies typeof activities.$inferInsert,
  };
}

export async function findTargetEntityForHubspotEngagement(
  tenantDb: any,
  associations: HubSpotAssociations | undefined
): Promise<EntityResolution> {
  const context = baseResolutionContext(associations);

  if (context.hubspotDealIds.length > 0) {
    const rows = (await tenantDb
      .select({
        id: deals.id,
        name: deals.name,
        hubspotDealId: deals.hubspotDealId,
      })
      .from(deals)
      .where(and(eq(deals.isActive, true), inArray(deals.hubspotDealId, context.hubspotDealIds)))) as BackfillDealRecord[];

    const distinctDeals = Array.from(new Map(rows.map((row: BackfillDealRecord) => [row.id, row])).values());
    if (distinctDeals.length > 1) {
      return {
        type: "ambiguous",
        ...context,
        reason: "Multiple active T Rock deals matched the HubSpot deal association",
      };
    }
    if (distinctDeals.length === 1) {
      return {
        type: "deal",
        id: distinctDeals[0].id,
        entity: distinctDeals[0],
        ...context,
      };
    }
  }

  if (context.hubspotCompanyIds.length > 0) {
    const rows = (await tenantDb
      .select({
        id: companies.id,
        name: companies.name,
        hubspotCompanyId: companies.hubspotCompanyId,
        hubspotId: companies.hubspotId,
      })
      .from(companies)
      .where(
        and(
          eq(companies.isActive, true),
          or(
            inArray(companies.hubspotCompanyId, context.hubspotCompanyIds),
            inArray(companies.hubspotId, context.hubspotCompanyIds)
          )
        )
      )) as BackfillCompanyRecord[];

    const distinctCompanies = Array.from(new Map(rows.map((row: BackfillCompanyRecord) => [row.id, row])).values());
    if (distinctCompanies.length > 1) {
      return {
        type: "ambiguous",
        ...context,
        reason: "Multiple active T Rock companies matched the HubSpot company association",
      };
    }
    if (distinctCompanies.length === 1) {
      return {
        type: "company",
        id: distinctCompanies[0].id,
        entity: distinctCompanies[0],
        ...context,
      };
    }
  }

  if (context.hubspotContactIds.length > 0) {
    const rows = (await tenantDb
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        companyId: contacts.companyId,
        hubspotContactId: contacts.hubspotContactId,
      })
      .from(contacts)
      .where(
        and(eq(contacts.isActive, true), inArray(contacts.hubspotContactId, context.hubspotContactIds))
      )) as BackfillContactRecord[];

    const distinctContacts = Array.from(new Map(rows.map((row: BackfillContactRecord) => [row.id, row])).values());
    if (distinctContacts.length > 1) {
      return {
        type: "ambiguous",
        ...context,
        reason: "Multiple active T Rock contacts matched the HubSpot contact association",
      };
    }
    if (distinctContacts.length === 1) {
      return {
        type: "contact",
        id: distinctContacts[0].id,
        entity: distinctContacts[0],
        ...context,
      };
    }
  }

  return {
    type: "orphan",
    ...context,
    reason:
      context.hubspotDealIds.length + context.hubspotCompanyIds.length + context.hubspotContactIds.length > 0
        ? "No active T Rock deal, company, or contact matched the HubSpot associations"
        : "HubSpot engagement had no deal, company, or contact associations",
  };
}

export async function findDealForHubspotEngagement(
  tenantDb: any,
  associations: HubSpotAssociations | undefined
): Promise<DealLookupResult> {
  const hubspotDealIds = uniqueAssociationIds(associations?.deals?.results);
  const resolution = await findTargetEntityForHubspotEngagement(tenantDb, associations);

  if (resolution.type === "deal") {
    return {
      status: "deal",
      deal: resolution.entity,
      hubspotDealIds,
    };
  }

  if (resolution.type === "ambiguous" && hubspotDealIds.length > 0) {
    return {
      status: "ambiguous",
      hubspotDealIds,
    };
  }

  return {
    status: "orphan",
    hubspotDealIds,
  };
}

export async function findUserForHubspotOwner(
  db: any,
  ownerId: string | undefined,
  ownerEmailById?: Map<string, string>,
  officeId?: string
): Promise<BackfillUserRecord | null> {
  if (!ownerId) return null;

  const mappedRows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isActive: users.isActive,
    })
    .from(hubspotOwnerMappings)
    .innerJoin(users, eq(hubspotOwnerMappings.userId, users.id))
    .where(
      and(
        eq(hubspotOwnerMappings.hubspotOwnerId, ownerId),
        officeId ? eq(hubspotOwnerMappings.officeId, officeId) : undefined,
        officeId ? eq(users.officeId, officeId) : undefined
      )
    )
    .limit(1);

  const mappedUser = mappedRows[0];
  if (mappedUser?.isActive) {
    return {
      id: mappedUser.id,
      email: mappedUser.email,
      displayName: mappedUser.displayName,
    };
  }

  const ownerEmail = normalizeEmail(ownerEmailById?.get(ownerId));
  if (!ownerEmail) return null;

  const directRows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isActive: users.isActive,
    })
    .from(users)
    .where(
      and(
        eq(users.email, ownerEmail),
        eq(users.isActive, true),
        officeId ? eq(users.officeId, officeId) : undefined
      )
    )
    .limit(1);

  const directUser = directRows[0];
  if (!directUser) return null;

  return {
    id: directUser.id,
    email: directUser.email,
    displayName: directUser.displayName,
  };
}

export async function getExistingLedgerEntry(
  db: any,
  tenantSchema: string,
  hubspotObjectType: BackfillObjectType,
  hubspotObjectId: string
) {
  const rows = await db
    .select()
    .from(hubspotActivityBackfillLedger)
    .where(
      and(
        eq(hubspotActivityBackfillLedger.tenantSchema, tenantSchema),
        eq(hubspotActivityBackfillLedger.hubspotObjectType, hubspotObjectType),
        eq(hubspotActivityBackfillLedger.hubspotObjectId, hubspotObjectId)
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function writeLedgerOnly(db: any, ledger: LedgerWriteInput) {
  return db.transaction(async (tx: any) => {
    await tx.execute?.(
      sql`SELECT pg_advisory_xact_lock(
        hashtext(${`${ledger.tenantSchema}:${ledger.hubspotObjectType}`}),
        hashtext(${ledger.hubspotObjectId})
      )`
    );

    const existingRows = await tx
      .select({
        activityId: hubspotActivityBackfillLedger.activityId,
        emailId: hubspotActivityBackfillLedger.emailId,
        status: hubspotActivityBackfillLedger.status,
      })
      .from(hubspotActivityBackfillLedger)
      .where(
        and(
          eq(hubspotActivityBackfillLedger.tenantSchema, ledger.tenantSchema),
          eq(hubspotActivityBackfillLedger.hubspotObjectType, ledger.hubspotObjectType),
          eq(hubspotActivityBackfillLedger.hubspotObjectId, ledger.hubspotObjectId)
        )
      )
      .limit(1);

    const existingLedger = existingRows[0];
    if (existingLedger?.status === "imported") {
      return {
        activityId: existingLedger.activityId as string | null,
        emailId: (existingLedger.emailId as string | null) ?? null,
        didWrite: false,
      };
    }

    await tx
      .insert(hubspotActivityBackfillLedger)
      .values({
        tenantSchema: ledger.tenantSchema,
        hubspotObjectType: ledger.hubspotObjectType,
        hubspotObjectId: ledger.hubspotObjectId,
        targetEntityType: ledger.targetEntityType,
        targetEntityId: ledger.targetEntityId,
        status: ledger.status,
        skipReason: ledger.skipReason ?? null,
        sourcePayload: ledger.sourcePayload ?? null,
        activityId: null,
        emailId: null,
        importedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          hubspotActivityBackfillLedger.tenantSchema,
          hubspotActivityBackfillLedger.hubspotObjectType,
          hubspotActivityBackfillLedger.hubspotObjectId,
        ],
        set: {
          targetEntityType: ledger.targetEntityType,
          targetEntityId: ledger.targetEntityId,
          status: ledger.status,
          skipReason: ledger.skipReason ?? null,
          sourcePayload: ledger.sourcePayload ?? null,
          activityId: null,
          emailId: null,
          importedAt: new Date(),
        },
      });

    return {
      activityId: null,
      emailId: null,
      didWrite: true,
    };
  });
}

export async function writeAtomic(db: any, input: AtomicWriteInput) {
  return db.transaction(async (tx: any) => {
    await tx.execute?.(
      sql`SELECT pg_advisory_xact_lock(
        hashtext(${`${input.ledger.tenantSchema}:${input.ledger.hubspotObjectType}`}),
        hashtext(${input.ledger.hubspotObjectId})
      )`
    );

    const existingRows = await tx
      .select({
        activityId: hubspotActivityBackfillLedger.activityId,
        emailId: hubspotActivityBackfillLedger.emailId,
        status: hubspotActivityBackfillLedger.status,
      })
      .from(hubspotActivityBackfillLedger)
      .where(
        and(
          eq(hubspotActivityBackfillLedger.tenantSchema, input.ledger.tenantSchema),
          eq(hubspotActivityBackfillLedger.hubspotObjectType, input.ledger.hubspotObjectType),
          eq(hubspotActivityBackfillLedger.hubspotObjectId, input.ledger.hubspotObjectId)
        )
      )
      .limit(1);

    const existingLedger = existingRows[0];
    if (existingLedger?.status === "imported") {
      return {
        activityId: existingLedger.activityId as string,
        emailId: (existingLedger.emailId as string | null) ?? null,
        didImport: false,
      };
    }

    let emailId: string | null = null;

    if (input.email) {
      const [emailRow] = await tx.insert(emails).values(input.email).returning();
      emailId = emailRow.id;
    }

    const [activityRow] = await tx
      .insert(activities)
      .values({
        ...input.activity,
        emailId: emailId ?? input.activity.emailId ?? null,
      })
      .returning();

    await tx
      .insert(hubspotActivityBackfillLedger)
      .values({
        tenantSchema: input.ledger.tenantSchema,
        hubspotObjectType: input.ledger.hubspotObjectType,
        hubspotObjectId: input.ledger.hubspotObjectId,
        targetEntityType: input.ledger.targetEntityType,
        targetEntityId: input.ledger.targetEntityId,
        status: input.ledger.status,
        skipReason: input.ledger.skipReason ?? null,
        sourcePayload: input.ledger.sourcePayload ?? null,
        activityId: activityRow.id,
        emailId,
        importedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          hubspotActivityBackfillLedger.tenantSchema,
          hubspotActivityBackfillLedger.hubspotObjectType,
          hubspotActivityBackfillLedger.hubspotObjectId,
        ],
        set: {
          targetEntityType: input.ledger.targetEntityType,
          targetEntityId: input.ledger.targetEntityId,
          status: input.ledger.status,
          skipReason: input.ledger.skipReason ?? null,
          sourcePayload: input.ledger.sourcePayload ?? null,
          activityId: activityRow.id,
          emailId,
          importedAt: new Date(),
        },
      })
      .returning();

    return { activityId: activityRow.id as string, emailId, didImport: true };
  });
}
