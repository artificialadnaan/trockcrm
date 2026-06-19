import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { deals, leads } from "@trock-crm/shared/schema";
import type { UserRole } from "@trock-crm/shared/types";
import { resolveDealDisplayNumber } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { buildFileDownloadUrlFromRecord, getDealPhotoTimeline, searchPhotoUploadTargets, type PhotoUploadTarget } from "../files/service.js";
import type { DealPhotoTimelineFilters } from "../files/photo-timeline-filters.js";
import { officeTag, type FieldOffice, type OfficeTag } from "./cross-office.js";
import { WON_STAGE_SLUGS, LOST_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type FieldAccessContext = {
  userId: string;
  userRole: UserRole;
};

// Field "browsable projects" stage rule. The field surface shows ACTIVE-pipeline deals AND Won-family
// terminal deals — crews must find and photograph Won / in-production jobs — but NEVER Lost-family (dead
// jobs). This is the intent-explicit replacement for the old "exclude ALL terminal" rule (which hid Won):
// it deliberately does NOT widen to every terminal stage, which would flood the list with hundreds of
// active Lost deals. `is_active = true` is still required, so only LIVE Won deals surface — the exact set
// the capture-target picker already reaches; archived (is_active=false) Won stay hidden. Both sets come
// from the SHARED canonical slug families (not a hardcoded literal) so omitted alias stages can't drift.
const FIELD_WON_BROWSABLE_SLUGS = WON_STAGE_SLUGS;
const FIELD_LOST_EXCLUDED_SLUGS = LOST_STAGE_SLUGS;

const textArray = (values: readonly string[]) => sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;

export type FieldProject = {
  id: string;
  name: string;
  /**
   * RAW `deals.deal_number`. For HubSpot-imported deals this is the meaningless HubSpot id
   * ("HS-…") — do NOT display it. Kept raw because it is also a stable, unique, non-null key used
   * internally (e.g. the photo-report R2 storage path) and for record matching. Clients display
   * `projectNumber` instead.
   */
  dealNumber: string;
  /**
   * The human-facing project number to DISPLAY: the canonical value (project_number, else a
   * non-HubSpot deal_number), or null when there isn't one yet ("pending"). Resolved server-side via
   * the shared resolver so the field clients never show the HubSpot id. This is the field clients
   * should render.
   */
  projectNumber: string | null;
  propertyName: string | null;
  propertyAddress: string | null;
  stage: string;
  lastActivityAt: string | null;
  photoCount: number;
  starred: boolean;
};

export type FieldPhoto = {
  id: string;
  category: "photo";
  photoCategory: string | null;
  subcategory: string | null;
  displayName: string;
  mimeType: string;
  fileSizeBytes: number | null;
  fileExtension: string | null;
  dealId: string | null;
  leadId: string | null;
  description: string | null;
  tags: string[];
  takenAt: string | null;
  createdAt: string;
  uploadedBy: string;
  uploaderName: string;
  uploaderAvatarUrl: string | null;
  latitude: string | null;
  longitude: string | null;
  address: string | null;
  addressSource: string | null;
  geocodedAt: string | null;
  procoreSyncStatus: string | null;
  deletedAt: string | null;
  imageUrl: string | null;
};

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapFieldProject(row: any): FieldProject {
  return {
    id: row.id,
    name: row.name,
    // Raw deal_number stays raw (storage-path / matching key). The display number is resolved the
    // same way the CRM + global search do: project_number, else a non-HubSpot deal_number, else null
    // — so the HubSpot id in deal_number is never shown.
    dealNumber: row.deal_number,
    projectNumber: resolveDealDisplayNumber({ projectNumber: row.project_number, dealNumber: row.deal_number }),
    propertyName: row.property_name ?? null,
    propertyAddress: row.property_address ?? null,
    stage: row.stage_name ?? "Active",
    lastActivityAt: iso(row.last_activity_at),
    photoCount: Number(row.photo_count ?? 0),
    starred: Boolean(row.starred),
  };
}

function activeProjectWhere(search?: string) {
  const normalizedSearch = search?.trim();
  const stageSlug = sql`COALESCE(psc.slug, d.bid_board_stage_slug, '')`;
  return sql`
    d.is_active = true
    AND (
      COALESCE(psc.is_terminal, false) = false
      OR ${stageSlug} = ANY(${textArray(FIELD_WON_BROWSABLE_SLUGS)})
    )
    AND ${stageSlug} <> ALL(${textArray(FIELD_LOST_EXCLUDED_SLUGS)})
    ${normalizedSearch ? sql`
      AND (
        d.name ILIKE ${`%${normalizedSearch}%`}
        OR d.deal_number ILIKE ${`%${normalizedSearch}%`}
        -- For HubSpot-imported deals the canonical DFW/ATL number lives in project_number (deal_number
        -- holds the HS- id), so it must be searchable too.
        OR d.project_number ILIKE ${`%${normalizedSearch}%`}
        OR d.property_address ILIKE ${`%${normalizedSearch}%`}
        OR d.property_city ILIKE ${`%${normalizedSearch}%`}
      )
    ` : sql``}
  `;
}

// NOTE: the field surface is intentionally UNSCOPED by rep — EVERY field user (incl. role "rep") sees
// EVERY active project across all offices, matching field_contractor/construction (which were never
// rep-scoped). The product requirement is "every field user finds every project", so the old
// rep-only `assigned_rep_id = <user>` filter has been removed from the field read path. (Within-office
// "my work" lives in the CRM, which keeps its own scoping — untouched.)

// Upper bound on a single per-office fetch. The cross-office /projects list merges in memory and can't
// push offset into per-office SQL, so it fetches `offset + perPage` rows per office (clamped here) to
// cover the requested page before slicing. The field list is recency-ordered and search-first, so 500
// is ample depth (deeper navigation is expected to narrow via search). This is a FIELD-ONLY service.
export const FIELD_PROJECTS_MAX_FETCH = 500;

export async function listFieldProjects(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  input: { search?: string; status?: string; page?: number; perPage?: number } = {}
) {
  if (input.status && input.status !== "active") {
    throw new AppError(400, "Only active field projects are supported");
  }
  const page = Math.max(1, input.page ?? 1);
  const perPage = Math.min(FIELD_PROJECTS_MAX_FETCH, Math.max(1, input.perPage ?? 50));
  const offset = (page - 1) * perPage;
  const where = activeProjectWhere(input.search);

  const countResult = await tenantDb.execute(sql`
    SELECT count(*)::int AS total
    FROM deals d
    LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE ${where}
  `);
  const rowsResult = await tenantDb.execute(sql`
    SELECT
      d.id,
      d.name,
      d.deal_number,
      d.project_number,
      d.name AS property_name,
      NULLIF(CONCAT_WS(', ', NULLIF(d.property_address, ''), NULLIF(d.property_city, ''), NULLIF(d.property_state, ''), NULLIF(d.property_zip, '')), '') AS property_address,
      COALESCE(psc.name, d.bid_board_stage_slug, 'Active') AS stage_name,
      COALESCE(photo_stats.last_photo_at, d.last_activity_at, d.updated_at, d.created_at) AS last_activity_at,
      COALESCE(photo_stats.photo_count, 0)::int AS photo_count,
      (fsp.user_id IS NOT NULL) AS starred
    FROM deals d
    LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
    LEFT JOIN field_user_starred_projects fsp ON fsp.deal_id = d.id AND fsp.user_id = ${access.userId}::uuid
    LEFT JOIN LATERAL (
      SELECT count(*) AS photo_count, max(COALESCE(f.taken_at, f.created_at)) AS last_photo_at
      FROM files f
      WHERE f.deal_id = d.id
        AND f.category = 'photo'
        AND f.is_active = true
        AND f.deleted_at IS NULL
    ) photo_stats ON true
    WHERE ${where}
    ORDER BY COALESCE(photo_stats.last_photo_at, d.last_activity_at, d.updated_at, d.created_at) DESC NULLS LAST
    LIMIT ${perPage}
    OFFSET ${offset}
  `);

  const total = Number((((countResult as any).rows ?? countResult)[0]?.total) ?? 0);
  const projects = ((rowsResult as any).rows ?? rowsResult).map(mapFieldProject);
  return { projects, total, page, perPage };
}

export async function listStarredFieldProjects(tenantDb: TenantDb, access: FieldAccessContext) {
  const result = await tenantDb.execute(sql`
    SELECT
      d.id,
      d.name,
      d.deal_number,
      d.project_number,
      d.name AS property_name,
      NULLIF(CONCAT_WS(', ', NULLIF(d.property_address, ''), NULLIF(d.property_city, ''), NULLIF(d.property_state, ''), NULLIF(d.property_zip, '')), '') AS property_address,
      COALESCE(psc.name, d.bid_board_stage_slug, 'Active') AS stage_name,
      COALESCE(photo_stats.last_photo_at, d.last_activity_at, d.updated_at, d.created_at) AS last_activity_at,
      COALESCE(photo_stats.photo_count, 0)::int AS photo_count,
      true AS starred
    FROM field_user_starred_projects fsp
    INNER JOIN deals d ON d.id = fsp.deal_id
    LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS photo_count, max(COALESCE(f.taken_at, f.created_at)) AS last_photo_at
      FROM files f
      WHERE f.deal_id = d.id
        AND f.category = 'photo'
        AND f.is_active = true
        AND f.deleted_at IS NULL
    ) photo_stats ON true
    WHERE fsp.user_id = ${access.userId}::uuid
      AND ${activeProjectWhere()}
    ORDER BY COALESCE(photo_stats.last_photo_at, d.last_activity_at, d.updated_at, d.created_at) DESC NULLS LAST
  `);

  return { projects: ((result as any).rows ?? result).map(mapFieldProject) };
}

export async function starFieldProject(tenantDb: TenantDb, access: FieldAccessContext, dealId: string) {
  await assertActiveFieldProject(tenantDb, access, dealId);
  await tenantDb.execute(sql`
    INSERT INTO field_user_starred_projects (user_id, deal_id)
    VALUES (${access.userId}::uuid, ${dealId}::uuid)
    ON CONFLICT (user_id, deal_id) DO NOTHING
  `);
  return { starred: true };
}

export async function unstarFieldProject(tenantDb: TenantDb, access: FieldAccessContext, dealId: string) {
  await tenantDb.execute(sql`
    DELETE FROM field_user_starred_projects
    WHERE user_id = ${access.userId}::uuid AND deal_id = ${dealId}::uuid
  `);
  return { starred: false };
}

// `access` is retained for signature stability but the field surface is UNSCOPED by rep (see note
// above) — the direct active-project query below is the sole gate (existence + is_active + non-terminal),
// so a rep can open ANY active project, not just assigned ones. We deliberately do NOT route through the
// rep-scoped getDealById (which 403s a non-owned deal for role "rep").
export async function assertActiveFieldProject(tenantDb: TenantDb, _access: FieldAccessContext, dealId: string): Promise<FieldProject> {
  const result = await tenantDb.execute(sql`
    SELECT
      d.id,
      d.name,
      d.deal_number,
      d.project_number,
      d.name AS property_name,
      NULLIF(CONCAT_WS(', ', NULLIF(d.property_address, ''), NULLIF(d.property_city, ''), NULLIF(d.property_state, ''), NULLIF(d.property_zip, '')), '') AS property_address,
      COALESCE(psc.name, d.bid_board_stage_slug, 'Active') AS stage_name,
      COALESCE(d.last_activity_at, d.updated_at, d.created_at) AS last_activity_at,
      0::int AS photo_count,
      false AS starred
    FROM deals d
    LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE d.id = ${dealId}::uuid
      AND ${activeProjectWhere()}
    LIMIT 1
  `);
  const row = ((result as any).rows ?? result)[0];
  if (!row) throw new AppError(404, "Project not found");
  return mapFieldProject(row);
}

export async function assertAccessibleFieldCaptureTarget(
  tenantDb: TenantDb,
  input: { dealId?: string; leadId?: string; opportunityId?: string; userRole: UserRole; userId: string }
) {
  if ((input.dealId ? 1 : 0) + (input.leadId ? 1 : 0) + (input.opportunityId ? 1 : 0) !== 1) {
    throw new AppError(400, "Exactly one capture target must be provided.");
  }

  // The capture-target picker is intentionally UNSCOPED (see searchPhotoUploadTargets
  // and .audit/trockcam-leads-not-returning.md): any rep may attach photos to ANY
  // active lead/deal/opportunity, so this gate checks existence + active only — NOT
  // ownership. (getDealById/getLeadById 403 a non-owned record for role "rep", which
  // would let a rep FIND a lead in search but fail to open/attach it.) input.userRole/
  // input.userId are accepted for signature stability but deliberately NOT used here.
  if (input.opportunityId) {
    const [opportunity] = await tenantDb
      .select({ id: deals.id, isActive: deals.isActive, pipelineDisposition: deals.pipelineDisposition })
      .from(deals)
      .where(eq(deals.id, input.opportunityId))
      .limit(1);
    if (!opportunity || !opportunity.isActive || opportunity.pipelineDisposition !== "opportunity") {
      throw new AppError(404, "Capture target not found");
    }
    return { id: opportunity.id, type: "opportunity" as const };
  }

  if (input.dealId) {
    const [deal] = await tenantDb
      .select({ id: deals.id, isActive: deals.isActive })
      .from(deals)
      .where(eq(deals.id, input.dealId))
      .limit(1);
    if (!deal || !deal.isActive) {
      throw new AppError(404, "Capture target not found");
    }
    return { id: deal.id, type: "deal" as const };
  }

  const [lead] = await tenantDb
    .select({ id: leads.id, isActive: leads.isActive })
    .from(leads)
    .where(eq(leads.id, input.leadId!))
    .limit(1);
  if (!lead || !lead.isActive) {
    throw new AppError(404, "Capture target not found");
  }
  return { id: lead.id, type: "lead" as const };
}

/**
 * SCOPED twin of assertAccessibleFieldCaptureTarget. The capture-target PICKER is
 * company-wide (unscoped), but callers that authorize access to an EXISTING photo's
 * record — transcription and tag edits via getAccessibleFieldPhoto — must stay
 * rep-owned, so a rep can't transcribe/retag photos on another rep's record. A rep
 * may only touch records they own; non-rep roles (admin/director) are unrestricted.
 * Existence + is_active are still required. See .audit/trockcam-leads-not-returning.md.
 */
export async function assertScopedCaptureTargetAccess(
  tenantDb: TenantDb,
  input: { dealId?: string; leadId?: string; opportunityId?: string; userRole: UserRole; userId: string }
): Promise<void> {
  if ((input.dealId ? 1 : 0) + (input.leadId ? 1 : 0) + (input.opportunityId ? 1 : 0) !== 1) {
    throw new AppError(400, "Exactly one capture target must be provided.");
  }
  const assertOwnedByRep = (assignedRepId: string | null) => {
    if (input.userRole === "rep" && assignedRepId !== input.userId) {
      throw new AppError(403, "You can only access your own records");
    }
  };

  if (input.opportunityId) {
    const [opportunity] = await tenantDb
      .select({ isActive: deals.isActive, disposition: deals.pipelineDisposition, assignedRepId: deals.assignedRepId })
      .from(deals)
      .where(eq(deals.id, input.opportunityId))
      .limit(1);
    if (!opportunity || !opportunity.isActive || opportunity.disposition !== "opportunity") {
      throw new AppError(404, "Capture target not found");
    }
    assertOwnedByRep(opportunity.assignedRepId);
    return;
  }

  if (input.dealId) {
    const [deal] = await tenantDb
      .select({ isActive: deals.isActive, assignedRepId: deals.assignedRepId })
      .from(deals)
      .where(eq(deals.id, input.dealId))
      .limit(1);
    if (!deal || !deal.isActive) {
      throw new AppError(404, "Capture target not found");
    }
    assertOwnedByRep(deal.assignedRepId);
    return;
  }

  const [lead] = await tenantDb
    .select({ isActive: leads.isActive, assignedRepId: leads.assignedRepId })
    .from(leads)
    .where(eq(leads.id, input.leadId!))
    .limit(1);
  if (!lead || !lead.isActive) {
    throw new AppError(404, "Capture target not found");
  }
  assertOwnedByRep(lead.assignedRepId);
}

function safePhoto(photo: any, imageUrl: string | null): FieldPhoto {
  return {
    id: photo.id,
    category: "photo",
    photoCategory: photo.photoCategory ?? null,
    subcategory: photo.subcategory ?? null,
    displayName: photo.displayName,
    mimeType: photo.mimeType,
    fileSizeBytes: photo.fileSizeBytes ?? null,
    fileExtension: photo.fileExtension ?? null,
    dealId: photo.dealId ?? null,
    leadId: photo.leadId ?? null,
    description: photo.description ?? null,
    tags: Array.isArray(photo.tags) ? photo.tags : [],
    takenAt: iso(photo.takenAt),
    createdAt: iso(photo.createdAt)!,
    uploadedBy: photo.uploadedBy,
    uploaderName: photo.uploaderName,
    uploaderAvatarUrl: photo.uploaderAvatarUrl ?? null,
    latitude: photo.latitude ?? null,
    longitude: photo.longitude ?? null,
    address: photo.address ?? null,
    addressSource: photo.addressSource ?? null,
    geocodedAt: iso(photo.geocodedAt),
    procoreSyncStatus: photo.procoreSyncStatus ?? null,
    deletedAt: iso(photo.deletedAt),
    imageUrl,
  };
}

export async function listFieldProjectPhotos(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  dealId: string,
  filters: DealPhotoTimelineFilters = {}
) {
  await assertActiveFieldProject(tenantDb, access, dealId);
  const result = await getDealPhotoTimeline(tenantDb, dealId, 1, 200, filters);
  const photos = await Promise.all(result.photos.map(async (photo) => {
    const imageUrl = photo.externalThumbnailUrl
      ?? photo.externalUrl
      ?? (photo.r2Key ? (await buildFileDownloadUrlFromRecord(photo)).url : null);
    return safePhoto(photo, imageUrl);
  }));
  return { photos, pagination: result.pagination };
}

export async function searchFieldCaptureTargets(
  tenantDb: TenantDb,
  _access: FieldAccessContext,
  input: { search?: string; limit?: number } = {}
) {
  // The field/TrockCam capture-target picker is intentionally UNSCOPED: any rep must
  // be able to find ANY lead/deal to attach photos to, so we do NOT forward the
  // rep identity into searchPhotoUploadTargets (forwarding it rep-scoped the search
  // and hid every non-owned lead). See .audit/trockcam-leads-not-returning.md.
  return searchPhotoUploadTargets(tenantDb, {
    search: input.search,
    limit: input.limit,
  });
}

export type FieldCaptureTarget = PhotoUploadTarget & OfficeTag;

const CAPTURE_TARGET_TYPE_RANK: Record<PhotoUploadTarget["type"], number> = { lead: 0, opportunity: 1, deal: 2 };

function captureTargetUpdatedMs(value: Date | string): number {
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Merge per-office capture-target search results into ONE company-wide list (finding #3): stamp each
 * target with its owning office, preserve the single-office type grouping (lead → opportunity → deal),
 * order by recency (cross-office-comparable) within a type with a stable id tiebreak, and apply ONE
 * GLOBAL limit — NOT limit-per-office, which would return up to limit×officeCount rows.
 */
export function mergeFieldCaptureTargets(
  perOffice: Array<{ office: FieldOffice; targets: PhotoUploadTarget[] }>,
  limit: number,
): FieldCaptureTarget[] {
  const stamped: FieldCaptureTarget[] = perOffice.flatMap(({ office, targets }) =>
    targets.map((target) => ({ ...target, ...officeTag(office) })),
  );
  stamped.sort((left, right) => {
    const rankDelta = CAPTURE_TARGET_TYPE_RANK[left.type] - CAPTURE_TARGET_TYPE_RANK[right.type];
    if (rankDelta !== 0) return rankDelta;
    const recencyDelta = captureTargetUpdatedMs(right.lastUpdatedAt) - captureTargetUpdatedMs(left.lastUpdatedAt);
    if (recencyDelta !== 0) return recencyDelta;
    return left.id.localeCompare(right.id);
  });
  return stamped.slice(0, Math.max(0, limit));
}
