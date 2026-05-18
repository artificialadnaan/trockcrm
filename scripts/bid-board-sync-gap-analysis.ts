import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { decrypt } from "../server/src/lib/encryption.js";

type SourceFilter = "all" | "hubspot" | "bidboard" | "portfolio";
type ReportMode = "dry-run" | "full-report";

export interface CliOptions {
  office: string | null;
  all: boolean;
  mode: ReportMode;
  source: SourceFilter;
  format: "json" | "text";
  maxSourceRecords: number;
  districtSearch: string;
}

export interface CrmDealDiagnosticRow {
  tenantSchema: string;
  id: string;
  name: string;
  dealNumber: string | null;
  projectNumber: string | null;
  hubspotDealId: string | null;
  procoreBidId: string | number | null;
  bidBoardProjectNumber: string | null;
  procoreProjectId: string | number | null;
  isActive: boolean;
}

export interface SourceRecord {
  id: string;
  name: string | null;
  projectNumber: string | null;
  active?: boolean | null;
  sourceSystem?: string;
  metadata?: Record<string, unknown>;
}

interface ReportInput {
  generatedAt: string;
  mode: ReportMode;
  scope: {
    tenantSchemas: string[];
    source: SourceFilter;
  };
  crmDeals: CrmDealDiagnosticRow[];
  hubspotDeals: SourceRecord[];
  bidBoardProjects: SourceRecord[];
  portfolioProjects: SourceRecord[];
  includeRows: boolean;
  districtSearch: string;
  sourceNotes?: string[];
  sourceStates?: SourceStates;
}

interface LikelyMatch {
  tenantSchema: string;
  dealId: string;
  name: string;
  matchReason: "stored_id" | "project_number" | "name";
}

interface SourceOnlyRow {
  sourceId: string;
  name: string | null;
  projectNumber: string | null;
  likelyCrmMatches: LikelyMatch[];
}

interface BrokenLinkRow {
  tenantSchema: string;
  dealId: string;
  name: string;
  field: "hubspotDealId" | "procoreBidId" | "bidBoardProjectNumber" | "procoreProjectId";
  storedValue: string | null;
  issue:
    | "stored_id_not_found_in_source"
    | "stored_id_not_in_partial_snapshot"
    | "missing_stored_id_for_likely_source_match";
  likelySourceMatches: SourceRecord[];
}

interface OrphanRow {
  tenantSchema: string;
  dealId: string;
  name: string;
  dealNumber: string | null;
}

interface Section<T> {
  count: number;
  rows?: T[];
}

export interface SourceFetchState {
  truncated: boolean;
  fetchedCount: number;
  maxRecords: number;
}

export interface SourceStates {
  hubspot: SourceFetchState;
  bidboard: SourceFetchState;
  portfolio: SourceFetchState;
}

interface SourceFetchResult {
  records: SourceRecord[];
  state: SourceFetchState;
}

export interface GapAnalysisReport {
  generatedAt: string;
  mode: ReportMode;
  readOnly: true;
  assumptions: string[];
  scope: ReportInput["scope"];
  sourceNotes: string[];
  sourceStates: SourceStates;
  partialSnapshotWarning: string | null;
  inventory: {
    byTenant: Record<string, ReturnType<typeof summarizeTenantDeals>>;
    allTenants: ReturnType<typeof summarizeTenantDeals>;
  };
  summary: {
    crmDeals: number;
    hubspotDeals: number;
    bidBoardProjects: number;
    portfolioProjects: number;
    hubspotMissingFromCrm: number;
    bidBoardMissingFromCrm: number;
    portfolioMissingFromCrm: number;
    crmBrokenHubspotLinks: number;
    crmBrokenBidBoardLinks: number;
    crmBrokenPortfolioLinks: number;
    crmOrphanedDeals: number;
    crmNotInAnyFetchedSource: number;
    districtAtPointonMatches: number;
  };
  sections: {
    hubspotMissingFromCrm: Section<SourceOnlyRow>;
    bidBoardMissingFromCrm: Section<SourceOnlyRow>;
    portfolioMissingFromCrm: Section<SourceOnlyRow>;
    crmMissingOrIncorrectSourceIds: Section<BrokenLinkRow>;
    crmOrphanedDeals: Section<OrphanRow>;
    crmNotInAnyFetchedSource: Section<OrphanRow>;
    districtAtPointon: Section<{
      crmMatches: CrmDealDiagnosticRow[];
      hubspotMatches: SourceRecord[];
      bidBoardMatches: SourceRecord[];
      portfolioMatches: SourceRecord[];
      diagnosis: string[];
    }>;
  };
}

function selectedSources(source: SourceFilter) {
  return {
    hubspot: source === "all" || source === "hubspot",
    bidboard: source === "all" || source === "bidboard",
    portfolio: source === "all" || source === "portfolio",
  };
}

function cleanText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function normalizeId(value: unknown): string | null {
  const text = cleanText(value);
  return text ? text.toLowerCase() : null;
}

function normalizeName(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function section<T>(rows: T[], includeRows: boolean): Section<T> {
  return includeRows ? { count: rows.length, rows } : { count: rows.length };
}

function first<T>(items: T[], limit = 25) {
  return items.slice(0, limit);
}

export function limitSourceRows<T extends SourceRecord>(rows: T[], maxRecords: number): T[] {
  if (!Number.isInteger(maxRecords) || maxRecords <= 0) {
    throw new Error("maxSourceRecords must be a positive integer");
  }
  return rows.slice(0, maxRecords);
}

function sourceIdSet(records: SourceRecord[]) {
  return new Set(records.map((record) => normalizeId(record.id)).filter((id): id is string => Boolean(id)));
}

function sourceProjectNumberSet(records: SourceRecord[]) {
  return new Set(records.map((record) => normalizeId(record.projectNumber)).filter((id): id is string => Boolean(id)));
}

interface SourceLookup {
  ids: Set<string>;
  projectNumbers: Set<string>;
}

export function buildSourceLookup(records: SourceRecord[]): SourceLookup {
  return {
    ids: sourceIdSet(records),
    projectNumbers: sourceProjectNumberSet(records),
  };
}

function buildCrmSourceIndex(crmDeals: CrmDealDiagnosticRow[]) {
  return {
    hubspotIds: new Set(crmDeals.map((deal) => normalizeId(deal.hubspotDealId)).filter((id): id is string => Boolean(id))),
    bidBoardIds: new Set(crmDeals.map((deal) => normalizeId(deal.procoreBidId)).filter((id): id is string => Boolean(id))),
    bidBoardProjectNumbers: new Set(crmDeals.map((deal) => normalizeId(deal.bidBoardProjectNumber)).filter((id): id is string => Boolean(id))),
    portfolioIds: new Set(crmDeals.map((deal) => normalizeId(deal.procoreProjectId)).filter((id): id is string => Boolean(id))),
  };
}

function likelyMatchesForSource(record: SourceRecord, crmDeals: CrmDealDiagnosticRow[], storedIdField?: keyof CrmDealDiagnosticRow): LikelyMatch[] {
  const sourceId = normalizeId(record.id);
  const sourceProjectNumber = normalizeId(record.projectNumber);
  const sourceName = normalizeName(record.name);
  const matches: LikelyMatch[] = [];

  for (const deal of crmDeals) {
    const storedId = storedIdField ? normalizeId(deal[storedIdField]) : null;
    if (sourceId && storedId && sourceId === storedId) {
      matches.push({ tenantSchema: deal.tenantSchema, dealId: deal.id, name: deal.name, matchReason: "stored_id" });
      continue;
    }

    const crmProjectNumbers = [
      deal.projectNumber,
      deal.dealNumber,
      deal.bidBoardProjectNumber,
    ].map(normalizeId);
    if (sourceProjectNumber && crmProjectNumbers.includes(sourceProjectNumber)) {
      matches.push({ tenantSchema: deal.tenantSchema, dealId: deal.id, name: deal.name, matchReason: "project_number" });
      continue;
    }

    if (sourceName && sourceName === normalizeName(deal.name)) {
      matches.push({ tenantSchema: deal.tenantSchema, dealId: deal.id, name: deal.name, matchReason: "name" });
    }
  }

  return matches.sort((left, right) => left.tenantSchema.localeCompare(right.tenantSchema) || left.dealId.localeCompare(right.dealId));
}

function sourceOnlyRows(
  records: SourceRecord[],
  crmDeals: CrmDealDiagnosticRow[],
  exactCrmIds: Set<string>,
  storedIdField?: keyof CrmDealDiagnosticRow,
  exactCrmProjectNumbers?: Set<string>
): SourceOnlyRow[] {
  const rows: SourceOnlyRow[] = [];
  for (const record of records) {
    const id = normalizeId(record.id);
    const projectNumber = normalizeId(record.projectNumber);
    const hasExactId = Boolean(id && exactCrmIds.has(id));
    const hasExactProjectNumber = Boolean(projectNumber && exactCrmProjectNumbers?.has(projectNumber));
    if (hasExactId || hasExactProjectNumber) continue;
    rows.push({
      sourceId: record.id,
      name: record.name,
      projectNumber: record.projectNumber,
      likelyCrmMatches: likelyMatchesForSource(record, crmDeals, storedIdField),
    });
  }
  return rows.sort((left, right) => (left.projectNumber ?? "").localeCompare(right.projectNumber ?? "") || (left.name ?? "").localeCompare(right.name ?? ""));
}

function matchingSourceRecords(deal: CrmDealDiagnosticRow, records: SourceRecord[]) {
  const crmProjectNumbers = [
    deal.projectNumber,
    deal.dealNumber,
    deal.bidBoardProjectNumber,
  ].map(normalizeId);
  const crmName = normalizeName(deal.name);

  return records.filter((record) => {
    const projectNumber = normalizeId(record.projectNumber);
    if (projectNumber && crmProjectNumbers.includes(projectNumber)) return true;
    const sourceName = normalizeName(record.name);
    return Boolean(sourceName && crmName && sourceName === crmName);
  });
}

function brokenIssueForSource(input: ReportInput, source: keyof SourceStates) {
  return input.sourceStates?.[source]?.truncated
    ? "stored_id_not_in_partial_snapshot" as const
    : "stored_id_not_found_in_source" as const;
}

function brokenLinkRows(input: ReportInput): BrokenLinkRow[] {
  const sources = selectedSources(input.scope.source);
  const rows: BrokenLinkRow[] = [];
  const hubspotIds = sourceIdSet(input.hubspotDeals);
  const bidBoardIds = sourceIdSet(input.bidBoardProjects);
  const bidBoardProjectNumbers = sourceProjectNumberSet(input.bidBoardProjects);
  const portfolioIds = sourceIdSet(input.portfolioProjects);

  for (const deal of input.crmDeals) {
    if (sources.hubspot) {
      const stored = normalizeId(deal.hubspotDealId);
      if (stored && !hubspotIds.has(stored)) {
        rows.push({
          tenantSchema: deal.tenantSchema,
          dealId: deal.id,
          name: deal.name,
          field: "hubspotDealId",
          storedValue: String(deal.hubspotDealId),
          issue: brokenIssueForSource(input, "hubspot"),
          likelySourceMatches: matchingSourceRecords(deal, input.hubspotDeals),
        });
      } else if (!stored) {
        const likely = matchingSourceRecords(deal, input.hubspotDeals);
        if (likely.length > 0) {
          rows.push({
            tenantSchema: deal.tenantSchema,
            dealId: deal.id,
            name: deal.name,
            field: "hubspotDealId",
            storedValue: null,
            issue: "missing_stored_id_for_likely_source_match",
            likelySourceMatches: likely,
          });
        }
      }
    }

    if (sources.bidboard) {
      const storedBidId = normalizeId(deal.procoreBidId);
      const storedProjectNumber = normalizeId(deal.bidBoardProjectNumber);
      if (storedBidId && !bidBoardIds.has(storedBidId)) {
        rows.push({
          tenantSchema: deal.tenantSchema,
          dealId: deal.id,
          name: deal.name,
          field: "procoreBidId",
          storedValue: String(deal.procoreBidId),
          issue: brokenIssueForSource(input, "bidboard"),
          likelySourceMatches: matchingSourceRecords(deal, input.bidBoardProjects),
        });
      }
      if (storedProjectNumber && !bidBoardProjectNumbers.has(storedProjectNumber)) {
        rows.push({
          tenantSchema: deal.tenantSchema,
          dealId: deal.id,
          name: deal.name,
          field: "bidBoardProjectNumber",
          storedValue: String(deal.bidBoardProjectNumber),
          issue: brokenIssueForSource(input, "bidboard"),
          likelySourceMatches: matchingSourceRecords(deal, input.bidBoardProjects),
        });
      }
      if (!storedBidId && !storedProjectNumber) {
        const likely = matchingSourceRecords(deal, input.bidBoardProjects);
        if (likely.length > 0) {
          rows.push({
            tenantSchema: deal.tenantSchema,
            dealId: deal.id,
            name: deal.name,
            field: "procoreBidId",
            storedValue: null,
            issue: "missing_stored_id_for_likely_source_match",
            likelySourceMatches: likely,
          });
        }
      }
    }

    if (sources.portfolio) {
      const stored = normalizeId(deal.procoreProjectId);
      if (stored && !portfolioIds.has(stored)) {
        rows.push({
          tenantSchema: deal.tenantSchema,
          dealId: deal.id,
          name: deal.name,
          field: "procoreProjectId",
          storedValue: String(deal.procoreProjectId),
          issue: brokenIssueForSource(input, "portfolio"),
          likelySourceMatches: matchingSourceRecords(deal, input.portfolioProjects),
        });
      } else if (!stored) {
        const likely = matchingSourceRecords(deal, input.portfolioProjects);
        if (likely.length > 0) {
          rows.push({
            tenantSchema: deal.tenantSchema,
            dealId: deal.id,
            name: deal.name,
            field: "procoreProjectId",
            storedValue: null,
            issue: "missing_stored_id_for_likely_source_match",
            likelySourceMatches: likely,
          });
        }
      }
    }
  }

  return rows.sort((left, right) => left.tenantSchema.localeCompare(right.tenantSchema) || left.name.localeCompare(right.name) || left.field.localeCompare(right.field));
}

function crmOrphanRows(crmDeals: CrmDealDiagnosticRow[]): OrphanRow[] {
  return crmDeals
    .filter((deal) => !normalizeId(deal.hubspotDealId) && !normalizeId(deal.procoreBidId) && !normalizeId(deal.bidBoardProjectNumber) && !normalizeId(deal.procoreProjectId))
    .map((deal) => ({
      tenantSchema: deal.tenantSchema,
      dealId: deal.id,
      name: deal.name,
      dealNumber: deal.dealNumber,
    }))
    .sort((left, right) => left.tenantSchema.localeCompare(right.tenantSchema) || left.name.localeCompare(right.name));
}

export function dealExistsInLookup(deal: CrmDealDiagnosticRow, lookup: SourceLookup, storedId: unknown) {
  const normalizedStoredId = normalizeId(storedId);
  if (normalizedStoredId && lookup.ids.has(normalizedStoredId)) return true;
  const crmProjectNumbers = [deal.projectNumber, deal.dealNumber, deal.bidBoardProjectNumber].map(normalizeId);
  if (crmProjectNumbers.some((projectNumber) => Boolean(projectNumber && lookup.projectNumbers.has(projectNumber)))) return true;
  return false;
}

function dealExistsInFetchedSource(deal: CrmDealDiagnosticRow, input: ReportInput, lookups: {
  hubspot: SourceLookup;
  bidboard: SourceLookup;
  portfolio: SourceLookup;
}) {
  const sources = selectedSources(input.scope.source);
  if (sources.hubspot) {
    if (dealExistsInLookup(deal, lookups.hubspot, deal.hubspotDealId)) return true;
  }
  if (sources.bidboard) {
    if (dealExistsInLookup(deal, lookups.bidboard, deal.procoreBidId)) return true;
  }
  if (sources.portfolio) {
    if (dealExistsInLookup(deal, lookups.portfolio, deal.procoreProjectId)) return true;
  }
  return false;
}

function crmNotInAnyFetchedSourceRows(input: ReportInput): OrphanRow[] {
  const lookups = {
    hubspot: buildSourceLookup(input.hubspotDeals),
    bidboard: buildSourceLookup(input.bidBoardProjects),
    portfolio: buildSourceLookup(input.portfolioProjects),
  };
  return input.crmDeals
    .filter((deal) => !dealExistsInFetchedSource(deal, input, lookups))
    .map((deal) => ({
      tenantSchema: deal.tenantSchema,
      dealId: deal.id,
      name: deal.name,
      dealNumber: deal.dealNumber,
    }))
    .sort((left, right) => left.tenantSchema.localeCompare(right.tenantSchema) || left.name.localeCompare(right.name));
}

function districtCaseStudy(input: ReportInput) {
  const needle = normalizeName(input.districtSearch);
  const includesNeedle = (value: unknown) => {
    const text = normalizeName(value);
    return Boolean(text && needle && text.includes(needle));
  };
  const crmMatches = input.crmDeals.filter((deal) =>
    includesNeedle(deal.name) ||
    includesNeedle(deal.dealNumber) ||
    includesNeedle(deal.projectNumber) ||
    includesNeedle(deal.bidBoardProjectNumber)
  );
  const crmDistrictIds = {
    hubspot: new Set(crmMatches.map((deal) => normalizeId(deal.hubspotDealId)).filter((id): id is string => Boolean(id))),
    bidBoardIds: new Set(crmMatches.map((deal) => normalizeId(deal.procoreBidId)).filter((id): id is string => Boolean(id))),
    bidBoardProjectNumbers: new Set(crmMatches.map((deal) => normalizeId(deal.bidBoardProjectNumber)).filter((id): id is string => Boolean(id))),
    portfolio: new Set(crmMatches.map((deal) => normalizeId(deal.procoreProjectId)).filter((id): id is string => Boolean(id))),
    projectNumbers: new Set(
      crmMatches
        .flatMap((deal) => [deal.projectNumber, deal.dealNumber, deal.bidBoardProjectNumber])
        .map(normalizeId)
        .filter((id): id is string => Boolean(id))
    ),
  };
  const hubspotMatches = input.hubspotDeals.filter((record) => {
    const id = normalizeId(record.id);
    const projectNumber = normalizeId(record.projectNumber);
    return includesNeedle(record.name) || includesNeedle(record.projectNumber) || Boolean(id && crmDistrictIds.hubspot.has(id)) || Boolean(projectNumber && crmDistrictIds.projectNumbers.has(projectNumber));
  });
  const bidBoardMatches = input.bidBoardProjects.filter((record) => {
    const id = normalizeId(record.id);
    const projectNumber = normalizeId(record.projectNumber);
    return includesNeedle(record.name) || includesNeedle(record.projectNumber) || Boolean(id && crmDistrictIds.bidBoardIds.has(id)) || Boolean(projectNumber && crmDistrictIds.bidBoardProjectNumbers.has(projectNumber));
  });
  const portfolioMatches = input.portfolioProjects.filter((record) => {
    const id = normalizeId(record.id);
    const projectNumber = normalizeId(record.projectNumber);
    return includesNeedle(record.name) || includesNeedle(record.projectNumber) || Boolean(id && crmDistrictIds.portfolio.has(id)) || Boolean(projectNumber && crmDistrictIds.projectNumbers.has(projectNumber));
  });
  const diagnosis: string[] = [];

  if (crmMatches.length === 0) diagnosis.push("No active CRM deal matched the District at Pointon search string.");
  for (const deal of crmMatches) {
    diagnosis.push(
      `${deal.tenantSchema}/${deal.id}: hubspotDealId=${deal.hubspotDealId ?? "null"}, procoreBidId=${deal.procoreBidId ?? "null"}, bidBoardProjectNumber=${deal.bidBoardProjectNumber ?? "null"}, procoreProjectId=${deal.procoreProjectId ?? "null"}`
    );
  }
  if (hubspotMatches.length === 0) diagnosis.push("No HubSpot source row matched the District at Pointon search string.");
  if (bidBoardMatches.length === 0) diagnosis.push("No Bid Board source row matched the District at Pointon search string.");
  if (portfolioMatches.length === 0) diagnosis.push("No Portfolio source row matched the District at Pointon search string.");

  return {
    crmMatches,
    hubspotMatches,
    bidBoardMatches,
    portfolioMatches,
    diagnosis,
  };
}

export function summarizeTenantDeals(deals: CrmDealDiagnosticRow[]) {
  return {
    total: deals.length,
    hubspotPopulated: deals.filter((deal) => normalizeId(deal.hubspotDealId)).length,
    hubspotNull: deals.filter((deal) => !normalizeId(deal.hubspotDealId)).length,
    bidBoardPopulated: deals.filter((deal) => normalizeId(deal.procoreBidId) || normalizeId(deal.bidBoardProjectNumber)).length,
    bidBoardNull: deals.filter((deal) => !normalizeId(deal.procoreBidId) && !normalizeId(deal.bidBoardProjectNumber)).length,
    portfolioPopulated: deals.filter((deal) => normalizeId(deal.procoreProjectId)).length,
    portfolioNull: deals.filter((deal) => !normalizeId(deal.procoreProjectId)).length,
    allThreeNull: crmOrphanRows(deals).length,
  };
}

export function buildGapAnalysisReport(input: ReportInput): GapAnalysisReport {
  const sources = selectedSources(input.scope.source);
  const crmIndex = buildCrmSourceIndex(input.crmDeals);
  const hubspotMissingFromCrm = sources.hubspot
    ? sourceOnlyRows(input.hubspotDeals, input.crmDeals, crmIndex.hubspotIds, "hubspotDealId")
    : [];
  const bidBoardMissingFromCrm = sources.bidboard
    ? sourceOnlyRows(input.bidBoardProjects, input.crmDeals, crmIndex.bidBoardIds, "procoreBidId", crmIndex.bidBoardProjectNumbers)
    : [];
  const portfolioMissingFromCrm = sources.portfolio
    ? sourceOnlyRows(input.portfolioProjects, input.crmDeals, crmIndex.portfolioIds, "procoreProjectId")
    : [];
  const brokenLinks = brokenLinkRows(input);
  const orphanRows = crmOrphanRows(input.crmDeals);
  const crmOnlyRows = crmNotInAnyFetchedSourceRows(input);
  const district = districtCaseStudy(input);
  const brokenHubspot = brokenLinks.filter((row) => row.field === "hubspotDealId");
  const brokenBidBoard = brokenLinks.filter((row) => row.field === "procoreBidId" || row.field === "bidBoardProjectNumber");
  const brokenPortfolio = brokenLinks.filter((row) => row.field === "procoreProjectId");
  const byTenant: Record<string, ReturnType<typeof summarizeTenantDeals>> = {};
  for (const tenant of input.scope.tenantSchemas) {
    byTenant[tenant] = summarizeTenantDeals(input.crmDeals.filter((deal) => deal.tenantSchema === tenant));
  }
  const defaultSourceStates: SourceStates = {
    hubspot: { truncated: false, fetchedCount: input.hubspotDeals.length, maxRecords: input.hubspotDeals.length },
    bidboard: { truncated: false, fetchedCount: input.bidBoardProjects.length, maxRecords: input.bidBoardProjects.length },
    portfolio: { truncated: false, fetchedCount: input.portfolioProjects.length, maxRecords: input.portfolioProjects.length },
  };
  const sourceStates = input.sourceStates ?? defaultSourceStates;
  const truncatedSources = Object.entries(sourceStates)
    .filter(([, state]) => state.truncated)
    .map(([source, state]) => `${source} fetched ${state.fetchedCount} at cap ${state.maxRecords}`);
  const partialSnapshotWarning = truncatedSources.length > 0
    ? `PARTIAL SNAPSHOT WARNING: ${truncatedSources.join("; ")}. Missing-source findings may be outside the fetched snapshot.`
    : null;

  return {
    generatedAt: input.generatedAt,
    mode: input.mode,
    readOnly: true,
    assumptions: [
      "CRM Bid Board ID is represented by deals.procore_bid_id; Bid Board project number is deals.bid_board_project_number.",
      "Source-only rows are exact-ID gaps first; likely CRM matches by project number or normalized name are included for human review only.",
      "The diagnostic does not write to CRM, HubSpot, Procore, SyncHub, job queues, or audit tables.",
    ],
    scope: input.scope,
    sourceNotes: input.sourceNotes ?? [],
    sourceStates,
    partialSnapshotWarning,
    inventory: {
      byTenant,
      allTenants: summarizeTenantDeals(input.crmDeals),
    },
    summary: {
      crmDeals: input.crmDeals.length,
      hubspotDeals: input.hubspotDeals.length,
      bidBoardProjects: input.bidBoardProjects.length,
      portfolioProjects: input.portfolioProjects.length,
      hubspotMissingFromCrm: hubspotMissingFromCrm.length,
      bidBoardMissingFromCrm: bidBoardMissingFromCrm.length,
      portfolioMissingFromCrm: portfolioMissingFromCrm.length,
      crmBrokenHubspotLinks: brokenHubspot.length,
      crmBrokenBidBoardLinks: brokenBidBoard.length,
      crmBrokenPortfolioLinks: brokenPortfolio.length,
      crmOrphanedDeals: orphanRows.length,
      crmNotInAnyFetchedSource: crmOnlyRows.length,
      districtAtPointonMatches:
        district.crmMatches.length + district.hubspotMatches.length + district.bidBoardMatches.length + district.portfolioMatches.length,
    },
    sections: {
      hubspotMissingFromCrm: section(hubspotMissingFromCrm, input.includeRows),
      bidBoardMissingFromCrm: section(bidBoardMissingFromCrm, input.includeRows),
      portfolioMissingFromCrm: section(portfolioMissingFromCrm, input.includeRows),
      crmMissingOrIncorrectSourceIds: section(brokenLinks, input.includeRows),
      crmOrphanedDeals: section(orphanRows, input.includeRows),
      crmNotInAnyFetchedSource: section(crmOnlyRows, input.includeRows),
      districtAtPointon: section([district], true),
    },
  };
}

export function parseCliArgs(argv: string[]): CliOptions {
  const envMaxSourceRecords = process.env.DIAGNOSTIC_MAX_SOURCE_RECORDS == null
    ? 10000
    : Number(process.env.DIAGNOSTIC_MAX_SOURCE_RECORDS);
  if (!Number.isInteger(envMaxSourceRecords) || envMaxSourceRecords <= 0) {
    throw new Error("DIAGNOSTIC_MAX_SOURCE_RECORDS must be a positive integer");
  }
  const options: CliOptions = {
    office: "office_dallas",
    all: false,
    mode: "dry-run",
    source: "all",
    format: "json",
    maxSourceRecords: envMaxSourceRecords,
    districtSearch: "District at Pointon",
  };

  for (const arg of argv) {
    if (arg === "--dry-run") options.mode = "dry-run";
    else if (arg === "--full-report") options.mode = "full-report";
    else if (arg === "--all") {
      options.all = true;
      options.office = null;
    } else if (arg.startsWith("--office=")) {
      options.office = arg.split("=").slice(1).join("=");
      options.all = false;
    } else if (arg.startsWith("--source=")) {
      const source = arg.split("=").slice(1).join("=") as SourceFilter;
      if (!["all", "hubspot", "bidboard", "portfolio"].includes(source)) {
        throw new Error("--source must be one of hubspot, bidboard, portfolio, all");
      }
      options.source = source;
    } else if (arg.startsWith("--format=")) {
      const format = arg.split("=").slice(1).join("=");
      if (format !== "json" && format !== "text") throw new Error("--format must be json or text");
      options.format = format;
    } else if (arg.startsWith("--max-source-records=")) {
      const parsed = Number(arg.split("=").slice(1).join("="));
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--max-source-records must be a positive integer");
      options.maxSourceRecords = parsed;
    } else if (arg.startsWith("--district-search=")) {
      options.districtSearch = arg.split("=").slice(1).join("=");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.all && !options.office) throw new Error("Use --office=office_dallas or --all");
  if (options.office && !/^office_[a-z][a-z0-9_]*$/.test(options.office)) {
    throw new Error("--office must be a safe tenant schema such as office_dallas");
  }

  return options;
}

export function resolveTenantSchemas(
  options: Pick<CliOptions, "all" | "office">,
  rows: Array<{ schema_name: string }>
) {
  if (!options.all) return [options.office ?? "office_dallas"];
  return rows
    .map((row) => row.schema_name)
    .filter((schemaName) => /^office_[a-z][a-z0-9_]*$/.test(schemaName))
    .sort();
}

function connectionString() {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  return selected;
}

async function loadTenantSchemas(client: pg.Client, options: CliOptions) {
  if (!options.all) return [options.office ?? "office_dallas"];
  const result = await client.query<{ schema_name: string }>(
    `SELECT schema_name
       FROM information_schema.schemata
      WHERE schema_name LIKE 'office\\_%' ESCAPE '\\'
      ORDER BY schema_name`
  );
  return resolveTenantSchemas(options, result.rows);
}

async function loadCrmDeals(client: pg.Client, tenantSchemas: string[]): Promise<CrmDealDiagnosticRow[]> {
  const rows: CrmDealDiagnosticRow[] = [];
  for (const tenantSchema of tenantSchemas) {
    const result = await client.query<{
      id: string;
      name: string;
      deal_number: string | null;
      project_number: string | null;
      hubspot_deal_id: string | null;
      procore_bid_id: string | null;
      bid_board_project_number: string | null;
      procore_project_id: string | null;
      is_active: boolean;
    }>(
      `SELECT id::text,
              name,
              deal_number,
              project_number,
              hubspot_deal_id,
              procore_bid_id::text,
              bid_board_project_number,
              procore_project_id::text,
              is_active
         FROM ${tenantSchema}.deals
        WHERE COALESCE(is_active, true) = true
        ORDER BY name ASC, id ASC`
    );
    rows.push(
      ...result.rows.map((row) => ({
        tenantSchema,
        id: row.id,
        name: row.name,
        dealNumber: row.deal_number,
        projectNumber: row.project_number,
        hubspotDealId: row.hubspot_deal_id,
        procoreBidId: row.procore_bid_id,
        bidBoardProjectNumber: row.bid_board_project_number,
        procoreProjectId: row.procore_project_id,
        isActive: row.is_active,
      }))
    );
  }
  return rows;
}

interface HubSpotFetchOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

async function hubspotFetch<T>(path: string, options: HubSpotFetchOptions = {}): Promise<T> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) throw new Error("HUBSPOT_PRIVATE_APP_TOKEN is required for HubSpot source diagnostics");
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetchImpl(`https://api.hubapi.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (response.ok) return response.json() as Promise<T>;
    const body = await response.text().catch(() => "");
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxAttempts - 1) {
      throw new Error(`HubSpot read failed: ${response.status} ${body}`);
    }
    const retryAfterSeconds = Number(response.headers.get("Retry-After") ?? "");
    const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? retryAfterSeconds * 1000
      : [1000, 3000][attempt] ?? 3000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`HubSpot read failed after ${maxAttempts} attempts`);
}

export async function fetchHubSpotDeals(maxRecords: number, options: HubSpotFetchOptions = {}): Promise<SourceFetchResult> {
  const properties = [
    "dealname",
    "dealstage",
    "project_number",
    "createdate",
    "hs_lastmodifieddate",
  ].join(",");
  const rows: SourceRecord[] = [];
  let after: string | undefined;
  do {
    const params = new URLSearchParams({ properties, limit: "100" });
    if (after) params.set("after", after);
    const page = await hubspotFetch<{
      results?: Array<{ id: string; properties?: Record<string, string | null> }>;
      paging?: { next?: { after?: string } };
    }>(`/crm/v3/objects/deals?${params}`, options);
    const pageRows = page.results ?? [];
    for (const row of pageRows) {
      rows.push({
        id: row.id,
        name: row.properties?.dealname ?? null,
        projectNumber: row.properties?.project_number ?? null,
        sourceSystem: "hubspot",
        metadata: {
          dealstage: row.properties?.dealstage ?? null,
          createdate: row.properties?.createdate ?? null,
          hsLastModifiedDate: row.properties?.hs_lastmodifieddate ?? null,
        },
      });
      if (rows.length >= maxRecords) {
        return {
          records: rows,
          state: { truncated: Boolean(page.paging?.next?.after) || pageRows.indexOf(row) < pageRows.length - 1, fetchedCount: rows.length, maxRecords },
        };
      }
    }
    after = page.paging?.next?.after;
  } while (after);
  return { records: rows, state: { truncated: false, fetchedCount: rows.length, maxRecords } };
}

async function fetchBidBoardFromExport(path: string, maxRecords: number): Promise<SourceFetchResult> {
  const raw = await fs.readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { rows?: unknown[] }).rows)
      ? (parsed as { rows: unknown[] }).rows
      : [];
  const records = rows.map((row, index) => {
    const record = row as Record<string, unknown>;
    const id = cleanText(record["BidBoard Project ID"]) ?? cleanText(record["Bid Board Project ID"]) ?? cleanText(record["Project ID"]) ?? cleanText(record.bidboardProjectId) ?? `export-row-${index + 1}`;
    return {
      id,
      name: cleanText(record.Name),
      projectNumber: cleanText(record["Project #"]),
      sourceSystem: "bidboard_export",
      metadata: { status: cleanText(record.Status), estimator: cleanText(record.Estimator) },
    };
  });
  return {
    records: limitSourceRows(records, maxRecords),
    state: { truncated: records.length > maxRecords, fetchedCount: Math.min(records.length, maxRecords), maxRecords },
  };
}

export interface SyncHubMappingRow {
  id: string;
  hubspot_deal_id: string | null;
  procore_project_number: string | null;
  bidboard_project_id: string | null;
  created_at: string | null;
}

function syncHubDedupKey(row: SyncHubMappingRow) {
  return `${normalizeId(row.bidboard_project_id) ?? ""}|${normalizeId(row.procore_project_number) ?? ""}`;
}

function syncHubLatestFirst(left: SyncHubMappingRow, right: SyncHubMappingRow) {
  const leftTime = Date.parse(left.created_at ?? "");
  const rightTime = Date.parse(right.created_at ?? "");
  const timeDelta = (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  if (timeDelta !== 0) return timeDelta;
  return Number(right.id) - Number(left.id);
}

export function dedupeSyncHubMappingRows(rows: SyncHubMappingRow[]): SyncHubMappingRow[] {
  const byKey = new Map<string, SyncHubMappingRow[]>();
  for (const row of rows) {
    const key = syncHubDedupKey(row);
    if (key === "|") continue;
    const group = byKey.get(key) ?? [];
    group.push(row);
    byKey.set(key, group);
  }
  return [...byKey.values()]
    .map((group) => [...group].sort(syncHubLatestFirst)[0]!)
    .sort(syncHubLatestFirst);
}

async function fetchBidBoardFromSyncHub(maxRecords: number): Promise<SourceFetchResult> {
  const syncHubUrl = process.env.SYNCHUB_DATABASE_URL;
  if (!syncHubUrl) throw new Error("SYNCHUB_DATABASE_URL or BID_BOARD_EXPORT_PATH is required for Bid Board source diagnostics");
  const client = new pg.Client({ connectionString: syncHubUrl });
  try {
    await client.connect();
    const queryLimit = maxRecords * 5;
    const result = await client.query<SyncHubMappingRow>(
      `SELECT id::text,
              hubspot_deal_id,
              procore_project_number,
              bidboard_project_id,
              created_at::text
         FROM sync_mappings
        WHERE (bidboard_project_id IS NOT NULL AND btrim(bidboard_project_id) <> '')
           OR (procore_project_number IS NOT NULL AND btrim(procore_project_number) <> '')
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT $1`,
      [queryLimit]
    );
    const deduped = dedupeSyncHubMappingRows(result.rows);
    const records = deduped.slice(0, maxRecords).map((row) => ({
      id: cleanText(row.bidboard_project_id) ?? `sync_mapping:${row.id}`,
      name: null,
      projectNumber: cleanText(row.procore_project_number),
      sourceSystem: "synchub.sync_mappings",
      metadata: {
        syncMappingId: row.id,
        hubspotDealId: row.hubspot_deal_id,
        createdAt: row.created_at,
      },
    }));
    return {
      records,
      state: { truncated: deduped.length > maxRecords || result.rows.length === queryLimit, fetchedCount: records.length, maxRecords },
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function fetchBidBoardProjects(maxRecords: number): Promise<SourceFetchResult> {
  const exportPath = process.env.BID_BOARD_EXPORT_PATH?.trim();
  if (exportPath) return fetchBidBoardFromExport(exportPath, maxRecords);
  return fetchBidBoardFromSyncHub(maxRecords);
}

interface ProcoreTokenRow {
  access_token: string | null;
  token_expires_at: Date | string | null;
  status: string | null;
}

interface TokenClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: ProcoreTokenRow[] }>;
}

interface PortfolioFetchOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  tokenClient?: TokenClient;
  fetchImpl?: typeof fetch;
  decryptToken?: (value: string) => string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

async function resolveReadOnlyProcoreToken(options: PortfolioFetchOptions = {}) {
  const env = options.env ?? process.env;
  const companyId = env.PROCORE_COMPANY_ID?.trim();
  if (!companyId) throw new Error("PROCORE_COMPANY_ID is required for Portfolio source diagnostics");

  const client = options.tokenClient ?? new pg.Client({ connectionString: connectionString() });
  const ownsClient = !options.tokenClient;
  try {
    if (ownsClient && "connect" in client && typeof client.connect === "function") {
      await client.connect();
    }
    const result = await client.query(
      `SELECT access_token, token_expires_at, status
         FROM public.procore_oauth_tokens
        WHERE singleton_key = $1
        LIMIT 1`,
      [1]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Procore OAuth token not found. Connect Procore via the normal CRM flow before running this diagnostic.");
    if (row.status !== "active") throw new Error("Procore OAuth token is not active. Reconnect Procore via the normal CRM flow before running this diagnostic.");
    if (!row.access_token) throw new Error("Procore OAuth token is empty. Reconnect Procore via the normal CRM flow before running this diagnostic.");
    const expiresAt = row.token_expires_at instanceof Date ? row.token_expires_at : new Date(String(row.token_expires_at));
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= (options.now?.() ?? new Date()).getTime()) {
      throw new Error("Procore token expired. Refresh manually via the normal CRM flow before running this diagnostic.");
    }
    return {
      companyId,
      accessToken: (options.decryptToken ?? decrypt)(row.access_token),
    };
  } finally {
    if (ownsClient && "end" in client && typeof client.end === "function") {
      await client.end().catch(() => {});
    }
  }
}

type PortfolioApiProject = {
  id: number;
  name?: string | null;
  display_name?: string | null;
  displayName?: string | null;
  project_number?: string | null;
  projectNumber?: string | null;
  city?: string | null;
  state_code?: string | null;
  stateCode?: string | null;
  address?: string | { street?: string | null; city?: string | null; state_code?: string | null; stateCode?: string | null } | null;
  updated_at?: string | null;
  updatedAt?: string | null;
};

type PortfolioApiPage = PortfolioApiProject[] | {
  data?: PortfolioApiProject[];
  projects?: PortfolioApiProject[];
  results?: PortfolioApiProject[];
  next_page_url?: string | null;
  nextPageUrl?: string | null;
  next_page?: string | number | null;
  nextPage?: string | number | null;
  total_count?: number | null;
  totalCount?: number | null;
  total?: number | null;
  pagination?: {
    next_page_url?: string | null;
    nextPageUrl?: string | null;
    next_page?: string | number | null;
    nextPage?: string | number | null;
    total_count?: number | null;
    totalCount?: number | null;
    total?: number | null;
  };
  meta?: {
    pagination?: {
      next_page_url?: string | null;
      nextPageUrl?: string | null;
      next_page?: string | number | null;
      nextPage?: string | number | null;
      total_count?: number | null;
      totalCount?: number | null;
      total?: number | null;
    };
  };
};

function portfolioRowsFromPage(page: PortfolioApiPage): PortfolioApiProject[] {
  if (Array.isArray(page)) return page;
  return page.data ?? page.projects ?? page.results ?? [];
}

function numericPageField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function portfolioTotalFromPage(page: PortfolioApiPage): number | null {
  if (Array.isArray(page)) return null;
  return numericPageField(
    page.total_count ??
    page.totalCount ??
    page.total ??
    page.pagination?.total_count ??
    page.pagination?.totalCount ??
    page.pagination?.total ??
    page.meta?.pagination?.total_count ??
    page.meta?.pagination?.totalCount ??
    page.meta?.pagination?.total
  );
}

function portfolioPageHasNext(response: Response, page: PortfolioApiPage, fetchedAfterPage: number): boolean {
  const headers = response.headers;
  const link = headers?.get("Link") ?? headers?.get("link") ?? "";
  if (/<[^>]+>;\s*rel="?next"?/i.test(link) || /rel="?next"?/i.test(link)) return true;

  const nextHeader = headers?.get("X-Next-Page") ?? headers?.get("x-next-page");
  if (cleanText(nextHeader)) return true;

  if (!Array.isArray(page)) {
    const nextField =
      page.next_page_url ??
      page.nextPageUrl ??
      page.next_page ??
      page.nextPage ??
      page.pagination?.next_page_url ??
      page.pagination?.nextPageUrl ??
      page.pagination?.next_page ??
      page.pagination?.nextPage ??
      page.meta?.pagination?.next_page_url ??
      page.meta?.pagination?.nextPageUrl ??
      page.meta?.pagination?.next_page ??
      page.meta?.pagination?.nextPage;
    if (cleanText(nextField)) return true;
  }

  const total = portfolioTotalFromPage(page);
  return total != null && total > fetchedAfterPage;
}

function retryDelayFromResponse(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }
  return [1000, 2000, 4000][attempt] ?? 4000;
}

function isRetryableProcoreStatus(status: number) {
  return status === 429 || status >= 500;
}

async function readProcorePortfolioPage(
  url: string,
  init: RequestInit,
  options: PortfolioFetchOptions
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = 3;
  let lastFailure = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchImpl(url, init);
      if (response.ok) return response;

      const text = await response.text().catch(() => "");
      lastFailure = `${response.status} ${text}`.trim();
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Procore token invalid or expired: ${lastFailure}`);
      }
      if (!isRetryableProcoreStatus(response.status)) {
        throw new Error(`Procore read-only portfolio fetch failed: ${lastFailure}`);
      }
      if (attempt === maxRetries) {
        throw new Error(`Procore read-only portfolio fetch failed after ${maxRetries + 1} attempts: ${lastFailure}`);
      }

      const delayMs = retryDelayFromResponse(response, attempt);
      console.warn(`[Procore diagnostic] read-only portfolio fetch ${response.status}; retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(delayMs);
    } catch (error) {
      if (error instanceof Error && (
        error.message.startsWith("Procore token invalid or expired:") ||
        error.message.startsWith("Procore read-only portfolio fetch failed:")
      )) {
        throw error;
      }

      lastFailure = error instanceof Error ? `network error: ${error.message}` : `network error: ${String(error)}`;
      if (attempt === maxRetries) {
        throw new Error(`Procore read-only portfolio fetch failed after ${maxRetries + 1} attempts: ${lastFailure}`);
      }
      const delayMs = [1000, 2000, 4000][attempt] ?? 4000;
      console.warn(`[Procore diagnostic] read-only portfolio fetch network error; retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries}): ${lastFailure}`);
      await sleep(delayMs);
    }
  }

  throw new Error(`Procore read-only portfolio fetch failed after ${maxRetries + 1} attempts: ${lastFailure}`);
}

export async function fetchPortfolioProjects(maxRecords: number, options: PortfolioFetchOptions = {}): Promise<SourceFetchResult> {
  const auth = await resolveReadOnlyProcoreToken(options);
  const rows: SourceRecord[] = [];
  let page = 1;
  const pageSize = 100;
  let truncated = false;
  while (rows.length < maxRecords) {
    const response = await readProcorePortfolioPage(`https://api.procore.com/rest/v1.0/companies/${auth.companyId}/projects?page=${page}&per_page=${pageSize}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: "application/json",
        "Procore-Company-Id": auth.companyId,
      },
    }, options);
    const parsedPage = await response.json() as PortfolioApiPage;
    const pageRows = portfolioRowsFromPage(parsedPage);
    if (pageRows.length === 0) break;
    const remainingCapacity = maxRecords - rows.length;
    const fetchedAfterPage = rows.length + pageRows.length;
    const hasNextPage = portfolioPageHasNext(response, parsedPage, fetchedAfterPage);
    if (pageRows.length > remainingCapacity || (pageRows.length === remainingCapacity && hasNextPage)) truncated = true;
    rows.push(
      ...pageRows.slice(0, remainingCapacity).map((row) => ({
        id: String(row.id),
        name: row.display_name ?? row.displayName ?? row.name ?? `Project ${row.id}`,
        projectNumber: row.project_number ?? row.projectNumber ?? null,
        active: true,
        sourceSystem: "procore_portfolio",
        metadata: {
          city: row.city ?? (typeof row.address === "object" ? row.address?.city ?? null : null),
          state: row.state_code ?? row.stateCode ?? (typeof row.address === "object" ? row.address?.state_code ?? row.address?.stateCode ?? null : null),
          address: typeof row.address === "string" ? row.address : row.address?.street ?? null,
          updatedAt: row.updated_at ?? row.updatedAt ?? null,
        },
      }))
    );
    if (!hasNextPage && pageRows.length < pageSize) break;
    if (rows.length >= maxRecords) break;
    page += 1;
  }
  return {
    records: rows.slice(0, maxRecords),
    state: { truncated, fetchedCount: Math.min(rows.length, maxRecords), maxRecords },
  };
}

export function renderTextReport(report: GapAnalysisReport): string {
  const lines: string[] = [];
  lines.push("Bid Board Sync Gap Analysis");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Tenants: ${report.scope.tenantSchemas.join(", ")}`);
  lines.push(`Source: ${report.scope.source}`);
  lines.push("");
  if (report.partialSnapshotWarning) {
    lines.push(report.partialSnapshotWarning);
    lines.push("");
  }
  lines.push("Assumptions");
  for (const assumption of report.assumptions) lines.push(`- ${assumption}`);
  lines.push("");
  lines.push("Source Notes");
  if (report.sourceNotes.length === 0) lines.push("- (none)");
  for (const note of report.sourceNotes) lines.push(`- ${note}`);
  lines.push("");
  lines.push("Summary");
  for (const [key, value] of Object.entries(report.summary)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push("");
  lines.push("Inventory by tenant");
  for (const [tenant, inventory] of Object.entries(report.inventory.byTenant)) {
    lines.push(`- ${tenant}: ${JSON.stringify(inventory)}`);
  }
  lines.push("");
  for (const [name, sectionValue] of Object.entries(report.sections)) {
    lines.push(`${name}: ${sectionValue.count}`);
    const rows = "rows" in sectionValue ? sectionValue.rows : undefined;
    if (Array.isArray(rows) && rows.length > 0 && name !== "districtAtPointon") {
      lines.push(JSON.stringify(first(rows as unknown[]), null, 2));
    }
  }
  lines.push("");
  lines.push("District at Pointon");
  lines.push(JSON.stringify(report.sections.districtAtPointon.rows?.[0] ?? {}, null, 2));
  return lines.join("\n");
}

function printText(report: GapAnalysisReport) {
  console.log(renderTextReport(report));
}

export async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const sources = selectedSources(options.source);
  const client = new pg.Client({ connectionString: connectionString() });
  const sourceNotes: string[] = [];

  try {
    await client.connect();
    const tenantSchemas = await loadTenantSchemas(client, options);
    const crmDeals = await loadCrmDeals(client, tenantSchemas);
    const [hubspotResult, bidBoardResult, portfolioResult] = await Promise.all([
      sources.hubspot ? fetchHubSpotDeals(options.maxSourceRecords) : Promise.resolve([]),
      sources.bidboard ? fetchBidBoardProjects(options.maxSourceRecords) : Promise.resolve([]),
      sources.portfolio ? fetchPortfolioProjects(options.maxSourceRecords) : Promise.resolve([]),
    ]);
    const hubspotDeals = Array.isArray(hubspotResult) ? hubspotResult : hubspotResult.records;
    const bidBoardProjects = Array.isArray(bidBoardResult) ? bidBoardResult : bidBoardResult.records;
    const portfolioProjects = Array.isArray(portfolioResult) ? portfolioResult : portfolioResult.records;
    const sourceStates: SourceStates = {
      hubspot: Array.isArray(hubspotResult) ? { truncated: false, fetchedCount: 0, maxRecords: options.maxSourceRecords } : hubspotResult.state,
      bidboard: Array.isArray(bidBoardResult) ? { truncated: false, fetchedCount: 0, maxRecords: options.maxSourceRecords } : bidBoardResult.state,
      portfolio: Array.isArray(portfolioResult) ? { truncated: false, fetchedCount: 0, maxRecords: options.maxSourceRecords } : portfolioResult.state,
    };

    if (sources.bidboard && !process.env.BID_BOARD_EXPORT_PATH) {
      sourceNotes.push("Bid Board source rows came from SyncHub sync_mappings because no BID_BOARD_EXPORT_PATH was provided.");
    }

    const report = buildGapAnalysisReport({
      generatedAt: new Date().toISOString(),
      mode: options.mode,
      scope: { tenantSchemas, source: options.source },
      crmDeals,
      hubspotDeals,
      bidBoardProjects,
      portfolioProjects,
      includeRows: options.mode === "full-report",
      districtSearch: options.districtSearch,
      sourceNotes,
      sourceStates,
    });

    if (options.format === "text") printText(report);
    else console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error("FAIL:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
