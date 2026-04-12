import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { listCompanyProjectCandidatesPage } from "../../lib/procore-client.js";
import { normalizeProcoreReconciliationRow } from "./reconciliation-service.js";
import type {
  CrmDealCandidate,
  ProcoreProjectCandidate,
} from "./reconciliation-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

type ValidationStatus = "matched" | "ambiguous" | "unmatched";
type ValidationMatchReason =
  | "procore_project_id"
  | "duplicate_procore_project_id"
  | "project_number"
  | "duplicate_project_number"
  | "name_location"
  | "name_location_tie"
  | "none";

export interface ProjectValidationRow {
  project: ProcoreProjectCandidate;
  deal: CrmDealCandidate | null;
  status: ValidationStatus;
  matchReason: ValidationMatchReason;
}

export async function listProjectValidation(args: {
  companyId: string;
  pageSize: number;
  maxProjects: number;
  now?: () => Date;
  listProjectsPage?: (
    companyId: string,
    page: number,
    pageSize: number
  ) => Promise<ProcoreProjectCandidate[]>;
  listActiveDeals: () => Promise<CrmDealCandidate[]>;
}) {
  const listPage =
    args.listProjectsPage ??
    ((companyId: string, page: number, pageSize: number) =>
      listCompanyProjectCandidatesPage(companyId, page, pageSize));

  const projects: ProcoreProjectCandidate[] = [];
  let page = 1;
  let truncated = false;

  while (true) {
    const rows = await listPage(args.companyId, page, args.pageSize);
    if (rows.length === 0) break;

    if (projects.length >= args.maxProjects) {
      truncated = true;
      break;
    }

    for (const row of rows) {
      if (projects.length >= args.maxProjects) {
        truncated = true;
        break;
      }
      projects.push(row);
    }

    if (rows.length < args.pageSize || truncated) break;
    page += 1;
  }

  const deals = await args.listActiveDeals();
  const projectRows = projects.map((project) => buildValidationRow(project, deals));
  const now = args.now?.() ?? new Date();

  return {
    projects: projectRows,
    summary: buildSummary(projectRows, deals),
    meta: {
      companyId: args.companyId,
      fetchedCount: projects.length,
      fetchedAt: now.toISOString(),
      readOnly: true,
      truncated,
    },
  };
}

export async function listProjectValidationForOffice(
  tenantDb: TenantDb,
  args: {
    companyId: string;
    pageSize: number;
    maxProjects: number;
  }
) {
  return listProjectValidation({
    ...args,
    listActiveDeals: async () =>
      tenantDb
        .select({
          id: deals.id,
          dealNumber: deals.dealNumber,
          name: deals.name,
          city: deals.propertyCity,
          state: deals.propertyState,
          address: deals.propertyAddress,
          procoreProjectId: deals.procoreProjectId,
          updatedAt: deals.updatedAt,
        })
        .from(deals)
        .where(eq(deals.isActive, true))
        .then((rows) =>
          rows.map((row) => ({
            ...row,
            updatedAt: row.updatedAt?.toISOString?.() ?? (row.updatedAt as string | null),
          }))
        ),
  });
}

function buildValidationRow(
  project: ProcoreProjectCandidate,
  deals: CrmDealCandidate[]
): ProjectValidationRow {
  const fuzzyEligibleDeals = deals.filter((deal) => deal.procoreProjectId == null);
  const exactProjectIdMatches = deals.filter(
    (deal) => deal.procoreProjectId != null && deal.procoreProjectId === project.id
  );
  if (exactProjectIdMatches.length === 1) {
    return toRow(project, exactProjectIdMatches[0], "matched", "procore_project_id");
  }
  if (exactProjectIdMatches.length > 1) {
    return toRow(project, null, "ambiguous", "duplicate_procore_project_id");
  }

  const normalizedProject = normalizeProcoreReconciliationRow(project);
  const exactProjectNumberMatches = normalizedProject.normalizedProjectNumber
    ? fuzzyEligibleDeals.filter((deal) => {
        const normalizedDeal = normalizeProcoreReconciliationRow({
          name: deal.name,
          projectNumber: deal.dealNumber,
          city: deal.city,
          state: deal.state,
          address: deal.address,
        });

        return normalizedDeal.normalizedProjectNumber === normalizedProject.normalizedProjectNumber;
      })
    : [];
  if (exactProjectNumberMatches.length === 1) {
    return toRow(project, exactProjectNumberMatches[0], "matched", "project_number");
  }
  if (exactProjectNumberMatches.length > 1) {
    return toRow(project, null, "ambiguous", "duplicate_project_number");
  }

  const strongestLocationMatches = scoreNameAndLocation(project, fuzzyEligibleDeals);
  if (strongestLocationMatches.length === 1) {
    return toRow(project, strongestLocationMatches[0], "matched", "name_location");
  }
  if (strongestLocationMatches.length > 1) {
    return toRow(project, null, "ambiguous", "name_location_tie");
  }

  return toRow(project, null, "unmatched", "none");
}

function toRow(
  project: ProcoreProjectCandidate,
  deal: CrmDealCandidate | null,
  status: ValidationStatus,
  matchReason: ValidationMatchReason
): ProjectValidationRow {
  return {
    project,
    deal,
    status,
    matchReason,
  };
}

function scoreNameAndLocation(project: ProcoreProjectCandidate, deals: CrmDealCandidate[]) {
  const normalizedProject = normalizeProcoreReconciliationRow(project);
  if (!normalizedProject.normalizedName) return [];

  const candidates = deals
    .map((deal) => {
      const normalizedDeal = normalizeProcoreReconciliationRow({
        name: deal.name,
        projectNumber: deal.dealNumber,
        city: deal.city,
        state: deal.state,
        address: deal.address,
      });

      if (normalizedDeal.normalizedName !== normalizedProject.normalizedName) {
        return null;
      }

      return {
        deal,
        score: getLocationScore(normalizedProject, normalizedDeal),
      };
    })
    .filter((candidate): candidate is { deal: CrmDealCandidate; score: number } => candidate != null);

  const bestScore = Math.max(0, ...candidates.map((candidate) => candidate.score));
  if (bestScore <= 0) return [];

  return candidates
    .filter((candidate) => candidate.score === bestScore)
    .map((candidate) => candidate.deal)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function getLocationScore(
  project: ReturnType<typeof normalizeProcoreReconciliationRow>,
  deal: ReturnType<typeof normalizeProcoreReconciliationRow>
) {
  let score = 0;

  if (project.normalizedCity && project.normalizedCity === deal.normalizedCity) score += 5;
  if (project.normalizedState && project.normalizedState === deal.normalizedState) score += 3;
  if (
    project.normalizedAddress &&
    project.normalizedAddress === deal.normalizedAddress &&
    project.normalizedCity &&
    project.normalizedCity === deal.normalizedCity &&
    project.normalizedState &&
    project.normalizedState === deal.normalizedState
  ) {
    score += 2;
  }

  return score;
}

function buildSummary(projects: ProjectValidationRow[], deals: CrmDealCandidate[]) {
  return {
    matched: projects.filter((project) => project.status === "matched").length,
    ambiguous: projects.filter((project) => project.status === "ambiguous").length,
    unmatched: projects.filter((project) => project.status === "unmatched").length,
    total: projects.length,
    totalDeals: deals.length,
  };
}
