import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import type { UserRole } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { getDealPhotoTimeline, getFileDownloadUrl, searchPhotoUploadTargets } from "../files/service.js";
import type { DealPhotoTimelineFilters } from "../files/photo-timeline-filters.js";
import { getDealById } from "../deals/service.js";
import { getLeadById } from "../leads/service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type FieldAccessContext = {
  userId: string;
  userRole: UserRole;
};

const TERMINAL_FIELD_STAGE_SLUGS = [
  "won",
  "lost",
  "sent_to_production",
  "service_sent_to_production",
  "closed_won",
  "closed_lost",
  "production_lost",
  "service_lost",
] as const;

const textArray = (values: readonly string[]) => sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;

export type FieldProject = {
  id: string;
  name: string;
  dealNumber: string;
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
    dealNumber: row.deal_number,
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
  return sql`
    d.is_active = true
    AND COALESCE(psc.is_terminal, false) = false
    AND COALESCE(psc.slug, d.bid_board_stage_slug, '') <> ALL(${textArray(TERMINAL_FIELD_STAGE_SLUGS)})
    ${normalizedSearch ? sql`
      AND (
        d.name ILIKE ${`%${normalizedSearch}%`}
        OR d.deal_number ILIKE ${`%${normalizedSearch}%`}
        OR d.property_address ILIKE ${`%${normalizedSearch}%`}
        OR d.property_city ILIKE ${`%${normalizedSearch}%`}
      )
    ` : sql``}
  `;
}

function repDealVisibilityClause(access: FieldAccessContext) {
  return access.userRole === "rep" ? sql`AND d.assigned_rep_id = ${access.userId}::uuid` : sql``;
}

export async function listFieldProjects(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  input: { search?: string; status?: string; page?: number; perPage?: number } = {}
) {
  if (input.status && input.status !== "active") {
    throw new AppError(400, "Only active field projects are supported");
  }
  const page = Math.max(1, input.page ?? 1);
  const perPage = Math.min(100, Math.max(1, input.perPage ?? 50));
  const offset = (page - 1) * perPage;
  const where = activeProjectWhere(input.search);

  const [countResult, rowsResult] = await Promise.all([
    tenantDb.execute(sql`
      SELECT count(*)::int AS total
      FROM deals d
      LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE ${where}
      ${repDealVisibilityClause(access)}
    `),
    tenantDb.execute(sql`
      SELECT
        d.id,
        d.name,
        d.deal_number,
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
      ${repDealVisibilityClause(access)}
      ORDER BY COALESCE(photo_stats.last_photo_at, d.last_activity_at, d.updated_at, d.created_at) DESC NULLS LAST
      LIMIT ${perPage}
      OFFSET ${offset}
    `),
  ]);

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
      ${repDealVisibilityClause(access)}
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

export async function assertActiveFieldProject(tenantDb: TenantDb, access: FieldAccessContext, dealId: string): Promise<FieldProject> {
  const deal = await getDealById(tenantDb, dealId, access.userRole, access.userId);
  if (!deal || !deal.isActive) {
    throw new AppError(404, "Project not found");
  }

  const result = await tenantDb.execute(sql`
    SELECT
      d.id,
      d.name,
      d.deal_number,
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

  if (input.opportunityId) {
    const opportunity = await getDealById(tenantDb, input.opportunityId, input.userRole, input.userId);
    if (!opportunity || !opportunity.isActive || opportunity.pipelineDisposition !== "opportunity") {
      throw new AppError(404, "Capture target not found");
    }
    return { id: opportunity.id, type: "opportunity" as const };
  }

  if (input.dealId) {
    const deal = await getDealById(tenantDb, input.dealId, input.userRole, input.userId);
    if (!deal || !deal.isActive) {
      throw new AppError(404, "Capture target not found");
    }
    return { id: deal.id, type: "deal" as const };
  }

  const lead = await getLeadById(tenantDb, input.leadId!, input.userRole, input.userId);
  if (!lead || !lead.isActive) {
    throw new AppError(404, "Capture target not found");
  }
  return { id: lead.id, type: "lead" as const };
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
    const imageUrl = photo.externalThumbnailUrl ?? photo.externalUrl ?? (await getFileDownloadUrl(tenantDb, photo.id)).url;
    return safePhoto(photo, imageUrl);
  }));
  return { photos, pagination: result.pagination };
}

export async function searchFieldCaptureTargets(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  input: { search?: string; limit?: number } = {}
) {
  return searchPhotoUploadTargets(tenantDb, {
    search: input.search,
    limit: input.limit,
    userId: access.userId,
    userRole: access.userRole,
  });
}
