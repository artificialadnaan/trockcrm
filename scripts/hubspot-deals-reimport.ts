import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { parseCsvText } from "./reconcile-hubspot-csv.js";
import {
  buildProjectNumber,
  generateJulianDate,
  getNextSuffix,
  parseProjectNumberSuffix,
  resolveOfficeCode,
  resolveProjectTypeCode,
} from "../server/src/services/projectNumber.js";
import { isProjectTypeValue, normalizeProjectType } from "../shared/src/types/project-types.js";
import { buildAuditActorFromSystem } from "../server/src/modules/audit/audit-logger.js";
import { logActivityWithPgClient } from "../server/src/modules/audit/pg-activity-logger.js";
import { HUBSPOT_REIMPORT } from "../server/src/modules/audit/system-processes.js";
import {
  normalizeProjectNumberInput,
  ProjectNumberValidationError,
} from "../server/src/modules/deals/project-number-validation.js";
import { applyProjectNumberEmailSkipSetting } from "./lib/project-number-notification.js";

/**
 * HubSpot deals re-import assumptions:
 * - This script targets the Dallas tenant by default because the live HubSpot-linked deal set is in office_dallas.
 * - Deduplication is anchored on deals.hubspot_deal_id. If that column is absent or unusable, this strategy is invalid.
 * - Dry-run is the default behavior. Real writes require BOTH --apply and --confirm-production.
 * - Safe update fields are intentionally narrow: amount, deal_name, project_number, project_type, last_modified_at.
 * - Null/blank CSV values never clear non-null CRM data. In this reconciliation, null-from-CSV means "no opinion",
 *   not "set the CRM value to null".
 * - Stage, assignee, and other operational workflow fields are not updated from the CSV in this script.
 * - The create path reuses the existing in-repo HubSpot import contract as closely as possible:
 *   deal number generation mirrors scripts/migration-promote.ts and the inserted field set stays narrow.
 * - Creates intentionally match the prior missing-deals import behavior by assigning reps when the owner display name
 *   resolves to a CRM user, while leaving company_id null instead of guessing through duplicate company-name matches.
 * - The authoritative CSV path defaults to /mnt/user-data/uploads/... with a fallback to the local Downloads copy
 *   used in this shell session.
 */

type Bucket =
  | "EXISTS_UNCHANGED"
  | "EXISTS_NEWER_IN_CSV"
  | "MISSING"
  | "AMBIGUOUS"
  | "SOFT_DELETED";

type SafeUpdateField =
  | "amount"
  | "deal_name"
  | "project_number"
  | "project_type"
  | "last_modified_at";

export interface ReimportArgs {
  dryRun: boolean;
  apply: boolean;
  confirmProduction: boolean;
  csvPath: string;
  tenant: string;
  reportPath: string;
  discoveryPath: string;
}

export interface CsvDealRow {
  hubspotRecordId: string;
  dealName: string;
  dealOwner: string | null;
  amount: string | null;
  createDate: string | null;
  lastModifiedDate: string | null;
  dealStage: string | null;
  pipeline: string | null;
  projectNumber: string | null;
  projectType: string | null;
  associatedCompany: string | null;
}

export interface ExistingDealRow {
  id: string;
  isActive: boolean;
  hubspotDealId: string | null;
  name: string;
  projectNumber: string | null;
  projectType: string | null;
  amount: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastSyncedFromHubspotAt: string | null;
}

export interface FieldDiff {
  field: SafeUpdateField;
  currentValue: string | null;
  csvValue: string | null;
}

export interface SkippedFieldClear {
  field: "amount" | "project_number" | "project_type";
  currentValue: string | null;
  csvValue: null;
}

export interface PlanEntry {
  bucket: Bucket;
  csvRow: CsvDealRow;
  crmDeal: ExistingDealRow | null;
  ambiguousMatches: ExistingDealRow[];
  fieldDiffs: FieldDiff[];
  skippedFieldClears: SkippedFieldClear[];
  invalidAmountRaw: string | null;
}

export interface InvalidAmountIssue {
  hubspotRecordId: string;
  bucket: "MISSING" | "EXISTS_NEWER_IN_CSV";
  rawValue: string;
}

export interface ReimportPlan {
  entries: PlanEntry[];
  counts: Record<Bucket, number>;
  ambiguousRate: number;
  shouldStopForAmbiguousRate: boolean;
  skippedFieldClearCount: number;
  invalidAmountIssues: InvalidAmountIssue[];
}

interface ReportSections {
  counts: string;
  samples: string;
  updateDiffs: string;
  risks: string;
}

const DEFAULT_TENANT = "office_dallas";
const DEFAULT_REPORT_PATH = ".reviews/hubspot-deals-reimport/dry-run-report.md";
const DEFAULT_DISCOVERY_PATH = ".reviews/hubspot-deals-reimport/discovery.md";
const DEFAULT_CSV_CANDIDATES = [
  "/mnt/user-data/uploads/hubspot-crm-exports-all-deals-2026-05-14-1.csv",
  "/Users/adnaaniqbal/Downloads/hubspot-crm-exports-all-deals-2026-05-14-1.csv",
];

const SAFE_UPDATE_FIELDS: SafeUpdateField[] = [
  "amount",
  "deal_name",
  "project_number",
  "project_type",
  "last_modified_at",
];

const DEAL_STAGE_MAPPING: Record<
  string,
  { workflowFamily: "standard_deal" | "service_deal"; slug: string }
> = {
  "pipe line": { workflowFamily: "standard_deal", slug: "opportunity" },
  rfp: { workflowFamily: "standard_deal", slug: "opportunity" },
  estimating: { workflowFamily: "standard_deal", slug: "estimating" },
  "internal review": { workflowFamily: "standard_deal", slug: "estimate_under_review" },
  "proposal sent": { workflowFamily: "standard_deal", slug: "estimate_sent_to_client" },
  "closed won": { workflowFamily: "standard_deal", slug: "won" },
  "closed lost": { workflowFamily: "standard_deal", slug: "lost" },
  "deal canceled": { workflowFamily: "standard_deal", slug: "lost" },
  "service - estimating": { workflowFamily: "service_deal", slug: "service_estimating" },
  "service - won": { workflowFamily: "service_deal", slug: "service_complete" },
  "service - lost": { workflowFamily: "service_deal", slug: "service_lost" },
};

function first(row: Record<string, string>, names: string[]) {
  for (const name of names) {
    const value = row[name];
    if (value != null && value.trim() !== "") return value.trim();
  }
  return "";
}

function formatIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

const STRICT_ISO_8601_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
];

const HUBSPOT_LOCAL_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;

function getAmericaChicagoOffsetMilliseconds(date: Date): number {
  const timeZonePart = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  if (!timeZonePart) throw new Error("Unable to resolve America/Chicago offset");
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(timeZonePart);
  if (!match) throw new Error(`Unexpected America/Chicago offset format: ${timeZonePart}`);
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes) * 60 * 1000;
}

function parseHubSpotLocalDate(text: string): Date | null {
  const match = HUBSPOT_LOCAL_DATETIME_PATTERN.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstPass = utcGuess - getAmericaChicagoOffsetMilliseconds(new Date(utcGuess));
  const secondPass = utcGuess - getAmericaChicagoOffsetMilliseconds(new Date(firstPass));
  const parsed = new Date(secondPass);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDate(value: string | null | undefined): Date | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (STRICT_ISO_8601_PATTERNS.some((pattern) => pattern.test(text))) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return parseHubSpotLocalDate(text);
}

function normalizeText(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function normalizeHubSpotProjectNumber(value: string | null | undefined, hubspotRecordId: string): string | null {
  try {
    return normalizeProjectNumberInput(value);
  } catch (error) {
    if (error instanceof ProjectNumberValidationError) {
      throw new Error(`Invalid Project Number for HubSpot record ${hubspotRecordId}: ${error.message}`);
    }
    throw error;
  }
}

function normalizeComparableText(value: string | null | undefined): string | null {
  const text = normalizeText(value);
  return text ? text.toLowerCase() : null;
}

function normalizeWritableProjectType(value: string | null | undefined): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  const normalized = normalizeProjectType(text);
  return isProjectTypeValue(normalized) ? normalized : null;
}

export function validateAmount(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Invalid numeric amount '${String(value)}'`);
    return value;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid amount type '${typeof value}'`);
  }
  const text = value.trim();
  if (!text) return null;
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) {
    throw new Error(`Invalid amount '${value}'`);
  }
  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid amount '${value}'`);
  }
  return numeric;
}

function normalizeAmount(value: unknown): string | null {
  try {
    const numeric = validateAmount(value);
    return numeric == null ? null : numeric.toFixed(2);
  } catch {
    return normalizeText(typeof value === "string" ? value : value == null ? null : String(value));
  }
}

function getInvalidAmountRawValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function assessCsvAmount(value: unknown): {
  normalized: string | null;
  invalidRaw: string | null;
} {
  try {
    const numeric = validateAmount(value);
    return {
      normalized: numeric == null ? null : numeric.toFixed(2),
      invalidRaw: null,
    };
  } catch {
    return {
      normalized: null,
      invalidRaw: getInvalidAmountRawValue(value),
    };
  }
}

function sameDayWithin24Hours(left: string | null, right: string | null): boolean {
  const leftDate = parseDate(left);
  const rightDate = parseDate(right);
  if (!leftDate || !rightDate) return false;
  return Math.abs(leftDate.getTime() - rightDate.getTime()) <= 24 * 60 * 60 * 1000;
}

function resolveCsvPath(explicitPath?: string | null): string {
  if (explicitPath) {
    if (fs.existsSync(explicitPath)) return explicitPath;
    throw new Error(`CSV not found at explicit path: ${explicitPath}`);
  }
  const candidates = DEFAULT_CSV_CANDIDATES;
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`CSV not found. Checked: ${candidates.join(", ")}`);
}

function quoteIdent(value: string): string {
  if (!/^office_[a-z0-9_]+$/.test(value)) throw new Error(`Invalid tenant schema: ${value}`);
  return `"${value.replace(/"/g, '""')}"`;
}

export function readEnvValueFromFile(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) return line.slice(line.indexOf("=") + 1).trim() || null;
  }
  return null;
}

function resolveDatabaseUrl(): string {
  const direct = process.env.DATABASE_URL?.trim() || process.env.DATABASE_PUBLIC_URL?.trim();
  if (direct) return direct;

  const worktreeRoot = process.cwd();
  const candidates = [
    path.join(worktreeRoot, ".env"),
    path.join(worktreeRoot, "server/.env.local"),
    path.join(worktreeRoot, "server/.env"),
    path.resolve(worktreeRoot, "../../.env"),
    path.resolve(worktreeRoot, "../../server/.env.local"),
    path.resolve(worktreeRoot, "../../server/.env"),
  ];
  for (const candidate of candidates) {
    const fromDatabaseUrl = readEnvValueFromFile(candidate, "DATABASE_URL");
    if (fromDatabaseUrl) return fromDatabaseUrl;
    const fromPublic = readEnvValueFromFile(candidate, "DATABASE_PUBLIC_URL");
    if (fromPublic) return fromPublic;
  }
  throw new Error("DATABASE_URL or DATABASE_PUBLIC_URL is required");
}

export function parseReimportArgs(argv: string[]): ReimportArgs {
  const args = argv.slice(2);
  const apply = args.includes("--apply");
  const explicitDryRun = args.includes("--dry-run");
  if (apply && explicitDryRun) {
    throw new Error("Cannot pass both --dry-run and --apply.");
  }
  const confirmProduction = args.includes("--confirm-production");
  const dryRun = !apply;
  if (apply && !confirmProduction) {
    throw new Error("--apply requires --confirm-production");
  }
  const csvPathArg = args.find((arg) => arg.startsWith("--csv="));
  const tenantArg = args.find((arg) => arg.startsWith("--tenant="));
  const reportArg = args.find((arg) => arg.startsWith("--report="));
  const discoveryArg = args.find((arg) => arg.startsWith("--discovery="));

  return {
    dryRun,
    apply,
    confirmProduction,
    csvPath: resolveCsvPath(csvPathArg?.split("=").slice(1).join("=")),
    tenant: tenantArg?.split("=").slice(1).join("=") || DEFAULT_TENANT,
    reportPath: reportArg?.split("=").slice(1).join("=") || DEFAULT_REPORT_PATH,
    discoveryPath: discoveryArg?.split("=").slice(1).join("=") || DEFAULT_DISCOVERY_PATH,
  };
}

export function parseHubSpotDealsCsv(text: string): CsvDealRow[] {
  return parseCsvText(text)
    .map((row) => {
      const hubspotRecordId = first(row, ["Record ID"]);
      if (!hubspotRecordId) return null;
      return {
        hubspotRecordId,
        dealName: first(row, ["Deal Name"]),
        dealOwner: normalizeText(first(row, ["Deal owner"])),
        amount: normalizeText(first(row, ["Amount"])),
        createDate: formatIso(parseDate(first(row, ["Create Date"]))),
        lastModifiedDate: formatIso(parseDate(first(row, ["Last Modified Date"]))),
        dealStage: normalizeText(first(row, ["Deal Stage"])),
        pipeline: normalizeText(first(row, ["Pipeline"])),
        projectNumber: normalizeHubSpotProjectNumber(first(row, ["Project Number"]), hubspotRecordId),
        projectType: normalizeText(first(row, ["Project Type"])),
        associatedCompany: normalizeText(first(row, ["Associated Company"])),
      };
    })
    .filter((row): row is CsvDealRow => Boolean(row));
}

function buildFieldDelta(
  csvRow: CsvDealRow,
  crmDeal: ExistingDealRow
): { fieldDiffs: FieldDiff[]; skippedFieldClears: SkippedFieldClear[] } {
  const diffs: FieldDiff[] = [];
  const skippedFieldClears: SkippedFieldClear[] = [];
  const crmAmount = normalizeAmount(crmDeal.amount);
  const csvAmountAssessment = assessCsvAmount(csvRow.amount);
  const csvAmount = csvAmountAssessment.normalized;
  if (csvAmountAssessment.invalidRaw != null) {
    // Invalid CSV amounts are surfaced separately and never treated as field clears.
  } else if (csvAmount == null && crmAmount != null) {
    skippedFieldClears.push({ field: "amount", currentValue: crmAmount, csvValue: null });
  } else if (csvAmount !== crmAmount) {
    diffs.push({ field: "amount", currentValue: crmAmount, csvValue: csvAmount });
  }
  if (normalizeText(csvRow.dealName) !== normalizeText(crmDeal.name)) {
    diffs.push({
      field: "deal_name",
      currentValue: normalizeText(crmDeal.name),
      csvValue: normalizeText(csvRow.dealName),
    });
  }
  const csvProjectNumber = normalizeText(csvRow.projectNumber);
  const crmProjectNumber = normalizeText(crmDeal.projectNumber);
  if (csvProjectNumber == null && crmProjectNumber != null) {
    skippedFieldClears.push({
      field: "project_number",
      currentValue: crmProjectNumber,
      csvValue: null,
    });
  } else if (csvProjectNumber !== crmProjectNumber) {
    diffs.push({
      field: "project_number",
      currentValue: crmProjectNumber,
      csvValue: csvProjectNumber,
    });
  }
  const rawCsvProjectType = normalizeText(csvRow.projectType);
  const csvProjectType = normalizeWritableProjectType(csvRow.projectType);
  const crmProjectType = normalizeText(crmDeal.projectType);
  if (rawCsvProjectType == null && crmProjectType != null) {
    skippedFieldClears.push({
      field: "project_type",
      currentValue: crmProjectType,
      csvValue: null,
    });
  } else if (rawCsvProjectType != null && csvProjectType !== null && csvProjectType !== crmProjectType) {
    diffs.push({
      field: "project_type",
      currentValue: crmProjectType,
      csvValue: csvProjectType,
    });
  }
  const csvLastModifiedIso = formatIso(parseDate(csvRow.lastModifiedDate));
  if (csvLastModifiedIso !== formatIso(parseDate(crmDeal.updatedAt))) {
    diffs.push({
      field: "last_modified_at",
      currentValue: formatIso(parseDate(crmDeal.updatedAt)),
      csvValue: csvLastModifiedIso,
    });
  }
  return {
    fieldDiffs: diffs.filter((diff) => SAFE_UPDATE_FIELDS.includes(diff.field)),
    skippedFieldClears,
  };
}

export function diffSafeUpdateFields(csvRow: CsvDealRow, crmDeal: ExistingDealRow): FieldDiff[] {
  return buildFieldDelta(csvRow, crmDeal).fieldDiffs;
}

export function buildReimportPlan(input: {
  csvRows: CsvDealRow[];
  crmDeals: ExistingDealRow[];
}): ReimportPlan {
  const counts: Record<Bucket, number> = {
    EXISTS_UNCHANGED: 0,
    EXISTS_NEWER_IN_CSV: 0,
    MISSING: 0,
    AMBIGUOUS: 0,
    SOFT_DELETED: 0,
  };
  let skippedFieldClearCount = 0;
  const invalidAmountIssues: InvalidAmountIssue[] = [];

  const duplicateActiveHubspotDealIds = findDuplicateActiveHubspotDealIds(input.crmDeals);
  if (duplicateActiveHubspotDealIds.length > 0) {
    throw new Error(
      `Duplicate active hubspot_deal_id values found: ${duplicateActiveHubspotDealIds
        .map(({ hubspotDealId, count }) => `${hubspotDealId} (${count})`)
        .join(", ")}`
    );
  }

  const byHubspotId = new Map<string, ExistingDealRow>();
  const softDeletedByHubspotId = new Map<string, ExistingDealRow>();
  for (const crmDeal of input.crmDeals) {
    if (!crmDeal.hubspotDealId) continue;
    if (crmDeal.isActive) byHubspotId.set(crmDeal.hubspotDealId, crmDeal);
    else softDeletedByHubspotId.set(crmDeal.hubspotDealId, crmDeal);
  }

  const entries: PlanEntry[] = input.csvRows.map((csvRow) => {
    const amountAssessment = assessCsvAmount(csvRow.amount);
    const activeMatch = byHubspotId.get(csvRow.hubspotRecordId) ?? null;
    const softDeletedMatch = softDeletedByHubspotId.get(csvRow.hubspotRecordId) ?? null;
    if (softDeletedMatch) {
      counts.SOFT_DELETED += 1;
      return {
        bucket: "SOFT_DELETED",
        csvRow,
        crmDeal: softDeletedMatch,
        ambiguousMatches: [],
        fieldDiffs: [],
        skippedFieldClears: [],
        invalidAmountRaw: null,
      };
    }
    if (activeMatch) {
      const csvModified = parseDate(csvRow.lastModifiedDate);
      const crmUpdated = parseDate(activeMatch.updatedAt);
      const bucket =
        csvModified && crmUpdated && csvModified.getTime() > crmUpdated.getTime()
          ? "EXISTS_NEWER_IN_CSV"
          : "EXISTS_UNCHANGED";
      const delta = bucket === "EXISTS_NEWER_IN_CSV" ? buildFieldDelta(csvRow, activeMatch) : null;
      skippedFieldClearCount += delta?.skippedFieldClears.length ?? 0;
      if (bucket === "EXISTS_NEWER_IN_CSV" && amountAssessment.invalidRaw != null) {
        invalidAmountIssues.push({
          hubspotRecordId: csvRow.hubspotRecordId,
          bucket,
          rawValue: amountAssessment.invalidRaw,
        });
      }
      counts[bucket] += 1;
      return {
        bucket,
        csvRow,
        crmDeal: activeMatch,
        ambiguousMatches: [],
        fieldDiffs: delta?.fieldDiffs ?? [],
        skippedFieldClears: delta?.skippedFieldClears ?? [],
        invalidAmountRaw: bucket === "EXISTS_NEWER_IN_CSV" ? amountAssessment.invalidRaw : null,
      };
    }

    const ambiguousMatches = input.crmDeals.filter(
      (crmDeal) =>
        normalizeComparableText(crmDeal.projectNumber) &&
        normalizeComparableText(crmDeal.projectNumber) === normalizeComparableText(csvRow.projectNumber) &&
        normalizeComparableText(crmDeal.name) === normalizeComparableText(csvRow.dealName) &&
        sameDayWithin24Hours(crmDeal.createdAt, csvRow.createDate)
    );
    if (ambiguousMatches.length > 0) {
      counts.AMBIGUOUS += 1;
      return {
        bucket: "AMBIGUOUS",
        csvRow,
        crmDeal: null,
        ambiguousMatches,
        fieldDiffs: [],
        skippedFieldClears: [],
        invalidAmountRaw: null,
      };
    }

    if (amountAssessment.invalidRaw != null) {
      invalidAmountIssues.push({
        hubspotRecordId: csvRow.hubspotRecordId,
        bucket: "MISSING",
        rawValue: amountAssessment.invalidRaw,
      });
    }
    counts.MISSING += 1;
    return {
      bucket: "MISSING",
      csvRow,
      crmDeal: null,
      ambiguousMatches: [],
      fieldDiffs: [],
      skippedFieldClears: [],
      invalidAmountRaw: amountAssessment.invalidRaw,
    };
  });

  const ambiguousRate = input.csvRows.length === 0 ? 0 : counts.AMBIGUOUS / input.csvRows.length;
  return {
    entries,
    counts,
    ambiguousRate,
    shouldStopForAmbiguousRate: ambiguousRate > 0.05,
    skippedFieldClearCount,
    invalidAmountIssues,
  };
}

function findDuplicateActiveHubspotDealIds(
  crmDeals: ExistingDealRow[]
): Array<{ hubspotDealId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const deal of crmDeals) {
    if (!deal.isActive || !deal.hubspotDealId) continue;
    counts.set(deal.hubspotDealId, (counts.get(deal.hubspotDealId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([hubspotDealId, count]) => ({ hubspotDealId, count }))
    .sort((left, right) => left.hubspotDealId.localeCompare(right.hubspotDealId));
}

interface ApplyResult {
  createdHubspotRecordIds: string[];
  updatedHubspotRecordIds: string[];
  skippedTimestampOnlyHubspotRecordIds: string[];
  skippedFieldClearHubspotRecordIds: string[];
  errors: Array<{ hubspotRecordId: string; message: string }>;
}

type AppliedDealRow = {
  id: string;
  name: string | null;
  project_number: string | null;
  deal_number: string | null;
};

function auditFieldKeyForHubSpotReimportField(field: SafeUpdateField): string | null {
  if (field === "amount") return "bidEstimate";
  if (field === "deal_name") return "name";
  if (field === "project_number") return "projectNumber";
  if (field === "project_type") return "projectType";
  return null;
}

function entityForAppliedDeal(row: AppliedDealRow) {
  return {
    tableName: "deals",
    entityType: "deal" as const,
    recordId: row.id,
    nameSnapshot: row.name ?? "Deal",
    secondaryIdSnapshot: row.project_number ?? row.deal_number ?? null,
  };
}

async function logHubSpotReimportActivity(
  client: pg.PoolClient,
  tenant: string,
  action: "insert" | "update",
  deal: AppliedDealRow,
  fieldChanges: Record<string, { from: unknown; to: unknown }>,
  metadata: Record<string, unknown>
) {
  if (Object.keys(fieldChanges).length === 0) return;
  await logActivityWithPgClient({
    client,
    schemaName: tenant,
    actor: buildAuditActorFromSystem({ systemProcess: HUBSPOT_REIMPORT }),
    action,
    entity: entityForAppliedDeal(deal),
    fieldChanges,
    metadata,
  });
}

async function fetchUserLookup(client: pg.PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM public.users WHERE is_active = true`
  );
  return new Map(
    rows.map((row) => [normalizeComparableText(row.display_name) ?? row.display_name.toLowerCase(), row.id])
  );
}

async function fetchStageLookup(client: pg.PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query<{ workflow_family: string; slug: string; id: string }>(
    `SELECT workflow_family, slug, id FROM public.pipeline_stage_config`
  );
  return new Map(rows.map((row) => [`${row.workflow_family}:${row.slug}`, row.id]));
}

function resolveCreateStage(row: CsvDealRow, stageLookup: Map<string, string>): string {
  const mapping = DEAL_STAGE_MAPPING[normalizeComparableText(row.dealStage) ?? ""];
  if (!mapping) throw new Error(`No create-stage mapping for HubSpot stage '${row.dealStage ?? "(blank)"}'`);
  const stageId = stageLookup.get(`${mapping.workflowFamily}:${mapping.slug}`);
  if (!stageId) throw new Error(`Missing CRM stage for ${mapping.workflowFamily}:${mapping.slug}`);
  return stageId;
}

async function nextDealNumber(
  client: pg.PoolClient,
  tenant: string,
  input: { officeCode: string; projectType: string | null; workflowRoute: "normal" | "service"; createdAt: Date }
): Promise<string> {
  const schema = quoteIdent(tenant);
  const julianDate = generateJulianDate(input.createdAt);
  const { rows } = await client.query<{ deal_number: string | null }>(
    `SELECT deal_number
       FROM ${schema}.deals
      WHERE deal_number LIKE $1
      ORDER BY deal_number DESC`,
    [`%-%-${julianDate}-%`]
  );
  const highestSuffix =
    rows
      .map((row) => parseProjectNumberSuffix(row.deal_number, julianDate))
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.localeCompare(left))[0] ?? null;
  await client.query(
    `INSERT INTO public.deal_number_daily_sequences (day_key, last_suffix)
     VALUES ($1, $2)
     ON CONFLICT (day_key) DO NOTHING`,
    [julianDate, highestSuffix ?? ""]
  );
  const sequenceResult = await client.query<{ last_suffix: string }>(
    `SELECT last_suffix
       FROM public.deal_number_daily_sequences
      WHERE day_key = $1
      FOR UPDATE`,
    [julianDate]
  );
  const nextSuffix = getNextSuffix(sequenceResult.rows[0]?.last_suffix || highestSuffix);
  await client.query(
    `UPDATE public.deal_number_daily_sequences
        SET last_suffix = $2,
            updated_at = NOW()
      WHERE day_key = $1`,
    [julianDate, nextSuffix]
  );
  return buildProjectNumber({
    officeCode: input.officeCode.toUpperCase(),
    projectTypeCode: resolveProjectTypeCode({
      projectType: input.projectType,
      workflowRoute: input.workflowRoute,
    }),
    createdAt: input.createdAt,
    suffix: nextSuffix,
  });
}

async function insertMissingDeal(
  client: pg.PoolClient,
  tenant: string,
  row: CsvDealRow,
  userLookup: Map<string, string>,
  stageLookup: Map<string, string>
): Promise<AppliedDealRow> {
  const schema = quoteIdent(tenant);
  const assignedRepId = row.dealOwner
    ? userLookup.get(normalizeComparableText(row.dealOwner) ?? "") ?? null
    : null;
  const stageId = resolveCreateStage(row, stageLookup);
  const createdAt = parseDate(row.createDate) ?? new Date();
  const workflowRoute = (normalizeComparableText(row.dealStage) ?? "").startsWith("service")
    ? "service"
    : "normal";
  const officeCode = resolveOfficeCode(row.projectNumber ?? "DFW");
  const writableProjectType = normalizeWritableProjectType(row.projectType);
  const dealNumber = await nextDealNumber(client, tenant, {
    officeCode,
    workflowRoute,
    projectType: writableProjectType,
    createdAt,
  });

  const insertResult = await client.query<AppliedDealRow>(
    `INSERT INTO ${schema}.deals (
      deal_number,
      name,
      stage_id,
      assigned_rep_id,
      bid_estimate,
      source,
      hubspot_deal_id,
      office_code,
      project_number,
      project_type,
      workflow_route,
      stage_entered_at,
      created_at,
      updated_at,
      is_active
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true
    )
    RETURNING id, name, project_number, deal_number`,
    [
      dealNumber,
      row.dealName || "Unnamed Deal",
      stageId,
      assignedRepId,
      validateAmount(row.amount),
      "hubspot_deals_reimport_2026_05_14",
      row.hubspotRecordId,
      officeCode,
      row.projectNumber,
      writableProjectType,
      workflowRoute,
      createdAt,
      createdAt,
      parseDate(row.lastModifiedDate) ?? createdAt,
    ]
  );
  const deal = insertResult.rows[0];
  await logHubSpotReimportActivity(client, tenant, "insert", deal, {
    name: { from: null, to: deal.name },
    stageId: { from: null, to: stageId },
    assignedRepId: { from: null, to: assignedRepId },
    bidEstimate: { from: null, to: validateAmount(row.amount) },
    source: { from: null, to: "hubspot_deals_reimport_2026_05_14" },
    hubspotDealId: { from: null, to: row.hubspotRecordId },
    projectNumber: { from: null, to: row.projectNumber },
    projectType: { from: null, to: writableProjectType },
    workflowRoute: { from: null, to: workflowRoute },
  }, { hubspotRecordId: row.hubspotRecordId });
  return deal;
}

async function updateExistingDeal(
  client: pg.PoolClient,
  tenant: string,
  entry: PlanEntry
): Promise<boolean> {
  if (!entry.crmDeal) throw new Error("Missing CRM deal for update");
  const actionableDiffs = entry.fieldDiffs.filter((diff) => diff.field !== "last_modified_at");
  if (actionableDiffs.length === 0) return false;
  const schema = quoteIdent(tenant);
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;
  for (const diff of actionableDiffs) {
    if (diff.field === "amount") {
      sets.push(`bid_estimate = $${index++}::numeric`);
      values.push(validateAmount(diff.csvValue));
    } else if (diff.field === "deal_name") {
      sets.push(`name = $${index++}`);
      values.push(diff.csvValue);
    } else if (diff.field === "project_number") {
      sets.push(`project_number = $${index++}`);
      values.push(diff.csvValue);
    } else if (diff.field === "project_type") {
      sets.push(`project_type = $${index++}`);
      values.push(diff.csvValue);
    }
  }
  sets.push(`updated_at = $${index++}::timestamptz`);
  values.push(entry.csvRow.lastModifiedDate);
  values.push(entry.crmDeal.id);
  const updateResult = await client.query<AppliedDealRow>(
    `UPDATE ${schema}.deals SET ${sets.join(", ")} WHERE id = $${index}
     RETURNING id, name, project_number, deal_number`,
    values
  );
  const deal = updateResult.rows[0] ?? {
    id: entry.crmDeal.id,
    name: entry.csvRow.dealName || entry.crmDeal.name,
    project_number: entry.csvRow.projectNumber ?? entry.crmDeal.projectNumber,
    deal_number: entry.crmDeal.projectNumber,
  };
  const auditFieldChanges: Record<string, { from: unknown; to: unknown }> = {};
  for (const diff of actionableDiffs) {
    const key = auditFieldKeyForHubSpotReimportField(diff.field);
    if (!key) continue;
    auditFieldChanges[key] = {
      from: diff.currentValue,
      to: diff.field === "amount" ? validateAmount(diff.csvValue) : diff.csvValue,
    };
  }
  await logHubSpotReimportActivity(client, tenant, "update", deal, auditFieldChanges, {
    hubspotRecordId: entry.csvRow.hubspotRecordId,
  });
  return true;
}

async function fetchExistingDeals(client: pg.PoolClient, tenant: string): Promise<ExistingDealRow[]> {
  const schema = quoteIdent(tenant);
  const { rows } = await client.query<{
    id: string;
    is_active: boolean;
    hubspot_deal_id: string | null;
    name: string;
    project_number: string | null;
    project_type: string | null;
    amount: string | null;
    created_at: Date | null;
    updated_at: Date | null;
    last_synced_from_hubspot_at: Date | null;
  }>(`
    SELECT
      id,
      is_active,
      hubspot_deal_id,
      name,
      project_number,
      project_type,
      COALESCE(awarded_amount::text, bid_estimate::text, dd_estimate::text) AS amount,
      created_at,
      updated_at,
      last_synced_from_hubspot_at
    FROM ${schema}.deals
  `);
  return rows.map((row) => ({
    id: row.id,
    isActive: row.is_active,
    hubspotDealId: normalizeText(row.hubspot_deal_id),
    name: row.name,
    projectNumber: normalizeText(row.project_number),
    projectType: normalizeText(row.project_type),
    amount: normalizeAmount(row.amount),
    createdAt: formatIso(row.created_at),
    updatedAt: formatIso(row.updated_at),
    lastSyncedFromHubspotAt: formatIso(row.last_synced_from_hubspot_at),
  }));
}

function bucketSample(entries: PlanEntry[], bucket: Bucket, limit: number): PlanEntry[] {
  return entries.filter((entry) => entry.bucket === bucket).slice(0, limit);
}

function renderSampleTable(entries: PlanEntry[]): string {
  if (entries.length === 0) return "_None_\n";
  const lines = [
    "| HubSpot Record ID | Deal Name | Project Number | Create Date | Stage |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const entry of entries) {
    lines.push(
      `| ${entry.csvRow.hubspotRecordId} | ${entry.csvRow.dealName || ""} | ${entry.csvRow.projectNumber || ""} | ${entry.csvRow.createDate || ""} | ${entry.csvRow.dealStage || ""} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderUpdateDiffTable(entries: PlanEntry[]): string {
  const rows = entries
    .filter((entry) => entry.bucket === "EXISTS_NEWER_IN_CSV")
    .flatMap((entry) =>
      entry.fieldDiffs.map((diff) => ({
        hubspotRecordId: entry.csvRow.hubspotRecordId,
        dealName: entry.csvRow.dealName,
        field: diff.field,
        currentValue: diff.currentValue ?? "",
        csvValue: diff.csvValue ?? "",
      }))
    )
    .slice(0, 100);
  if (rows.length === 0) return "_None_\n";
  const lines = [
    "| HubSpot Record ID | Deal Name | Field | CRM Value | CSV Value |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(`| ${row.hubspotRecordId} | ${row.dealName} | ${row.field} | ${row.currentValue} | ${row.csvValue} |`);
  }
  return `${lines.join("\n")}\n`;
}

function renderRiskAssessment(plan: ReimportPlan): string {
  const risks: string[] = [];
  if (plan.shouldStopForAmbiguousRate) {
    risks.push(
      `- Ambiguous match rate is ${(plan.ambiguousRate * 100).toFixed(2)}%, above the 5% hard stop threshold.`
    );
  }
  if (plan.counts.MISSING > 50) {
    risks.push("- Missing rows exceed 50, which suggests the HubSpot ID linkage may be broken.");
  }
  if (plan.counts.AMBIGUOUS > 50) {
    risks.push("- Ambiguous rows exceed 50, which suggests the initial import may not have preserved HubSpot IDs consistently.");
  }
  if (plan.counts.SOFT_DELETED > 0) {
    risks.push("- Soft-deleted HubSpot-linked deals exist and need human review before any restore/create action.");
  }
  if (plan.invalidAmountIssues.length > 0) {
    risks.push(
      `- Invalid CSV amounts detected for ${plan.invalidAmountIssues.length} row(s); apply will hard-stop until they are resolved.`
    );
  }
  if (risks.length === 0) {
    risks.push("- No hard-stop thresholds were triggered in this dry-run.");
  }
  risks.push("- Stage, assignment, and other workflow-owned fields are intentionally excluded from update application.");
  risks.push("- Bucket b update plans are limited to amount, deal_name, project_number, project_type, and last_modified_at.");
  return risks.join("\n");
}

function renderInvalidAmountTable(plan: ReimportPlan): string {
  if (plan.invalidAmountIssues.length === 0) return "_None_\n";
  const lines = [
    "| HubSpot Record ID | Bucket | Raw Amount |",
    "| --- | --- | --- |",
  ];
  for (const issue of plan.invalidAmountIssues.slice(0, 100)) {
    lines.push(`| ${issue.hubspotRecordId} | ${issue.bucket} | ${issue.rawValue} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderDryRunReport(plan: ReimportPlan, args: ReimportArgs): string {
  const sections: ReportSections = {
    counts: [
      `- EXISTS_UNCHANGED: ${plan.counts.EXISTS_UNCHANGED}`,
      `- EXISTS_NEWER_IN_CSV: ${plan.counts.EXISTS_NEWER_IN_CSV}`,
      `- MISSING: ${plan.counts.MISSING}`,
      `- AMBIGUOUS: ${plan.counts.AMBIGUOUS}`,
      `- SOFT_DELETED: ${plan.counts.SOFT_DELETED}`,
      `- Skipped field-clears (blank CSV vs non-null CRM): ${plan.skippedFieldClearCount}`,
      `- Invalid amount rows: ${plan.invalidAmountIssues.length}`,
      `- Ambiguous rate: ${(plan.ambiguousRate * 100).toFixed(2)}%`,
      `- Hard stop threshold breached: ${plan.shouldStopForAmbiguousRate ? "yes" : "no"}`,
    ].join("\n"),
    samples: [
      "## Sample Rows",
      "",
      "### EXISTS_UNCHANGED",
      renderSampleTable(bucketSample(plan.entries, "EXISTS_UNCHANGED", 10)),
      "### EXISTS_NEWER_IN_CSV",
      renderSampleTable(bucketSample(plan.entries, "EXISTS_NEWER_IN_CSV", 10)),
      "### MISSING",
      renderSampleTable(bucketSample(plan.entries, "MISSING", 10)),
      "### AMBIGUOUS",
      renderSampleTable(bucketSample(plan.entries, "AMBIGUOUS", 10)),
      "### SOFT_DELETED",
      renderSampleTable(bucketSample(plan.entries, "SOFT_DELETED", 10)),
    ].join("\n"),
    updateDiffs: renderUpdateDiffTable(plan.entries),
    risks: renderRiskAssessment(plan),
  };

  return `# HubSpot Deals Re-Import Dry Run

## Assumptions

- Dry-run only. No production writes were performed.
- Target tenant: \`${args.tenant}\`
- CSV path: \`${args.csvPath}\`
- Dedup key: \`hubspot_deal_id\`
- Secondary safety check for creates: same project number + same deal name + create date within 24h
- Safe update fields only: ${SAFE_UPDATE_FIELDS.join(", ")}

## Bucket Counts

${sections.counts}

${sections.samples}

## Update Field Diffs

${sections.updateDiffs}

## Invalid Amount Rows

${renderInvalidAmountTable(plan)}

## Risk Assessment

${sections.risks}
`;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function validatePlanBeforeApply(plan: ReimportPlan): void {
  if (plan.invalidAmountIssues.length === 0) return;
  throw new Error(
    `Refusing to apply because CSV amount validation failed for: ${plan.invalidAmountIssues
      .map((issue) => `${issue.hubspotRecordId} (${issue.bucket}, raw='${issue.rawValue}')`)
      .join(", ")}`
  );
}

export async function applyPlan(client: pg.PoolClient, tenant: string, plan: ReimportPlan): Promise<ApplyResult> {
  if (plan.shouldStopForAmbiguousRate) {
    throw new Error("Refusing to apply: ambiguous match rate exceeds 5%");
  }
  validatePlanBeforeApply(plan);
  const result: ApplyResult = {
    createdHubspotRecordIds: [],
    updatedHubspotRecordIds: [],
    skippedTimestampOnlyHubspotRecordIds: [],
    skippedFieldClearHubspotRecordIds: [],
    errors: [],
  };
  const userLookup = await fetchUserLookup(client);
  const stageLookup = await fetchStageLookup(client);
  await client.query("BEGIN");
  try {
    await applyProjectNumberEmailSkipSetting(client);
    for (const entry of plan.entries) {
      try {
        if (entry.skippedFieldClears.length > 0) {
          result.skippedFieldClearHubspotRecordIds.push(entry.csvRow.hubspotRecordId);
        }
        if (entry.bucket === "MISSING") {
          await insertMissingDeal(client, tenant, entry.csvRow, userLookup, stageLookup);
          result.createdHubspotRecordIds.push(entry.csvRow.hubspotRecordId);
          continue;
        }
        if (entry.bucket === "EXISTS_NEWER_IN_CSV") {
          const changed = await updateExistingDeal(client, tenant, entry);
          if (changed) result.updatedHubspotRecordIds.push(entry.csvRow.hubspotRecordId);
          else result.skippedTimestampOnlyHubspotRecordIds.push(entry.csvRow.hubspotRecordId);
        }
      } catch (error) {
        result.errors.push({
          hubspotRecordId: entry.csvRow.hubspotRecordId,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function run(): Promise<void> {
  const args = parseReimportArgs(process.argv);
  const csvText = fs.readFileSync(args.csvPath, "utf8");
  const csvRows = parseHubSpotDealsCsv(csvText);
  const pool = new pg.Pool({ connectionString: resolveDatabaseUrl() });

  try {
    const client = await pool.connect();
    try {
      const crmDeals = await fetchExistingDeals(client, args.tenant);
      const plan = buildReimportPlan({ csvRows, crmDeals });
      const report = renderDryRunReport(plan, args);
      ensureParentDir(args.reportPath);
      fs.writeFileSync(args.reportPath, report);

      console.log(`EXISTS_UNCHANGED: ${plan.counts.EXISTS_UNCHANGED} deals`);
      console.log(`EXISTS_NEWER_IN_CSV: ${plan.counts.EXISTS_NEWER_IN_CSV} deals`);
      console.log(`MISSING: ${plan.counts.MISSING} deals`);
      console.log(`AMBIGUOUS: ${plan.counts.AMBIGUOUS} deals`);
      console.log(`SOFT_DELETED: ${plan.counts.SOFT_DELETED} deals`);
      console.log(`SKIPPED_FIELD_CLEARS: ${plan.skippedFieldClearCount} fields`);
      console.log(`INVALID_AMOUNT_ROWS: ${plan.invalidAmountIssues.length}`);
      console.log(`Report: ${args.reportPath}`);

      if (args.apply) {
        const applyResult = await applyPlan(client, args.tenant, plan);
        console.log(
          JSON.stringify(
            {
              created: applyResult.createdHubspotRecordIds.length,
              updated: applyResult.updatedHubspotRecordIds.length,
              skippedTimestampOnly: applyResult.skippedTimestampOnlyHubspotRecordIds.length,
              skippedFieldClearDeals: [...new Set(applyResult.skippedFieldClearHubspotRecordIds)].length,
              errors: applyResult.errors,
            },
            null,
            2
          )
        );
      } else {
        console.log(
          "Dry-run complete. Awaiting human review of .reviews/hubspot-deals-reimport/dry-run-report.md before --apply."
        );
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
