import { and, eq } from "drizzle-orm";
import { deals, leads, offices, userOfficeAccess, users } from "@trock-crm/shared/schema";
import { resolveOfficeCodeFromOffice } from "@trock-crm/shared/types";
import { AppError } from "../middleware/error-handler.js";

type TenantDb = any;

type Viewer = {
  id: string;
  role: string;
  officeId?: string | null;
  activeOfficeId?: string | null;
};

type DealAccessRow = {
  id: string;
  assignedRepId: string | null;
  sourceLeadId: string | null;
  officeCode: string | null;
  assigneeOfficeId: string | null;
};

type LeadAccessRow = {
  id: string;
  assignedRepId: string | null;
  officeCode: string | null;
  assigneeOfficeId: string | null;
};

export function getViewerOfficeId(viewer: Viewer) {
  return viewer.activeOfficeId ?? viewer.officeId ?? null;
}

async function getViewerOfficeCode(tenantDb: TenantDb, viewer: Viewer) {
  const viewerOfficeId = getViewerOfficeId(viewer);
  if (!viewerOfficeId) {
    return null;
  }

  const [office] = await tenantDb
    .select({
      slug: offices.slug,
      name: offices.name,
    })
    .from(offices)
    .where(eq(offices.id, viewerOfficeId))
    .limit(1);

  return resolveOfficeCodeFromOffice(office ?? null);
}

async function viewerMatchesRecordOffice(
  tenantDb: TenantDb,
  viewer: Viewer,
  input: { officeCode?: string | null; assignedRepId?: string | null; assigneeOfficeId?: string | null }
) {
  const viewerOfficeId = getViewerOfficeId(viewer);
  if (!viewerOfficeId) {
    return false;
  }

  const recordOfficeCode = resolveOfficeCodeFromOffice(input.officeCode ?? null);
  if (recordOfficeCode) {
    const viewerOfficeCode = await getViewerOfficeCode(tenantDb, viewer);
    return viewerOfficeCode === recordOfficeCode;
  }

  if (!input.assignedRepId) {
    return true;
  }

  if (input.assigneeOfficeId === viewerOfficeId) {
    return true;
  }

  const [officeAccess] = await tenantDb
    .select({ officeId: userOfficeAccess.officeId })
    .from(userOfficeAccess)
    .where(and(eq(userOfficeAccess.userId, input.assignedRepId), eq(userOfficeAccess.officeId, viewerOfficeId)))
    .limit(1);

  return officeAccess?.officeId === viewerOfficeId;
}

export function normalizeCollaborativeScope(
  _role: string,
  requested: "mine" | "team" | "all" | undefined
): "mine" | "team" | "all" {
  return requested ?? "mine";
}

export function getCollaborativeReadRole(
  role: string,
  requested: "mine" | "team" | "all" | undefined
) {
  if (role === "rep" && requested === "all") {
    return "director";
  }
  return role;
}

export async function getDealOfficeAccess(tenantDb: TenantDb, dealId: string): Promise<DealAccessRow | null> {
  const [row] = await tenantDb
    .select({
      id: deals.id,
      assignedRepId: deals.assignedRepId,
      sourceLeadId: deals.sourceLeadId,
      officeCode: deals.officeCode,
      assigneeOfficeId: users.officeId,
    })
    .from(deals)
    .leftJoin(users, eq(users.id, deals.assignedRepId))
    .where(eq(deals.id, dealId))
    .limit(1);

  return row ?? null;
}

export async function getLeadOfficeAccess(tenantDb: TenantDb, leadId: string): Promise<LeadAccessRow | null> {
  const [row] = await tenantDb
    .select({
      id: leads.id,
      assignedRepId: leads.assignedRepId,
      officeCode: leads.officeCode,
      assigneeOfficeId: users.officeId,
    })
    .from(leads)
    .leftJoin(users, eq(users.id, leads.assignedRepId))
    .where(eq(leads.id, leadId))
    .limit(1);

  return row ?? null;
}

export async function assertDealCollaboratorAccess(tenantDb: TenantDb, dealId: string, viewer: Viewer) {
  const row = await getDealOfficeAccess(tenantDb, dealId);
  if (!row) {
    throw new AppError(404, "Deal not found");
  }

  const officeMatch = await viewerMatchesRecordOffice(tenantDb, viewer, row);
  if (!officeMatch) {
    throw new AppError(403, "Access denied: deal is outside your office.");
  }

  return row;
}

export async function assertLeadCollaboratorAccess(tenantDb: TenantDb, leadId: string, viewer: Viewer) {
  const row = await getLeadOfficeAccess(tenantDb, leadId);
  if (!row) {
    throw new AppError(404, "Lead not found");
  }

  const officeMatch = await viewerMatchesRecordOffice(tenantDb, viewer, row);
  if (!officeMatch) {
    throw new AppError(403, "Access denied: lead is outside your office.");
  }

  return row;
}

export async function assertDealOwnerAccess(
  tenantDb: TenantDb,
  dealId: string,
  viewer: Viewer,
  options: { allowAdmin?: boolean; message?: string } = {}
) {
  const isAdminOverride = options.allowAdmin === true && viewer.role === "admin";
  if (isAdminOverride) {
    const row = await getDealOfficeAccess(tenantDb, dealId);
    if (!row) {
      throw new AppError(404, "Deal not found");
    }
    return row;
  }

  const row = await assertDealCollaboratorAccess(tenantDb, dealId, viewer);
  const isOwner = row.assignedRepId === viewer.id;
  if (!isOwner && !isAdminOverride) {
    throw new AppError(403, options.message ?? "Only the assigned rep can modify this deal");
  }
  return row;
}

export async function assertLeadOwnerAccess(
  tenantDb: TenantDb,
  leadId: string,
  viewer: Viewer,
  options: { allowAdmin?: boolean; message?: string } = {}
) {
  const isAdminOverride = options.allowAdmin === true && viewer.role === "admin";
  if (isAdminOverride) {
    const row = await getLeadOfficeAccess(tenantDb, leadId);
    if (!row) {
      throw new AppError(404, "Lead not found");
    }
    return row;
  }

  const row = await assertLeadCollaboratorAccess(tenantDb, leadId, viewer);
  const isOwner = row.assignedRepId === viewer.id;
  if (!isOwner && !isAdminOverride) {
    throw new AppError(403, options.message ?? "Only the assigned rep can modify this lead");
  }
  return row;
}
