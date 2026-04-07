import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { listCompanyProjectsPage } from "../../lib/procore-client.js";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface ProcoreProjectCandidate {
  id: number;
  name: string;
  projectNumber: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
  updatedAt: string | null;
}

export interface CrmDealCandidate {
  id: string;
  dealNumber: string | null;
  name: string;
  city: string | null;
  state: string | null;
  address: string | null;
  procoreProjectId: number | null;
  updatedAt: string | null;
}

export interface ReconciliationProjectRow {
  procoreProjectId: number;
  bucket: "linked" | "likely_match" | "procore_only";
  dealId: string | null;
  ignoreState: "none" | "pair" | "office";
}

export interface ReconciliationResult {
  projects: ReconciliationProjectRow[];
  crmOnlyDeals: CrmDealCandidate[];
}

export interface ReconciliationDiffField {
  field: "name" | "projectNumber" | "city" | "state" | "address" | "updatedAt";
  procoreValue: string | null;
  crmValue: string | null;
  matches: boolean;
}

export interface ReconciliationProjectView {
  procoreProjectId: number;
  bucket: "linked" | "likely_match" | "procore_only";
  project: ProcoreProjectCandidate;
  deal: CrmDealCandidate | null;
  diffSummary: ReconciliationDiffField[];
  ignoreState: "none" | "pair" | "office";
}

export interface ListProcoreReconciliationResult {
  projects: ReconciliationProjectView[];
  crmOnlyDeals: CrmDealCandidate[];
  summary: {
    linked: number;
    likelyMatch: number;
    procoreOnly: number;
    crmOnly: number;
    totalProjects: number;
  };
}

interface ReconciliationStateRow {
  officeId: string;
  procoreProjectId: number;
  dealId: string | null;
  status: "linked" | "ignored";
  matchReason: string | null;
}

interface ReconciliationDependencies {
  listProjectsPage: (companyId: string, page: number, pageSize: number) => Promise<ProcoreProjectCandidate[]>;
  listActiveDeals: (tenantDb: TenantDb) => Promise<CrmDealCandidate[]>;
  listIgnoredRows: (tenantDb: TenantDb, officeId: string) => Promise<ReconciliationStateRow[]>;
  findDealById: (tenantDb: TenantDb, dealId: string) => Promise<CrmDealCandidate | null>;
  findDealByProjectId: (tenantDb: TenantDb, procoreProjectId: number) => Promise<CrmDealCandidate | null>;
  lockProjectScope: (
    tenantDb: TenantDb,
    officeId: string,
    procoreProjectId: number
  ) => Promise<void>;
  lockDealScope: (
    tenantDb: TenantDb,
    officeId: string,
    dealId: string
  ) => Promise<void>;
  setDealProjectLink: (
    tenantDb: TenantDb,
    dealId: string,
    procoreProjectId: number | null,
    syncedAt: Date | null
  ) => Promise<void>;
  clearIgnoreRowsForLink: (
    tenantDb: TenantDb,
    officeId: string,
    procoreProjectId: number,
    dealId: string
  ) => Promise<void>;
  upsertReconciliationState: (
    tenantDb: TenantDb,
    row: ReconciliationStateRow & { updatedBy: string; matchSnapshot: unknown }
  ) => Promise<void>;
  deleteIgnoredRow: (
    tenantDb: TenantDb,
    officeId: string,
    procoreProjectId: number,
    dealId: string | null
  ) => Promise<void>;
}

function normalizeDealCandidate(deal: CrmDealCandidate) {
  return normalizeProcoreReconciliationRow({
    name: deal.name,
    projectNumber: deal.dealNumber,
    city: deal.city,
    state: deal.state,
    address: deal.address,
  });
}

function hasAlignedAddress(
  project: ReturnType<typeof normalizeProcoreReconciliationRow>,
  deal: ReturnType<typeof normalizeProcoreReconciliationRow>
) {
  return Boolean(
    project.normalizedAddress &&
      project.normalizedAddress === deal.normalizedAddress &&
      project.normalizedCity &&
      project.normalizedCity === deal.normalizedCity &&
      project.normalizedState &&
      project.normalizedState === deal.normalizedState
  );
}

function getLocationScore(
  project: ReturnType<typeof normalizeProcoreReconciliationRow>,
  deal: ReturnType<typeof normalizeProcoreReconciliationRow>
) {
  let score = 0;
  if (project.normalizedCity && project.normalizedCity === deal.normalizedCity) score += 5;
  if (project.normalizedState && project.normalizedState === deal.normalizedState) score += 3;
  if (hasAlignedAddress(project, deal)) score += 2;
  return score;
}

function buildDiffSummary(project: ProcoreProjectCandidate, deal: CrmDealCandidate | null): ReconciliationDiffField[] {
  if (!deal) return [];

  return [
    {
      field: "name",
      procoreValue: project.name,
      crmValue: deal.name,
      matches: normalizeProcoreReconciliationRow({
        name: project.name,
        projectNumber: null,
        city: null,
        state: null,
        address: null,
      }).normalizedName ===
        normalizeProcoreReconciliationRow({
          name: deal.name,
          projectNumber: null,
          city: null,
          state: null,
          address: null,
        }).normalizedName,
    },
    {
      field: "projectNumber",
      procoreValue: project.projectNumber,
      crmValue: deal.dealNumber,
      matches:
        normalizeProcoreReconciliationRow({
          name: null,
          projectNumber: project.projectNumber,
          city: null,
          state: null,
          address: null,
        }).normalizedProjectNumber ===
        normalizeProcoreReconciliationRow({
          name: null,
          projectNumber: deal.dealNumber,
          city: null,
          state: null,
          address: null,
        }).normalizedProjectNumber,
    },
    {
      field: "city",
      procoreValue: project.city,
      crmValue: deal.city,
      matches:
        normalizeProcoreReconciliationRow({
          name: null,
          projectNumber: null,
          city: project.city,
          state: null,
          address: null,
        }).normalizedCity ===
        normalizeProcoreReconciliationRow({
          name: null,
          projectNumber: null,
          city: deal.city,
          state: null,
          address: null,
        }).normalizedCity,
    },
    {
      field: "state",
      procoreValue: project.state,
      crmValue: deal.state,
      matches:
        normalizeProcoreReconciliationRow({
          name: null,
          projectNumber: null,
          city: null,
          state: project.state,
          address: null,
        }).normalizedState ===
        normalizeProcoreReconciliationRow({
          name: null,
          projectNumber: null,
          city: null,
          state: deal.state,
          address: null,
        }).normalizedState,
    },
    {
      field: "address",
      procoreValue: project.address,
      crmValue: deal.address,
      matches:
        normalizeProcoreReconciliationRow({
          name: null,
          projectNumber: null,
          city: null,
          state: null,
          address: project.address,
        }).normalizedAddress ===
        normalizeProcoreReconciliationRow({
          name: null,
          projectNumber: null,
          city: null,
          state: null,
          address: deal.address,
        }).normalizedAddress,
    },
    {
      field: "updatedAt",
      procoreValue: project.updatedAt,
      crmValue: deal.updatedAt,
      matches: project.updatedAt === deal.updatedAt,
    },
  ];
}

function companyId() {
  const id = process.env.PROCORE_COMPANY_ID;
  if (!id) throw new AppError(500, "PROCORE_COMPANY_ID must be set");
  return id;
}

async function defaultListActiveDeals(tenantDb: TenantDb): Promise<CrmDealCandidate[]> {
  return tenantDb
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
        updatedAt: row.updatedAt?.toISOString?.() ?? (row.updatedAt as unknown as string | null) ?? null,
      }))
    );
}

async function defaultListIgnoredRows(tenantDb: TenantDb, officeId: string): Promise<ReconciliationStateRow[]> {
  const result = await tenantDb.execute(sql`
    SELECT office_id, procore_project_id, deal_id, status, match_reason
    FROM public.procore_reconciliation_state
    WHERE office_id = ${officeId} AND status = 'ignored'
  `);

  return result.rows.map((row) => ({
    officeId: String(row.office_id),
    procoreProjectId: Number(row.procore_project_id),
    dealId: row.deal_id == null ? null : String(row.deal_id),
    status: row.status as "linked" | "ignored",
    matchReason: row.match_reason == null ? null : String(row.match_reason),
  }));
}

async function defaultFindDealById(tenantDb: TenantDb, dealId: string): Promise<CrmDealCandidate | null> {
  const [row] = await tenantDb
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
    .where(and(eq(deals.id, dealId), eq(deals.isActive, true)))
    .limit(1);

  if (!row) return null;

  return {
    ...row,
    updatedAt: row.updatedAt?.toISOString?.() ?? (row.updatedAt as unknown as string | null) ?? null,
  };
}

async function defaultFindDealByProjectId(
  tenantDb: TenantDb,
  procoreProjectId: number
): Promise<CrmDealCandidate | null> {
  const [row] = await tenantDb
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
    .where(and(eq(deals.procoreProjectId, procoreProjectId), eq(deals.isActive, true)))
    .limit(1);

  if (!row) return null;

  return {
    ...row,
    updatedAt: row.updatedAt?.toISOString?.() ?? (row.updatedAt as unknown as string | null) ?? null,
  };
}

async function defaultLockProjectScope(
  tenantDb: TenantDb,
  officeId: string,
  procoreProjectId: number
) {
  await tenantDb.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`procore-link:project:${officeId}:${procoreProjectId}`}))`
  );
}

async function defaultLockDealScope(
  tenantDb: TenantDb,
  officeId: string,
  dealId: string
) {
  await tenantDb.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`procore-link:deal:${officeId}:${dealId}`}))`
  );
}

async function defaultSetDealProjectLink(
  tenantDb: TenantDb,
  dealId: string,
  procoreProjectId: number | null,
  syncedAt: Date | null
) {
  await tenantDb
    .update(deals)
    .set({
      procoreProjectId,
      procoreLastSyncedAt: syncedAt,
      updatedAt: new Date(),
    })
    .where(eq(deals.id, dealId));
}

async function defaultClearIgnoreRowsForLink(
  tenantDb: TenantDb,
  officeId: string,
  procoreProjectId: number,
  dealId: string
) {
  await tenantDb.execute(sql`
    DELETE FROM public.procore_reconciliation_state
    WHERE office_id = ${officeId}
      AND procore_project_id = ${procoreProjectId}
      AND status = 'ignored'
      AND (deal_id IS NULL OR deal_id = ${dealId}::uuid)
  `);
}

async function defaultUpsertReconciliationState(
  tenantDb: TenantDb,
  row: ReconciliationStateRow & { updatedBy: string; matchSnapshot: unknown }
) {
  await tenantDb.execute(sql`
    INSERT INTO public.procore_reconciliation_state (
      office_id,
      procore_project_id,
      deal_id,
      status,
      match_reason,
      match_snapshot,
      updated_by,
      updated_at
    ) VALUES (
      ${row.officeId}::uuid,
      ${row.procoreProjectId},
      ${row.dealId}::uuid,
      ${row.status}::public.procore_reconciliation_status,
      ${row.matchReason},
      ${JSON.stringify(row.matchSnapshot)}::jsonb,
      ${row.updatedBy}::uuid,
      NOW()
    )
    ON CONFLICT (
      office_id,
      procore_project_id,
      (coalesce(deal_id, '00000000-0000-0000-0000-000000000000'::uuid))
    )
    DO UPDATE SET
      status = EXCLUDED.status,
      match_reason = EXCLUDED.match_reason,
      match_snapshot = EXCLUDED.match_snapshot,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
  `);
}

async function defaultDeleteIgnoredRow(
  tenantDb: TenantDb,
  officeId: string,
  procoreProjectId: number,
  dealId: string | null
) {
  await tenantDb.execute(sql`
    DELETE FROM public.procore_reconciliation_state
    WHERE office_id = ${officeId}
      AND procore_project_id = ${procoreProjectId}
      AND status = 'ignored'
      AND (
        (${dealId}::uuid IS NULL AND deal_id IS NULL)
        OR deal_id = ${dealId}::uuid
      )
  `);
}

const defaultDependencies: ReconciliationDependencies = {
  listProjectsPage: async (companyIdValue, page, pageSize) =>
    listCompanyProjectsPage(companyIdValue, page, pageSize).then((rows) =>
      rows.map((row) => ({
        id: row.id,
        name: row.displayName || row.name || `Project ${row.id}`,
        projectNumber: row.projectNumber,
        city: row.city,
        state: row.state,
        address: row.address,
        updatedAt: row.updatedAt,
      }))
    ),
  listActiveDeals: defaultListActiveDeals,
  listIgnoredRows: defaultListIgnoredRows,
  findDealById: defaultFindDealById,
  findDealByProjectId: defaultFindDealByProjectId,
  lockProjectScope: defaultLockProjectScope,
  lockDealScope: defaultLockDealScope,
  setDealProjectLink: defaultSetDealProjectLink,
  clearIgnoreRowsForLink: defaultClearIgnoreRowsForLink,
  upsertReconciliationState: defaultUpsertReconciliationState,
  deleteIgnoredRow: defaultDeleteIgnoredRow,
};

export function normalizeProcoreReconciliationRow(input: {
  name: string | null;
  projectNumber: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
}) {
  const normalizeText = (value: string | null) =>
    (value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const normalizeCode = (value: string | null) =>
    (value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .trim();

  return {
    normalizedName: normalizeText(input.name),
    normalizedProjectNumber: normalizeCode(input.projectNumber),
    normalizedCity: normalizeText(input.city),
    normalizedState: normalizeText(input.state),
    normalizedAddress: normalizeText(input.address),
  };
}

export function classifyProcoreProjects(input: {
  projects: ProcoreProjectCandidate[];
  deals: CrmDealCandidate[];
  ignoredKeys: Set<string>;
  officeId: string;
}): ReconciliationResult {
  const linkedDeals = new Map<number, CrmDealCandidate>();
  const availableDeals = new Map<string, CrmDealCandidate>();

  for (const deal of input.deals) {
    if (deal.procoreProjectId != null) {
      linkedDeals.set(deal.procoreProjectId, deal);
      continue;
    }
    availableDeals.set(deal.id, deal);
  }

  const projects: ReconciliationProjectRow[] = [];

  for (const project of input.projects) {
    const linked = linkedDeals.get(project.id);
    if (linked) {
      projects.push({
        procoreProjectId: project.id,
        bucket: "linked",
        dealId: linked.id,
        ignoreState: "none",
      });
      continue;
    }

    const normalized = normalizeProcoreReconciliationRow(project);
    const candidates = [...availableDeals.values()];
    const byNumber = normalized.normalizedProjectNumber
      ? candidates.filter((deal) => {
          const dealNormalized = normalizeDealCandidate(deal);
          return dealNormalized.normalizedProjectNumber === normalized.normalizedProjectNumber;
        })
      : [];
    const byName = normalized.normalizedName
      ? candidates.filter((deal) => {
          const dealNormalized = normalizeDealCandidate(deal);
          return dealNormalized.normalizedName === normalized.normalizedName;
        })
      : [];
    const candidatePool = byNumber.length > 0 ? byNumber : byName;
    const rankedCandidates = candidatePool
      .map((deal) => {
        const normalizedDeal = normalizeDealCandidate(deal);
        return {
          deal,
          score: getLocationScore(normalized, normalizedDeal),
          addressAligned: hasAlignedAddress(normalized, normalizedDeal),
        };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.addressAligned) - Number(a.addressAligned) ||
          a.deal.name.localeCompare(b.deal.name)
      );
    const officeWideIgnoreKey = `${input.officeId}:${project.id}:*`;

    if (!input.ignoredKeys.has(officeWideIgnoreKey)) {
      const likely = rankedCandidates.find(
        ({ deal }) => !input.ignoredKeys.has(`${input.officeId}:${project.id}:${deal.id}`)
      )?.deal;

      if (likely) {
        projects.push({
          procoreProjectId: project.id,
          bucket: "likely_match",
          dealId: likely.id,
          ignoreState: "none",
        });
        availableDeals.delete(likely.id);
        continue;
      }
    }

    const hasPairSuppression =
      rankedCandidates.length > 0 &&
      rankedCandidates.every(({ deal }) => input.ignoredKeys.has(`${input.officeId}:${project.id}:${deal.id}`));
    projects.push({
      procoreProjectId: project.id,
      bucket: "procore_only",
      dealId: null,
      ignoreState: input.ignoredKeys.has(officeWideIgnoreKey)
        ? "office"
        : hasPairSuppression
          ? "pair"
          : "none",
    });
  }

  return {
    projects,
    crmOnlyDeals: [...availableDeals.values()],
  };
}

export function createProcoreReconciliationService(
  dependencies: Partial<ReconciliationDependencies> = {},
  options: { pageSize?: number } = {}
) {
  const deps = { ...defaultDependencies, ...dependencies };
  const pageSize = options.pageSize ?? 100;

  return {
    async listProcoreReconciliation(input: {
      tenantDb: TenantDb;
      officeId: string;
    }): Promise<ListProcoreReconciliationResult> {
      const companyIdValue = companyId();
      const projects: ProcoreProjectCandidate[] = [];
      let page = 1;

      while (true) {
        const pageRows = await deps.listProjectsPage(companyIdValue, page, pageSize);
        projects.push(...pageRows);
        if (pageRows.length < pageSize) break;
        page += 1;
      }

      const [dealRows, ignoredRows] = await Promise.all([
        deps.listActiveDeals(input.tenantDb),
        deps.listIgnoredRows(input.tenantDb, input.officeId),
      ]);

      const ignoredKeys = new Set(
        ignoredRows
          .filter((row) => row.status === "ignored")
          .map((row) => `${row.officeId}:${row.procoreProjectId}:${row.dealId ?? "*"}`)
      );

      const classified = classifyProcoreProjects({
        projects,
        deals: dealRows,
        ignoredKeys,
        officeId: input.officeId,
      });

      const projectById = new Map(projects.map((project) => [project.id, project]));
      const dealById = new Map(dealRows.map((deal) => [deal.id, deal]));

      const projectViews = classified.projects.map((row) => {
        const project = projectById.get(row.procoreProjectId)!;
        const deal = row.dealId ? dealById.get(row.dealId) ?? null : null;
        return {
          procoreProjectId: row.procoreProjectId,
          bucket: row.bucket,
          project,
          deal,
          diffSummary: buildDiffSummary(project, deal),
          ignoreState: row.ignoreState,
        };
      });

      return {
        projects: projectViews,
        crmOnlyDeals: classified.crmOnlyDeals,
        summary: {
          linked: projectViews.filter((row) => row.bucket === "linked").length,
          likelyMatch: projectViews.filter((row) => row.bucket === "likely_match").length,
          procoreOnly: projectViews.filter((row) => row.bucket === "procore_only").length,
          crmOnly: classified.crmOnlyDeals.length,
          totalProjects: projectViews.length,
        },
      };
    },

    async linkProcoreProjectToDeal(input: {
      tenantDb: TenantDb;
      officeId: string;
      userId: string;
      procoreProjectId: number;
      dealId: string;
    }) {
      await deps.lockProjectScope(input.tenantDb, input.officeId, input.procoreProjectId);
      await deps.lockDealScope(input.tenantDb, input.officeId, input.dealId);

      const [deal, existingProjectLink] = await Promise.all([
        deps.findDealById(input.tenantDb, input.dealId),
        deps.findDealByProjectId(input.tenantDb, input.procoreProjectId),
      ]);

      if (!deal) {
        throw new AppError(404, "Deal not found");
      }

      if (existingProjectLink && existingProjectLink.id !== input.dealId) {
        throw new AppError(409, "Procore project is already linked to another deal");
      }

      if (deal.procoreProjectId != null && deal.procoreProjectId !== input.procoreProjectId) {
        throw new AppError(409, "Deal is already linked to another Procore project");
      }

      const syncedAt = new Date();
      await deps.setDealProjectLink(input.tenantDb, input.dealId, input.procoreProjectId, syncedAt);
      await deps.clearIgnoreRowsForLink(input.tenantDb, input.officeId, input.procoreProjectId, input.dealId);
      await deps.upsertReconciliationState(input.tenantDb, {
        officeId: input.officeId,
        procoreProjectId: input.procoreProjectId,
        dealId: input.dealId,
        status: "linked",
        matchReason: "manual_link",
        matchSnapshot: {
          linkedAt: syncedAt.toISOString(),
          dealId: input.dealId,
          procoreProjectId: input.procoreProjectId,
        },
        updatedBy: input.userId,
      });
    },

    async unlinkProcoreProject(input: {
      tenantDb: TenantDb;
      officeId: string;
      procoreProjectId: number;
    }) {
      await deps.lockProjectScope(input.tenantDb, input.officeId, input.procoreProjectId);
      const existingLink = await deps.findDealByProjectId(input.tenantDb, input.procoreProjectId);
      if (!existingLink) {
        throw new AppError(404, "Linked deal not found");
      }

      await deps.setDealProjectLink(input.tenantDb, existingLink.id, null, null);
    },

    async ignoreProcoreSuggestion(input: {
      tenantDb: TenantDb;
      officeId: string;
      userId: string;
      procoreProjectId: number;
      dealId?: string | null;
      reason?: string | null;
    }) {
      await deps.lockProjectScope(input.tenantDb, input.officeId, input.procoreProjectId);
      await deps.upsertReconciliationState(input.tenantDb as TenantDb, {
        officeId: input.officeId,
        procoreProjectId: input.procoreProjectId,
        dealId: input.dealId ?? null,
        status: "ignored",
        matchReason: input.reason ?? null,
        matchSnapshot: {
          ignoredAt: new Date().toISOString(),
          scope: input.dealId ? "pair" : "office",
        },
        updatedBy: input.userId,
      });
    },

    async clearIgnoredProcoreSuggestion(input: {
      tenantDb: TenantDb;
      officeId: string;
      procoreProjectId: number;
      dealId?: string | null;
    }) {
      await deps.lockProjectScope(input.tenantDb, input.officeId, input.procoreProjectId);
      await deps.deleteIgnoredRow(input.tenantDb as TenantDb, input.officeId, input.procoreProjectId, input.dealId ?? null);
    },
  };
}

const liveService = createProcoreReconciliationService();

export async function listProcoreReconciliation(input: {
  tenantDb: TenantDb;
  officeId: string;
}) {
  return liveService.listProcoreReconciliation(input);
}

export async function linkProcoreProjectToDeal(input: {
  tenantDb: TenantDb;
  officeId: string;
  userId: string;
  procoreProjectId: number;
  dealId: string;
}) {
  return liveService.linkProcoreProjectToDeal(input);
}

export async function unlinkProcoreProject(input: {
  tenantDb: TenantDb;
  officeId: string;
  procoreProjectId: number;
}) {
  return liveService.unlinkProcoreProject(input);
}

export async function ignoreProcoreSuggestion(input: {
  tenantDb: TenantDb;
  officeId: string;
  userId: string;
  procoreProjectId: number;
  dealId?: string | null;
  reason?: string | null;
}) {
  return liveService.ignoreProcoreSuggestion(input);
}

export async function clearIgnoredProcoreSuggestion(input: {
  tenantDb: TenantDb;
  officeId: string;
  procoreProjectId: number;
  dealId?: string | null;
}) {
  return liveService.clearIgnoredProcoreSuggestion(input);
}
