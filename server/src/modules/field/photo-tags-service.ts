import { and, desc, eq, ilike, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { files, photoTags } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { UserRole } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { updateFile } from "../files/service.js";
import { assertActiveFieldProject } from "./projects-service.js";
import { getAccessibleFieldPhoto } from "./photo-transcription-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type FieldTagAccessContext = {
  userId: string;
  userRole: UserRole;
};

function normalizeTag(raw: string) {
  return raw.trim().replace(/\s+/g, " ");
}

function normalizeTags(values: string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const tag = normalizeTag(value);
    if (!tag) continue;
    if (tag.length > 100) {
      throw new AppError(400, "Tags must be 100 characters or fewer.");
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }
  return normalized;
}

export async function replaceFieldPhotoTags(
  tenantDb: TenantDb,
  access: FieldTagAccessContext,
  input: {
    photoId: string;
    tags: string[];
  }
) {
  const photo = await getAccessibleFieldPhoto(tenantDb, access, input.photoId);
  const tags = normalizeTags(input.tags);

  await tenantDb.delete(photoTags).where(eq(photoTags.photoId, photo.id));
  if (tags.length > 0) {
    await tenantDb.insert(photoTags).values(tags.map((tag) => ({
      photoId: photo.id,
      tag,
      createdByUserId: access.userId,
    })));
  }

  await updateFile(tenantDb, photo.id, { tags });
  return { tags };
}

export async function deleteFieldPhotoTag(
  tenantDb: TenantDb,
  access: FieldTagAccessContext,
  input: {
    photoId: string;
    tag: string;
  }
) {
  const photo = await getAccessibleFieldPhoto(tenantDb, access, input.photoId);
  const tag = normalizeTag(input.tag);
  if (!tag) throw new AppError(400, "tag is required.");

  const nextTags = Array.isArray(photo.tags)
    ? photo.tags.filter((value: string) => value.toLowerCase() !== tag.toLowerCase())
    : [];

  await tenantDb.delete(photoTags).where(and(
    eq(photoTags.photoId, photo.id),
    sql`LOWER(${photoTags.tag}) = LOWER(${tag})`
  ));
  await updateFile(tenantDb, photo.id, { tags: nextTags });
  return { tags: nextTags };
}

export async function searchFieldProjectTags(
  tenantDb: TenantDb,
  access: FieldTagAccessContext,
  input: {
    projectId: string;
    query?: string;
    limit?: number;
  }
) {
  await assertActiveFieldProject(tenantDb, access, input.projectId);
  const search = input.query?.trim();
  const limit = Math.min(Math.max(1, input.limit ?? 10), 25);

  const result = await tenantDb
    .select({
      tag: photoTags.tag,
      createdAt: photoTags.createdAt,
    })
    .from(photoTags)
    .innerJoin(files, eq(files.id, photoTags.photoId))
    .where(and(
      eq(files.dealId, input.projectId),
      eq(files.isActive, true),
      eq(files.category, "photo"),
      search ? ilike(photoTags.tag, `${search}%`) : undefined
    ))
    .orderBy(desc(photoTags.createdAt))
    .limit(limit * 5);

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const row of result) {
    const key = row.tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(row.tag);
    if (tags.length >= limit) break;
  }

  return { tags };
}
