import { and, eq, inArray, sql } from "drizzle-orm";
import {
  activities,
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

export interface BackfillUserRecord {
  id: string;
  email: string;
  displayName?: string | null;
}

export interface DealResolution {
  status: "deal";
  deal: BackfillDealRecord;
  hubspotDealIds: string[];
}

export interface OrphanResolution {
  status: "orphan";
  hubspotDealIds: string[];
}

export interface AmbiguousResolution {
  status: "ambiguous";
  hubspotDealIds: string[];
  deals?: BackfillDealRecord[];
}

export type DealLookupResult = DealResolution | OrphanResolution | AmbiguousResolution;

export interface LedgerWriteInput {
  tenantSchema: string;
  hubspotObjectType: BackfillObjectType;
  hubspotObjectId: string;
  targetEntityType: "deal" | null;
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

function normalizeEmail(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function clampText(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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

function parseDurationMinutes(value: string | undefined): number | null {
  if (!value) return null;
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return Math.max(1, Math.round(millis / 60_000));
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

export function mapNoteToActivity(input: {
  engagement: HubSpotActivityLike;
  deal: BackfillDealRecord;
  userId: string;
}) {
  return {
    type: "note" as const,
    responsibleUserId: input.userId,
    performedByUserId: input.userId,
    sourceEntityType: "deal" as const,
    sourceEntityId: input.deal.id,
    dealId: input.deal.id,
    subject: clampText("HubSpot Note", 500),
    body: normalizeText(input.engagement.properties.hs_note_body),
    occurredAt: parseDate(input.engagement.properties.hs_timestamp),
  };
}

export function mapCallToActivity(input: {
  engagement: HubSpotActivityLike;
  deal: BackfillDealRecord;
  userId: string;
}) {
  return {
    type: "call" as const,
    responsibleUserId: input.userId,
    performedByUserId: input.userId,
    sourceEntityType: "deal" as const,
    sourceEntityId: input.deal.id,
    dealId: input.deal.id,
    subject: clampText(normalizeText(input.engagement.properties.hs_call_title) ?? "HubSpot Call", 500),
    body: normalizeText(input.engagement.properties.hs_call_body),
    outcome:
      normalizeText(input.engagement.properties.hs_call_outcome) ??
      normalizeText(input.engagement.properties.hs_call_status),
    durationMinutes: parseDurationMinutes(input.engagement.properties.hs_call_duration),
    occurredAt: parseDate(input.engagement.properties.hs_timestamp),
  };
}

export function mapMeetingToActivity(input: {
  engagement: HubSpotActivityLike;
  deal: BackfillDealRecord;
  userId: string;
}) {
  return {
    type: "meeting" as const,
    responsibleUserId: input.userId,
    performedByUserId: input.userId,
    sourceEntityType: "deal" as const,
    sourceEntityId: input.deal.id,
    dealId: input.deal.id,
    subject: clampText(normalizeText(input.engagement.properties.hs_meeting_title) ?? "HubSpot Meeting", 500),
    body:
      normalizeText(input.engagement.properties.hs_meeting_body) ??
      normalizeText(input.engagement.properties.hs_internal_meeting_notes),
    occurredAt: parseDate(
      input.engagement.properties.hs_meeting_start_time ?? input.engagement.properties.hs_timestamp
    ),
  };
}

export function mapEmailToRecords(input: {
  engagement: HubSpotActivityLike;
  deal: BackfillDealRecord;
  userId: string;
}) {
  const bodyHtml =
    normalizeText(input.engagement.properties.hs_email_html) ??
    (normalizeText(input.engagement.properties.hs_email_text)
      ? `<pre>${escapeHtml(input.engagement.properties.hs_email_text as string)}</pre>`
      : null);
  const bodyText =
    normalizeText(input.engagement.properties.hs_email_text) ??
    (bodyHtml ? stripHtml(bodyHtml) : null);
  const participants = parseEmailHeaders(input.engagement.properties.hs_email_headers);
  const subject = normalizeText(input.engagement.properties.hs_email_subject) ?? "HubSpot Email";
  const activitySubject = clampText(subject, 500);
  const sentAt = parseDate(input.engagement.properties.hs_timestamp);

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
      contactId: null,
      dealId: input.deal.id,
      assignedEntityType: "deal",
      assignedEntityId: input.deal.id,
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
      sourceEntityType: "deal" as const,
      sourceEntityId: input.deal.id,
      dealId: input.deal.id,
      subject: activitySubject,
      body: bodyText?.slice(0, 1000) ?? null,
      occurredAt: sentAt,
    } satisfies typeof activities.$inferInsert,
  };
}

export async function findDealForHubspotEngagement(
  tenantDb: any,
  associations: HubSpotActivityLike["associations"] | undefined
): Promise<DealLookupResult> {
  const hubspotDealIds = Array.from(
    new Set((associations?.deals?.results ?? []).map((deal) => deal.id).filter(Boolean))
  );

  if (hubspotDealIds.length === 0) {
    return { status: "orphan", hubspotDealIds: [] };
  }

  const rows = (await tenantDb
    .select({
      id: deals.id,
      name: deals.name,
      hubspotDealId: deals.hubspotDealId,
    })
    .from(deals)
    .where(and(eq(deals.isActive, true), inArray(deals.hubspotDealId, hubspotDealIds)))) as BackfillDealRecord[];

  const distinctDeals = Array.from(new Map(rows.map((row: BackfillDealRecord) => [row.id, row])).values());
  if (distinctDeals.length === 0) {
    return { status: "orphan", hubspotDealIds };
  }
  if (distinctDeals.length > 1) {
    return { status: "ambiguous", hubspotDealIds, deals: distinctDeals };
  }

  return { status: "deal", hubspotDealIds, deal: distinctDeals[0] };
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
  await db
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
