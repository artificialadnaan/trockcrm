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
  requested: "mine" | "team" | "all" | "watched" | "on_hold" | undefined
) {
  // "On Hold" is an All-style OVERVIEW filter (the office's held/far-out deals, not the viewer's own) —
  // self-scoping it would wrongly limit a director/admin to only THEIR held deals. Its predicate carries
  // no ownership term, so a rep on this scope reads office-wide; elevate them like "all" so the read role
  // matches the data (and grants nothing a rep can't already reach via the All pill). "watched" stays
  // self-scoped (the subscription relation IS the ownership), so it deliberately does NOT elevate.
  if (role === "rep" && (requested === "all" || requested === "on_hold")) {
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
  options: { allowAdmin?: boolean; allowDirector?: boolean; message?: string } = {}
) {
  // Elevated roles bypass the owner check. Admin is global; a director is office-scoped, but the deal is
  // fetched from the viewer's tenant schema (search_path), so getDealOfficeAccess can only return a deal in
  // the director's active office — the office boundary is enforced implicitly, same as the trigger-rfp route.
  const isElevatedOverride =
    (options.allowAdmin === true && viewer.role === "admin") ||
    (options.allowDirector === true && viewer.role === "director");
  if (isElevatedOverride) {
    const row = await getDealOfficeAccess(tenantDb, dealId);
    if (!row) {
      throw new AppError(404, "Deal not found");
    }
    return row;
  }

  const row = await assertDealCollaboratorAccess(tenantDb, dealId, viewer);
  const isOwner = row.assignedRepId === viewer.id;
  if (!isOwner) {
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
