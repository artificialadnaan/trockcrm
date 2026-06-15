import crypto from "node:crypto";
import { pool } from "../db.js";

const PROCORE_BASE_URL = "https://api.procore.com";
const PHOTO_LINK_TITLE = "T Rock Photos";
const PROCORE_PHOTO_CONCURRENCY = 3;

const SERVER_R2_MODULES = [
  "../../../server/dist/lib/r2-client.js",
  "../../../server/src/lib/r2-client.js",
] as const;

async function importFirstAvailable<T>(paths: readonly string[]): Promise<T> {
  let lastError: unknown;
  for (const path of paths) {
    try {
      return (await import(path)) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to import server module");
}

function isPhotosPushEnabled(): boolean {
  return process.env.PROCORE_PHOTOS_PUSH_ENABLED === "true";
}

function isLinkCreationEnabled(): boolean {
  return process.env.PROCORE_LINK_CREATION_ENABLED === "true";
}

function publicViewerBaseUrl(): string {
  // Mirror server/src/modules/public-photo-tokens/public-share-url.ts precedence so Procore-minted /p
  // links use the same branded, same-origin host as admin/field shares: PUBLIC_SHARE_BASE_URL, then
  // FRONTEND_URL, then localhost.
  return (process.env.PUBLIC_SHARE_BASE_URL?.trim() || process.env.FRONTEND_URL?.trim() || "http://localhost:5173").replace(/\/+$/, "");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

let workerCachedToken: { value: string; expiresAt: number } | null = null;

function isDevMode(): boolean {
  return !process.env.PROCORE_CLIENT_ID || !process.env.PROCORE_CLIENT_SECRET;
}

async function getWorkerProcoreToken(): Promise<string> {
  if (isDevMode()) return "dev-mock-token";
  if (workerCachedToken && workerCachedToken.expiresAt - Date.now() > 60_000) {
    return workerCachedToken.value;
  }
  const res = await fetch(`${PROCORE_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: process.env.PROCORE_CLIENT_ID,
      client_secret: process.env.PROCORE_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`[Procore:photos] Token fetch failed: ${res.status}`);
  const data = await res.json();
  workerCachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return workerCachedToken.value;
}

async function procoreJson<T = any>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  if (isDevMode()) {
    if (path.includes("/links/bulk_update")) return [{ id: Math.floor(Math.random() * 900000) + 100000 }] as T;
    if (path.includes("/image_categories")) return { id: Math.floor(Math.random() * 900000) + 100000, name: PHOTO_LINK_TITLE } as T;
    return { id: Math.floor(Math.random() * 900000) + 100000 } as T;
  }
  const token = await getWorkerProcoreToken();
  const companyId = process.env.PROCORE_COMPANY_ID;
  if (!companyId) throw new Error("PROCORE_COMPANY_ID must be set");
  const res = await fetch(`${PROCORE_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Procore-Company-Id": companyId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const error = new Error(`[Procore:photos] ${method} ${path} failed: ${res.status} ${text}`);
    (error as any).status = res.status;
    throw error;
  }
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

async function procoreMultipart<T = any>(path: string, form: FormData): Promise<T> {
  if (isDevMode()) return { id: Math.floor(Math.random() * 900000) + 100000 } as T;
  const token = await getWorkerProcoreToken();
  const companyId = process.env.PROCORE_COMPANY_ID;
  if (!companyId) throw new Error("PROCORE_COMPANY_ID must be set");
  const res = await fetch(`${PROCORE_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Procore-Company-Id": companyId,
    },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const error = new Error(`[Procore:photos] POST ${path} failed: ${res.status} ${text}`);
    (error as any).status = res.status;
    throw error;
  }
  return res.json() as Promise<T>;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function resolveSchemaForOffice(officeId: string) {
  const result = await pool.query(
    "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true LIMIT 1",
    [officeId]
  );
  const slug = result.rows[0]?.slug;
  if (!slug || !/^[a-z][a-z0-9_]*$/.test(slug)) {
    throw new Error(`Unable to resolve office schema for ${officeId}`);
  }
  return `office_${slug}`;
}

export async function ensurePublicPhotoLinkForDeal(input: {
  officeId: string;
  schemaName: string;
  dealId: string;
  createdByUserId?: string | null;
}): Promise<boolean> {
  if (!isLinkCreationEnabled()) {
    console.log(`[Procore:photos] Link creation disabled; skipping public photo link for deal ${input.dealId}`);
    return false;
  }
  const companyId = process.env.PROCORE_COMPANY_ID;
  if (!companyId) throw new Error("PROCORE_COMPANY_ID must be set");

  const client = await pool.connect();
  try {
    const dealResult = await client.query(
      `SELECT id, procore_project_id, procore_photo_link_id, procore_photo_link_status
       FROM ${input.schemaName}.deals
       WHERE id = $1
       LIMIT 1`,
      [input.dealId]
    );
    const deal = dealResult.rows[0];
    if (!deal?.procore_project_id) return false;
    if (deal.procore_photo_link_id && deal.procore_photo_link_status === "created") return true;

    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashToken(rawToken);
    const createdBy = input.createdByUserId ?? (await resolveFallbackAdminUser(input.officeId));
    await client.query(
      `INSERT INTO public.public_photo_tokens (token, deal_id, tenant_id, created_by_user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO NOTHING`,
      [tokenHash, input.dealId, input.officeId, createdBy]
    );
    const url = `${publicViewerBaseUrl()}/p/${encodeURIComponent(rawToken)}`;
    try {
      const links = await procoreJson<any>(
        "PATCH",
        `/rest/v2.0/companies/${companyId}/projects/${deal.procore_project_id}/links/bulk_update`,
        [{ id: deal.procore_photo_link_id ?? undefined, title: PHOTO_LINK_TITLE, url }]
      );
      // Procore's bulk_update returns the links wrapped as { data: [...] }; a bare array is also
      // tolerated. Read both — otherwise the link id isn't captured, procore_photo_link_id stays
      // null, the early-return above never fires, and every re-run (real SyncHub relays cause these)
      // appends a duplicate "T Rock Photos" link + mints a new token instead of updating in place.
      const linkArray = Array.isArray(links) ? links : links?.data;
      const linkId = Array.isArray(linkArray) ? linkArray[0]?.id : undefined;
      await client.query(
        `UPDATE ${input.schemaName}.deals
         SET procore_photo_link_id = $1,
             procore_photo_link_status = 'created',
             updated_at = NOW()
         WHERE id = $2`,
        [linkId ?? null, input.dealId]
      );
      console.log(`[Procore:photos] Created public photo link for deal ${input.dealId}`);
      return true;
    } catch (error: any) {
      const status = error?.status === 403 ? "permission_denied" : "failed";
      await client.query(
        `UPDATE ${input.schemaName}.deals
         SET procore_photo_link_status = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [status, input.dealId]
      );
      console.error(`[Procore:photos] Failed to create project link for deal ${input.dealId}:`, error);
      if (status !== "permission_denied") throw error;
      return false;
    }
  } finally {
    client.release();
  }
}

async function resolveFallbackAdminUser(officeId: string): Promise<string> {
  const result = await pool.query(
    `SELECT id FROM public.users
     WHERE office_id = $1 AND is_active = true AND role IN ('admin', 'director')
     ORDER BY created_at ASC
     LIMIT 1`,
    [officeId]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`No admin/director user available for office ${officeId}`);
  return id;
}

async function ensureImageCategory(client: any, schemaName: string, dealId: string, projectId: number): Promise<number> {
  const dealResult = await client.query(
    `SELECT procore_image_category_id FROM ${schemaName}.deals WHERE id = $1 LIMIT 1`,
    [dealId]
  );
  const existing = dealResult.rows[0]?.procore_image_category_id;
  if (existing) return Number(existing);

  const categories = await procoreJson<any[]>(
    "GET",
    `/rest/v1.0/image_categories?project_id=${encodeURIComponent(String(projectId))}&per_page=100`
  );
  const found = Array.isArray(categories)
    ? categories.find((category) => category.name === PHOTO_LINK_TITLE)
    : null;
  const category = found ?? await procoreJson<any>(
    "POST",
    `/rest/v1.0/image_categories?project_id=${encodeURIComponent(String(projectId))}`,
    { image_category: { name: PHOTO_LINK_TITLE, private: false } }
  );
  const categoryId = Number(category.id);
  await client.query(
    `UPDATE ${schemaName}.deals
     SET procore_image_category_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [categoryId, dealId]
  );
  return categoryId;
}

export async function ensureTRockPhotosAlbumForDeal(input: {
  officeId: string;
  schemaName: string;
  dealId: string;
}): Promise<boolean> {
  if (!isPhotosPushEnabled()) {
    console.log(`[Procore:photos] Photos push disabled; skipping image category creation for deal ${input.dealId}`);
    return false;
  }

  const client = await pool.connect();
  try {
    const dealResult = await client.query(
      `SELECT id, procore_project_id
       FROM ${input.schemaName}.deals
       WHERE id = $1
       LIMIT 1`,
      [input.dealId]
    );
    const deal = dealResult.rows[0];
    if (!deal?.procore_project_id) return false;
    await ensureImageCategory(client, input.schemaName, input.dealId, Number(deal.procore_project_id));
    return true;
  } finally {
    client.release();
  }
}

async function loadPhotoBytes(photo: any): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const filename = `${photo.display_name}${photo.file_extension ?? ""}`;
  if (photo.external_url) {
    const res = await fetch(photo.external_url);
    if (!res.ok) throw new Error(`Failed to download external photo ${photo.id}: ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: res.headers.get("content-type") ?? photo.mime_type ?? "image/jpeg",
      filename,
    };
  }
  const { getObjectBuffer } = await importFirstAvailable<{
    getObjectBuffer: (r2Key: string) => Promise<{ buffer: Buffer; contentType?: string }>;
  }>(SERVER_R2_MODULES);
  const object = await getObjectBuffer(photo.r2_key);
  return {
    buffer: object.buffer,
    contentType: object.contentType ?? photo.mime_type ?? "image/jpeg",
    filename,
  };
}

async function syncOnePhoto(input: {
  client: any;
  schemaName: string;
  officeId: string;
  dealId: string;
  projectId: number;
  categoryId: number;
  photo: any;
}): Promise<void> {
  if (input.photo.procore_sync_status === "synced" && input.photo.procore_photo_id) return;
  await input.client.query(
    `UPDATE ${input.schemaName}.files
     SET procore_sync_status = 'pending', updated_at = NOW()
     WHERE id = $1`,
    [input.photo.id]
  );
  try {
    if (!isPhotosPushEnabled()) {
      console.log(`[Procore:photos] Photos push disabled; leaving photo ${input.photo.id} pending`);
      return;
    }
    const file = await loadPhotoBytes(input.photo);
    const form = new FormData();
    form.append("image[image_category_id]", String(input.categoryId));
    if (input.photo.description) form.append("image[description]", String(input.photo.description));
    form.append("image[data]", new Blob([new Uint8Array(file.buffer)], { type: file.contentType }), file.filename);
    const result = await procoreMultipart<any>(
      `/rest/v1.0/images?project_id=${encodeURIComponent(String(input.projectId))}`,
      form
    );
    const procorePhotoId = String(result.id);
    await input.client.query(
      `UPDATE ${input.schemaName}.files
       SET procore_sync_status = 'synced',
           procore_photo_id = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [procorePhotoId, input.photo.id]
    );
    await input.client.query(
      `INSERT INTO ${input.schemaName}.photo_audit_log
         (photo_id, event_type, user_id, metadata)
       VALUES ($1, 'procore_synced', $2, $3::jsonb)`,
      [input.photo.id, input.photo.uploaded_by, JSON.stringify({ procorePhotoId, projectId: input.projectId })]
    );
  } catch (error) {
    await input.client.query(
      `UPDATE ${input.schemaName}.files
       SET procore_sync_status = 'failed',
           updated_at = NOW()
       WHERE id = $1`,
      [input.photo.id]
    );
    await input.client.query(
      `INSERT INTO ${input.schemaName}.photo_audit_log
         (photo_id, event_type, user_id, metadata)
       VALUES ($1, 'procore_sync_failed', $2, $3::jsonb)`,
      [input.photo.id, input.photo.uploaded_by, JSON.stringify({ error: error instanceof Error ? error.message : String(error) })]
    );
    throw error;
  }
}

export async function handleProcorePhotoSyncJob(payload: any, officeIdFromJob: string | null): Promise<void> {
  const officeId = payload.officeId ?? officeIdFromJob;
  if (!officeId) throw new Error("officeId is required for procore_photo_sync");
  const schemaName = await resolveSchemaForOffice(officeId);
  const client = await pool.connect();
  try {
    const dealId = payload.dealId;
    const photoId = payload.photoId ?? null;
    const dealResult = await client.query(
      `SELECT id, procore_project_id
       FROM ${schemaName}.deals
       WHERE id = $1
       LIMIT 1`,
      [dealId]
    );
    const deal = dealResult.rows[0];
    if (!deal?.procore_project_id) {
      console.log(`[Procore:photos] Deal ${dealId} has no Procore project; skipping`);
      return;
    }
    if (!isPhotosPushEnabled()) {
      console.log(`[Procore:photos] Photos push disabled; skipping sync for deal ${dealId}`);
      return;
    }

    const projectId = Number(deal.procore_project_id);
    const categoryId = await ensureImageCategory(client, schemaName, dealId, projectId);

    const photoResult = await client.query(
      `SELECT id, display_name, file_extension, mime_type, r2_key, external_url,
              description, uploaded_by, procore_sync_status, procore_photo_id
       FROM ${schemaName}.files
       WHERE deal_id = $1
         AND category = 'photo'
         AND deleted_at IS NULL
         AND is_active = true
         ${photoId ? "AND id = $2" : ""}
       ORDER BY created_at ASC`,
      photoId ? [dealId, photoId] : [dealId]
    );

    await mapWithConcurrency(photoResult.rows, PROCORE_PHOTO_CONCURRENCY, async (photo) => {
      await syncOnePhoto({
        client,
        schemaName,
        officeId,
        dealId,
        projectId,
        categoryId,
        photo,
      });
    });
  } finally {
    client.release();
  }
}

export async function enqueueProcorePhotoBatch(input: { officeId: string; dealId: string }) {
  await pool.query(
    `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after, max_attempts)
     VALUES ('procore_photo_sync', $1::jsonb, $2::uuid, 'pending', NOW(), 3)`,
    [JSON.stringify({ action: "batch", dealId: input.dealId, officeId: input.officeId }), input.officeId]
  );
}

export async function enqueueProcorePhotoSingle(input: { officeId: string; dealId: string; photoId: string }) {
  await pool.query(
    `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after, max_attempts)
     VALUES ('procore_photo_sync', $1::jsonb, $2::uuid, 'pending', NOW(), 3)`,
    [JSON.stringify({ action: "single", dealId: input.dealId, photoId: input.photoId, officeId: input.officeId }), input.officeId]
  );
}
