import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { getAllProjects, getProjectPhotos, type CCPhoto } from "../server/src/modules/companycam/client.js";
import { isR2Configured, putObject } from "../server/src/lib/r2-client.js";
import { buildCompanyCamImportPlan, type DealForCompanyCamPlan } from "./companycam-inventory.js";

const DEFAULT_TENANT = "office_dallas";

interface Options {
  tenant: string;
  execute: boolean;
  allowBulkExecute: boolean;
  projectId?: string;
  limit?: number;
}

function quoteIdent(value: string): string {
  if (!/^office_[a-z0-9_]+$/.test(value)) throw new Error(`Invalid tenant schema: ${value}`);
  return `"${value.replace(/"/g, '""')}"`;
}

function getConnectionString() {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  if (selected.includes("railway.internal") && !process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_PROJECT_ID) {
    throw new Error("Use DATABASE_PUBLIC_URL or railway run.");
  }
  return selected;
}

function parseArgs(argv: string[]): Options {
  const limitArg = argv.find((arg) => arg.startsWith("--limit="))?.split("=").slice(1).join("=");
  return {
    tenant: argv.find((arg) => arg.startsWith("--tenant="))?.split("=").slice(1).join("=") || DEFAULT_TENANT,
    execute: argv.includes("--execute"),
    allowBulkExecute: argv.includes("--allow-bulk-execute"),
    projectId: argv.find((arg) => arg.startsWith("--project-id="))?.split("=").slice(1).join("="),
    limit: limitArg ? Number(limitArg) : undefined,
  };
}

export function validateCompanyCamImportOptions(options: Options) {
  if (options.execute && !options.projectId && !options.limit && !options.allowBulkExecute) {
    throw new Error("--execute requires --project-id, --limit, or --allow-bulk-execute.");
  }
}

async function loadDeals(client: pg.Client, tenant: string): Promise<DealForCompanyCamPlan[]> {
  const schema = quoteIdent(tenant);
  const { rows } = await client.query(`
    SELECT id::text, name, deal_number, project_number, companycam_project_id
    FROM ${schema}.deals
    WHERE is_active = true
  `);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    dealNumber: row.deal_number,
    projectNumber: row.project_number,
    companycamProjectId: row.companycam_project_id,
  }));
}

async function getImportUserId(client: pg.Client) {
  if (process.env.COMPANYCAM_IMPORT_USER_ID) return process.env.COMPANYCAM_IMPORT_USER_ID;
  const { rows } = await client.query(`
    SELECT id::text
    FROM public.users
    WHERE is_active = true AND role IN ('admin', 'director')
    ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at
    LIMIT 1
  `);
  if (!rows[0]?.id) throw new Error("No active admin/director user found. Set COMPANYCAM_IMPORT_USER_ID.");
  return rows[0].id;
}

function bestUrl(photo: CCPhoto) {
  const original = photo.uris.find((uri) => uri.type === "original")?.uri ?? photo.uris.find((uri) => uri.type === "web")?.uri;
  const thumbnail = photo.uris.find((uri) => uri.type === "thumbnail")?.uri ?? photo.uris.find((uri) => uri.type === "web")?.uri ?? null;
  return { original, thumbnail };
}

async function download(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType };
}

function extension(contentType: string) {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("heic")) return ".heic";
  return ".jpg";
}

async function importPhoto(input: {
  client: pg.Client;
  tenant: string;
  projectId: string;
  projectName: string;
  dealId: string;
  dealNumber: string | null;
  photo: CCPhoto;
  userId: string;
  execute: boolean;
}) {
  const schema = quoteIdent(input.tenant);
  const existing = await input.client.query(
    `SELECT id FROM ${schema}.files WHERE companycam_photo_id = $1 LIMIT 1`,
    [input.photo.id]
  );
  if (existing.rows.length > 0) return { imported: false, skipped: true };
  if (!input.execute) return { imported: false, skipped: false };
  const { original, thumbnail } = bestUrl(input.photo);
  if (!original) throw new Error(`CompanyCam photo ${input.photo.id} has no original/web URL`);
  const capturedAt = input.photo.captured_at ? new Date(input.photo.captured_at * 1000) : new Date(input.photo.created_at * 1000);
  const date = capturedAt.toISOString().slice(0, 10);
  let fileSizeBytes = 0;
  let mimeType = "image/jpeg";
  let ext = ".jpg";
  let r2Key = `companycam/reference/${input.photo.id}.jpg`;
  const bucket = process.env.R2_BUCKET_NAME || "trock-crm-files";
  if (isR2Configured()) {
    const image = await download(original);
    fileSizeBytes = image.buffer.length;
    mimeType = image.contentType;
    ext = extension(mimeType);
    r2Key = `office_${input.tenant.replace(/^office_/, "")}/deals/${input.dealNumber ?? input.dealId}/photos/companycam_${input.photo.id}${ext}`;
    await putObject(r2Key, image.buffer, mimeType);
  }
  const systemFilename = `${input.dealNumber ?? input.dealId}_CompanyCam_${date}_${crypto.randomUUID().slice(0, 8)}${ext}`;
  const metadata = {
    companycamProjectId: input.projectId,
    companycamProjectName: input.projectName,
    companycamPhotoUrl: input.photo.photo_url,
    photographer: input.photo.creator_name,
    hash: input.photo.hash,
  };
  const inserted = await input.client.query(
    `
      INSERT INTO ${schema}.files (
        category, subcategory, folder_path, tags, display_name, system_filename, original_filename,
        mime_type, file_size_bytes, file_extension, r2_key, r2_bucket, external_url, external_thumbnail_url,
        companycam_photo_id, deal_id, description, notes, taken_at, geo_lat, geo_lng, uploaded_by
      )
      VALUES (
        'photo', 'CompanyCam', $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11, $12,
        $13, $14::uuid, $15, $16, $17, $18, $19, $20::uuid
      )
      ON CONFLICT (r2_key) DO NOTHING
      RETURNING id::text
    `,
    [
      `Photos/CompanyCam/${capturedAt.toISOString().slice(0, 7)}`,
      ["companycam", input.projectName],
      `${input.dealNumber ?? "Deal"} CompanyCam ${date} ${input.photo.id.slice(-6)}`,
      systemFilename,
      `companycam_${input.photo.id}${ext}`,
      mimeType,
      fileSizeBytes,
      ext,
      r2Key,
      bucket,
      original,
      thumbnail,
      input.photo.id,
      input.dealId,
      input.photo.description,
      JSON.stringify(metadata),
      capturedAt,
      input.photo.coordinates?.lat ? String(input.photo.coordinates.lat) : null,
      input.photo.coordinates?.lon ? String(input.photo.coordinates.lon) : null,
      input.userId,
    ]
  );
  const fileId = inserted.rows[0]?.id;
  if (fileId) {
    await input.client.query(
      `
        INSERT INTO ${schema}.file_links (file_id, entity_type, entity_id, created_by)
        VALUES ($1::uuid, 'deal', $2::uuid, $3::uuid)
        ON CONFLICT DO NOTHING
      `,
      [fileId, input.dealId, input.userId]
    );
  }
  await input.client.query(
    `
      INSERT INTO ${schema}.companycam_import_state
        (companycam_project_id, companycam_photo_id, deal_id, status, imported_at, metadata)
      VALUES ($1, $2, $3::uuid, 'imported', now(), $4::jsonb)
      ON CONFLICT (companycam_photo_id)
      DO UPDATE SET status = 'imported', imported_at = now(), deal_id = EXCLUDED.deal_id, metadata = EXCLUDED.metadata, updated_at = now()
    `,
    [input.projectId, input.photo.id, input.dealId, JSON.stringify(metadata)]
  );
  return { imported: Boolean(fileId), skipped: false };
}

export async function runCompanyCamImport(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  validateCompanyCamImportOptions(options);
  const client = new pg.Client({ connectionString: getConnectionString() });
  await client.connect();
  try {
    const [projects, deals] = await Promise.all([getAllProjects(), loadDeals(client, options.tenant)]);
    const plan = buildCompanyCamImportPlan(
      projects.map((project) => ({ id: project.id, name: project.name, photoCount: project.photo_count ?? 0 })),
      deals
    );
    const userId = options.execute ? await getImportUserId(client) : "dry-run";
    const rows = plan.rows
      .filter((row) => row.matchedDealId && row.confidence >= 0.9)
      .filter((row) => !options.projectId || row.companyCamProjectId === options.projectId)
      .slice(0, options.limit);
    let imported = 0;
    let skipped = 0;
    for (const row of rows) {
      const deal = deals.find((candidate) => candidate.id === row.matchedDealId);
      if (!deal || !row.matchedDealId) continue;
      await client.query("BEGIN");
      try {
        if (options.execute) {
          await client.query(
            `UPDATE ${quoteIdent(options.tenant)}.deals SET companycam_project_id = $1 WHERE id = $2::uuid AND companycam_project_id IS DISTINCT FROM $1`,
            [row.companyCamProjectId, row.matchedDealId]
          );
        }
        const photos = await getProjectPhotos(row.companyCamProjectId);
        for (const photo of photos) {
          const result = await importPhoto({
            client,
            tenant: options.tenant,
            projectId: row.companyCamProjectId,
            projectName: row.companyCamProjectName,
            dealId: row.matchedDealId,
            dealNumber: deal.dealNumber,
            photo,
            userId,
            execute: options.execute,
          });
          if (result.imported) imported += 1;
          if (result.skipped) skipped += 1;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    console.log(JSON.stringify({
      tenant: options.tenant,
      dryRun: !options.execute,
      projectsConsidered: rows.length,
      imported,
      skippedExisting: skipped,
      fullRunRecommendation: plan.totals.totalPhotos > 10_000 ? "defer_full_run_post_go_live" : "eligible_after_pilot",
    }, null, 2));
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runCompanyCamImport().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
