import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@trock-crm/shared/schema";
import { offices } from "../shared/src/schema/public/offices.js";
import { fetchAllOwners, fetchHubSpotActivitiesByType, type HubSpotActivityObjectType } from "../server/src/modules/migration/hubspot-client.js";
import {
  findTargetEntityForHubspotEngagement,
  findUserForHubspotOwner,
  getExistingLedgerEntry,
  mapCallToActivity,
  mapEmailToRecords,
  mapMeetingToActivity,
  mapNoteToActivity,
  writeAtomic,
  writeLedgerOnly,
  type BackfillObjectType,
  type HubSpotActivityLike,
  type ResolvedTarget,
} from "../server/src/modules/migration/deal-activity-backfill-service.js";

export interface BackfillArgs {
  office: string;
  type: BackfillObjectType | "all";
  mode: "dry-run" | "execute";
  since: string | null;
  limit: number | null;
  dealId: string | null;
}

type TypeReport = {
  fetched: number;
  wouldImport: number;
  imported: number;
  alreadyImported: number;
  wouldImportToDeals: number;
  wouldImportToCompanies: number;
  wouldImportToContacts: number;
  importedToDeals: number;
  importedToCompanies: number;
  importedToContacts: number;
  skippedOrphan: number;
  skippedAmbiguous: number;
  skippedUnmappedUser: number;
  failed: number;
  orphanSamples: string[];
  unmappedUserSamples: string[];
};

type EntityVolume = {
  entityId: string;
  entityName: string;
  entityType: "deal" | "company" | "contact";
  counts: Record<BackfillObjectType, number>;
};

export interface BackfillReport {
  office: string;
  selectedType: BackfillArgs["type"];
  mode: BackfillArgs["mode"];
  byType: Partial<Record<BackfillObjectType, TypeReport>>;
  topEntities: EntityVolume[];
  durationMs: number;
}

type DefaultDb = ReturnType<typeof drizzle<typeof schema>>;
type Connections = {
  publicDb: DefaultDb;
  tenantDb: DefaultDb;
  close: () => Promise<void>;
};

type RunDeps = {
  getAvailableTypes: () => readonly BackfillObjectType[];
  fetchOwners: () => Promise<Array<{ id: string; email?: string }>>;
  fetchEngagementsByType: (
    type: BackfillObjectType,
    options: Pick<BackfillArgs, "since" | "limit">
  ) => Promise<HubSpotActivityLike[]>;
  getExistingLedgerEntry: typeof getExistingLedgerEntry;
  findTargetEntityForHubspotEngagement: typeof findTargetEntityForHubspotEngagement;
  findUserForHubspotOwner: typeof findUserForHubspotOwner;
  mapNoteToActivity: typeof mapNoteToActivity;
  mapCallToActivity: typeof mapCallToActivity;
  mapMeetingToActivity: typeof mapMeetingToActivity;
  mapEmailToRecords: typeof mapEmailToRecords;
  writeAtomic: typeof writeAtomic;
  writeLedgerOnly: typeof writeLedgerOnly;
  createConnections: (officeSchema: string) => Promise<Connections>;
  validateOffice: (
    publicDb: DefaultDb,
    officeSchema: string
  ) => Promise<{ schemaName: string; officeSlug: string; officeId: string }>;
};

const DEFAULT_TYPES = ["note", "call", "meeting", "email"] as const;

function emptyTypeReport(): TypeReport {
  return {
    fetched: 0,
    wouldImport: 0,
    imported: 0,
    alreadyImported: 0,
    wouldImportToDeals: 0,
    wouldImportToCompanies: 0,
    wouldImportToContacts: 0,
    importedToDeals: 0,
    importedToCompanies: 0,
    importedToContacts: 0,
    skippedOrphan: 0,
    skippedAmbiguous: 0,
    skippedUnmappedUser: 0,
    failed: 0,
    orphanSamples: [],
    unmappedUserSamples: [],
  };
}

function parseDateFilter(value: string | null): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid --since value: ${value}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid --since value: ${value}`);
  const normalized = parsed.toISOString().slice(0, 10);
  if (normalized !== value) throw new Error(`Invalid --since value: ${value}`);
  return parsed;
}

export function parseBackfillArgs(argv: string[]): BackfillArgs {
  let office: string | null = null;
  let type: BackfillArgs["type"] = "note";
  let mode: BackfillArgs["mode"] = "dry-run";
  let since: string | null = null;
  let limit: number | null = null;
  let dealId: string | null = null;
  let explicitDryRun = false;
  let explicitExecute = false;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--office=")) office = arg.slice("--office=".length);
    else if (arg.startsWith("--type=")) type = arg.slice("--type=".length) as BackfillArgs["type"];
    else if (arg === "--dry-run") explicitDryRun = true;
    else if (arg === "--execute") explicitExecute = true;
    else if (arg.startsWith("--since=")) since = arg.slice("--since=".length);
    else if (arg.startsWith("--limit=")) limit = Number(arg.slice("--limit=".length));
    else if (arg.startsWith("--deal-id=")) dealId = arg.slice("--deal-id=".length);
  }

  if (!office) throw new Error("--office is required");
  if (explicitDryRun && explicitExecute) throw new Error("--dry-run and --execute are mutually exclusive");
  if (explicitExecute) mode = "execute";
  if (!DEFAULT_TYPES.includes(type as BackfillObjectType) && type !== "all") {
    throw new Error(`Invalid --type value: ${type}`);
  }
  if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`Invalid --limit value: ${limit}`);
  }
  parseDateFilter(since);

  return { office, type, mode, since, limit, dealId };
}

function defaultFetchFilter(rows: HubSpotActivityLike[], options: Pick<BackfillArgs, "since" | "limit">) {
  const since = parseDateFilter(options.since);
  const filtered = rows.filter((row) => {
    if (!since) return true;
    const timestamp = row.properties.hs_timestamp;
    if (!timestamp) return false;
    const parsed = new Date(timestamp);
    return !Number.isNaN(parsed.getTime()) && parsed >= since;
  });

  return options.limit ? filtered.slice(0, options.limit) : filtered;
}

async function defaultFetchEngagementsByType(
  type: BackfillObjectType,
  options: Pick<BackfillArgs, "since" | "limit">
) {
  const rows = await fetchHubSpotActivitiesByType(type as HubSpotActivityObjectType);
  return defaultFetchFilter(rows as HubSpotActivityLike[], options);
}

async function defaultCreateConnections(officeSchema: string): Promise<Connections> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("SELECT set_config('search_path', $1, false)", [`${officeSchema},public`]);
  const db = drizzle(client, { schema });
  return {
    publicDb: db,
    tenantDb: db,
    close: async () => {
      await client.end();
    },
  };
}

async function defaultValidateOffice(publicDb: DefaultDb, officeSchema: string) {
  if (!/^office_[a-z][a-z0-9_]*$/.test(officeSchema)) throw new Error(`Invalid office schema: ${officeSchema}`);
  const officeSlug = officeSchema.slice("office_".length);
  const rows = await publicDb
    .select({ id: offices.id, slug: offices.slug })
    .from(offices)
    .where(and(eq(offices.slug, officeSlug), eq(offices.isActive, true)))
    .limit(1);
  if (!rows[0]) throw new Error(`Unknown or inactive office schema: ${officeSchema}`);
  return { schemaName: officeSchema, officeSlug, officeId: rows[0].id };
}

const defaultDeps: RunDeps = {
  getAvailableTypes: () => DEFAULT_TYPES,
  fetchOwners: fetchAllOwners,
  fetchEngagementsByType: defaultFetchEngagementsByType,
  getExistingLedgerEntry,
  findTargetEntityForHubspotEngagement,
  findUserForHubspotOwner,
  mapNoteToActivity,
  mapCallToActivity,
  mapMeetingToActivity,
  mapEmailToRecords,
  writeAtomic,
  writeLedgerOnly,
  createConnections: defaultCreateConnections,
  validateOffice: defaultValidateOffice,
};

function incrementEntityVolume(
  volumeByEntityId: Map<string, EntityVolume>,
  type: BackfillObjectType,
  target: ResolvedTarget
) {
  const key = `${target.type}:${target.id}`;
  const entityName =
    target.type === "deal"
      ? target.entity.name ?? "Unknown Deal"
      : target.type === "company"
        ? target.entity.name
        : `${target.entity.firstName} ${target.entity.lastName}`.trim() || "Unknown Contact";
  const existing = volumeByEntityId.get(key) ?? {
    entityId: target.id,
    entityType: target.type,
    entityName,
    counts: { note: 0, call: 0, meeting: 0, email: 0 },
  };
  existing.counts[type] += 1;
  volumeByEntityId.set(key, existing);
}

function buildOrphanSample(
  type: BackfillObjectType,
  engagement: HubSpotActivityLike,
  associations: { dealIds: string[]; companyIds: string[]; contactIds: string[] }
) {
  const created = engagement.properties.hs_timestamp ?? "unknown date";
  const dealIds = associations.dealIds.length > 0 ? associations.dealIds.join(", ") : "none";
  const companyIds = associations.companyIds.length > 0 ? associations.companyIds.join(", ") : "none";
  const contactIds = associations.contactIds.length > 0 ? associations.contactIds.join(", ") : "none";
  return `HubSpot ${type} ${engagement.id} created ${created} — HubSpot deals ${dealIds}; companies ${companyIds}; contacts ${contactIds}; no T Rock match`;
}

function buildUnmappedUserSample(
  engagement: HubSpotActivityLike,
  ownerEmailById: Map<string, string>,
  ownerId: string | undefined
) {
  const ownerEmail = ownerId ? ownerEmailById.get(ownerId) ?? "unknown" : "unknown";
  return `HubSpot owner ${ownerId ?? "unknown"} (email: ${ownerEmail}) — no T Rock equivalent`;
}

export async function runBackfill(args: BackfillArgs, deps: RunDeps = defaultDeps): Promise<BackfillReport> {
  const startedAt = Date.now();
  const ownerEmailById = new Map(
    (await deps.fetchOwners()).map((owner) => [owner.id, owner.email?.toLowerCase().trim() ?? ""])
  );
  const requestedTypes = args.type === "all" ? [...deps.getAvailableTypes()] : [args.type];
  const byType: Partial<Record<BackfillObjectType, TypeReport>> = {};
  const volumeByEntityId = new Map<string, EntityVolume>();

  const bootstrap = await deps.createConnections(args.office);
  try {
    const office = await deps.validateOffice(bootstrap.publicDb, args.office);

    for (const type of requestedTypes) {
      const report = emptyTypeReport();
      byType[type] = report;

      const engagements = await deps.fetchEngagementsByType(type, {
        since: args.since,
        limit: args.limit,
      });

      for (const engagement of engagements) {
        report.fetched += 1;

        try {
          const existingLedger = await deps.getExistingLedgerEntry(bootstrap.publicDb, args.office, type, engagement.id);
          if (existingLedger?.status === "imported") {
            report.alreadyImported += 1;
            continue;
          }

          const targetResult = await deps.findTargetEntityForHubspotEngagement(
            bootstrap.tenantDb,
            engagement.associations
          );
          if (targetResult.type === "orphan") {
            report.skippedOrphan += 1;
            if (report.orphanSamples.length < 10) {
              report.orphanSamples.push(
                buildOrphanSample(type, engagement, {
                  dealIds: targetResult.hubspotDealIds,
                  companyIds: targetResult.hubspotCompanyIds,
                  contactIds: targetResult.hubspotContactIds,
                })
              );
            }
            if (args.mode === "execute") {
              await deps.writeLedgerOnly(bootstrap.publicDb, {
                tenantSchema: args.office,
                hubspotObjectType: type,
                hubspotObjectId: engagement.id,
                targetEntityType: null,
                targetEntityId: null,
                status: "skipped_orphan",
                skipReason: targetResult.reason,
                sourcePayload: engagement as unknown as Record<string, unknown>,
              });
            }
            continue;
          }

          if (targetResult.type === "ambiguous") {
            report.skippedAmbiguous += 1;
            if (args.mode === "execute") {
              await deps.writeLedgerOnly(bootstrap.publicDb, {
                tenantSchema: args.office,
                hubspotObjectType: type,
                hubspotObjectId: engagement.id,
                targetEntityType: null,
                targetEntityId: null,
                status: "skipped_ambiguous",
                skipReason: targetResult.reason,
                sourcePayload: engagement as unknown as Record<string, unknown>,
              });
            }
            continue;
          }

          if (args.dealId && (targetResult.type !== "deal" || targetResult.id !== args.dealId)) {
            continue;
          }

          const ownerId = engagement.properties.hubspot_owner_id;
          const user = await deps.findUserForHubspotOwner(
            bootstrap.publicDb,
            ownerId,
            ownerEmailById,
            office.officeId
          );
          if (!user) {
            report.skippedUnmappedUser += 1;
            if (report.unmappedUserSamples.length < 10) {
              report.unmappedUserSamples.push(buildUnmappedUserSample(engagement, ownerEmailById, ownerId));
            }
            if (args.mode === "execute") {
              await deps.writeLedgerOnly(bootstrap.publicDb, {
                tenantSchema: args.office,
                hubspotObjectType: type,
                hubspotObjectId: engagement.id,
                targetEntityType: targetResult.type,
                targetEntityId: targetResult.id,
                status: "skipped_unmapped_user",
                skipReason: "HubSpot owner could not be mapped to an active T Rock user",
                sourcePayload: engagement as unknown as Record<string, unknown>,
              });
            }
            continue;
          }

          if (args.mode === "dry-run") {
            incrementEntityVolume(volumeByEntityId, type, targetResult);
            report.wouldImport += 1;
            if (targetResult.type === "deal") report.wouldImportToDeals += 1;
            if (targetResult.type === "company") report.wouldImportToCompanies += 1;
            if (targetResult.type === "contact") report.wouldImportToContacts += 1;
            continue;
          }

          if (type === "email") {
            const payload = deps.mapEmailToRecords({
              engagement,
              targetEntity: targetResult,
              userId: user.id,
            });
            const result = await deps.writeAtomic(bootstrap.publicDb, {
              ledger: {
                tenantSchema: args.office,
                hubspotObjectType: type,
                hubspotObjectId: engagement.id,
                targetEntityType: targetResult.type,
                targetEntityId: targetResult.id,
                status: "imported",
                sourcePayload: engagement as unknown as Record<string, unknown>,
              },
              email: payload.email,
              activity: payload.activity,
            });
            if (!result.didImport) {
              report.alreadyImported += 1;
              continue;
            }
          } else {
            const activity =
              type === "note"
                ? deps.mapNoteToActivity({ engagement, targetEntity: targetResult, userId: user.id })
                : type === "call"
                  ? deps.mapCallToActivity({ engagement, targetEntity: targetResult, userId: user.id })
                  : deps.mapMeetingToActivity({ engagement, targetEntity: targetResult, userId: user.id });
            const result = await deps.writeAtomic(bootstrap.publicDb, {
              ledger: {
                tenantSchema: args.office,
                hubspotObjectType: type,
                hubspotObjectId: engagement.id,
                targetEntityType: targetResult.type,
                targetEntityId: targetResult.id,
                status: "imported",
                sourcePayload: engagement as unknown as Record<string, unknown>,
              },
              activity,
            });
            if (!result.didImport) {
              report.alreadyImported += 1;
              continue;
            }
          }

          report.imported += 1;
          incrementEntityVolume(volumeByEntityId, type, targetResult);
          if (targetResult.type === "deal") report.importedToDeals += 1;
          if (targetResult.type === "company") report.importedToCompanies += 1;
          if (targetResult.type === "contact") report.importedToContacts += 1;
        } catch (error) {
          report.failed += 1;
          if (args.mode === "execute") {
            await deps.writeLedgerOnly(bootstrap.publicDb, {
              tenantSchema: args.office,
              hubspotObjectType: type,
              hubspotObjectId: engagement.id,
              targetEntityType: null,
              targetEntityId: null,
              status: "failed",
              skipReason: error instanceof Error ? error.message : String(error),
              sourcePayload: engagement as unknown as Record<string, unknown>,
            });
          }
        }
      }
    }
  } finally {
    await bootstrap.close();
  }

  return {
    office: args.office,
    selectedType: args.type,
    mode: args.mode,
    byType,
    topEntities: [...volumeByEntityId.values()]
      .sort((a, b) => {
        const totalA = a.counts.note + a.counts.call + a.counts.meeting + a.counts.email;
        const totalB = b.counts.note + b.counts.call + b.counts.meeting + b.counts.email;
        return totalB - totalA;
      })
      .slice(0, 10),
    durationMs: Date.now() - startedAt,
  };
}

export function renderBackfillReport(report: BackfillReport) {
  const lines = [
    `HubSpot Deal Activity Backfill — ${report.office} — ${report.selectedType} — ${report.mode}`,
  ];

  for (const type of DEFAULT_TYPES) {
    const typeReport = report.byType[type];
    if (!typeReport) continue;
    lines.push(`${type[0].toUpperCase()}${type.slice(1)}s:`);
    lines.push(`Fetched: ${typeReport.fetched}`);
    lines.push(`Would import / Imported: ${report.mode === "dry-run" ? typeReport.wouldImport : typeReport.imported}`);
    lines.push(
      `${report.mode === "dry-run" ? "Would import" : "Imported"} to deals: ${
        report.mode === "dry-run" ? typeReport.wouldImportToDeals : typeReport.importedToDeals
      }`
    );
    lines.push(
      `${report.mode === "dry-run" ? "Would import" : "Imported"} to companies: ${
        report.mode === "dry-run" ? typeReport.wouldImportToCompanies : typeReport.importedToCompanies
      }`
    );
    lines.push(
      `${report.mode === "dry-run" ? "Would import" : "Imported"} to contacts: ${
        report.mode === "dry-run" ? typeReport.wouldImportToContacts : typeReport.importedToContacts
      }`
    );
    lines.push(`Already imported: ${typeReport.alreadyImported}`);
    lines.push(`Skipped (orphan, no entity match): ${typeReport.skippedOrphan}`);
    lines.push(`Skipped (ambiguous, multiple entity matches): ${typeReport.skippedAmbiguous}`);
    lines.push(`Skipped (unmapped user): ${typeReport.skippedUnmappedUser}`);
    lines.push(`Failed: ${typeReport.failed}`);
    lines.push("");
  }

  lines.push("Top entities by activity volume (first 10):");
  if (report.topEntities.length === 0) {
    lines.push("None");
  } else {
    for (const entity of report.topEntities) {
      lines.push(
        `${entity.entityType[0].toUpperCase()}${entity.entityType.slice(1)} "${entity.entityName}" (${entity.entityId}): ${entity.counts.note} notes, ${entity.counts.call} calls, ${entity.counts.meeting} meetings, ${entity.counts.email} emails`
      );
    }
  }

  lines.push("");
  lines.push("Sample orphans (first 10):");
  const orphanSamples = DEFAULT_TYPES.flatMap((type) => report.byType[type]?.orphanSamples ?? []).slice(0, 10);
  lines.push(...(orphanSamples.length > 0 ? orphanSamples : ["None"]));
  lines.push("");
  lines.push("Sample unmapped users (first 10):");
  const unmappedUserSamples = DEFAULT_TYPES.flatMap((type) => report.byType[type]?.unmappedUserSamples ?? []).slice(0, 10);
  lines.push(...(unmappedUserSamples.length > 0 ? unmappedUserSamples : ["None"]));
  lines.push("");
  lines.push(`Total duration: ${Math.round(report.durationMs / 1000)}s`);

  return lines.join("\n");
}

if (process.argv[1]?.endsWith("hubspot-deal-activity-backfill.ts") && !process.env.VITEST) {
  runBackfill(parseBackfillArgs(process.argv), defaultDeps)
    .then((report) => {
      console.log(renderBackfillReport(report));
      if (report.mode === "dry-run") process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
