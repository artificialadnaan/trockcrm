import { eq } from "drizzle-orm";
import { deals, leads, users } from "@trock-crm/shared/schema";
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

// office_code is a cosmetic project-number prefix, NOT an access boundary. A record reached here was
// fetched from the viewer's tenant schema (search_path), so it already belongs to the viewer's office —
// any office member may collaborate on it regardless of its office_code or its assigned rep's office (an
// ATL-prefixed deal created by a Dallas rep stays accessible to Dallas reps). Owner-only mutations are
// enforced separately by assertDeal/LeadOwnerAccess. Deny only when the viewer has no office at all.
function viewerMatchesRecordOffice(viewer: Viewer): boolean {
  return getViewerOfficeId(viewer) !== null;
}

// Generic so the return type FOLLOWS the (already-whitelisted) input: deals pass a "…|watched|on_hold"
// union and get it back; leads pass a narrow "mine"|"team"|"all" (via their readListScope) and STAY
// narrow — so this shared helper never widens leads' scope into a deals-only scope. Runtime only defaults
// undefined → "mine".
export function normalizeCollaborativeScope<S extends "mine" | "team" | "all" | "watched" | "on_hold">(
  _role: string,
  requested: S | undefined
): S | "mine" {
  return requested ?? "mine";
}

export function getCollaborativeReadRole(
  role: string,
  // Type widened to accept the now-possible deals-only "watched"/"on_hold"; the elevation BODY is
  // intentionally unchanged — only requested === "all" elevates a rep, so the deals-only scopes keep the
  // viewer's own role (self-scoped).
  requested: "mine" | "team" | "all" | "watched" | "on_hold" | undefined
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

  const officeMatch = viewerMatchesRecordOffice(viewer);
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

  const officeMatch = viewerMatchesRecordOffice(viewer);
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
