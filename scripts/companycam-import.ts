import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { getAllProjects, getProjectPhotos, type CCPhoto } from "../server/src/modules/companycam/client.js";
import { isR2Configured, putObject } from "../server/src/lib/r2-client.js";
import { buildCompanyCamImportPlan, type DealForCompanyCamPlan } from "./companycam-inventory.js";
import type { CompanyCamImportPlanRow } from "./companycam-inventory.js";

const DEFAULT_TENANT = "office_dallas";

export interface CompanyCamImportOptions {
  tenant: string;
  execute: boolean;
  allowBulkExecute: boolean;
  strictOneToOne?: boolean;
  projectId?: string;
  limit?: number;
}

export interface CompanyCamMatchConflict {
  matchedDealId: string;
  matchedDealName: string | null;
  keptCompanyCamProjectId: string;
  keptCompanyCamProjectName: string;
  keptConfidence: number;
  droppedCompanyCamProjectId: string;
  droppedCompanyCamProjectName: string;
  droppedConfidence: number;
  reason: string;
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

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`--limit must be a positive integer (got ${value})`);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer (got ${value})`);
  }
  return limit;
}

export function parseCompanyCamImportArgs(argv: string[]): CompanyCamImportOptions {
  const limitArg = argv.find((arg) => arg.startsWith("--limit="))?.split("=").slice(1).join("=");
  return {
    tenant: argv.find((arg) => arg.startsWith("--tenant="))?.split("=").slice(1).join("=") || DEFAULT_TENANT,
    execute: argv.includes("--execute"),
    allowBulkExecute: argv.includes("--allow-bulk-execute"),
    strictOneToOne: !argv.includes("--no-strict-one-to-one") && !argv.includes("--strict-one-to-one=false"),
    projectId: argv.find((arg) => arg.startsWith("--project-id="))?.split("=").slice(1).join("="),
    limit: parseLimit(limitArg),
  };
}

export function validateCompanyCamImportOptions(options: CompanyCamImportOptions) {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error(`--limit must be a positive integer (got ${options.limit})`);
  }
  if (options.execute && !options.projectId && options.limit === undefined && !options.allowBulkExecute) {
    throw new Error("--execute requires --project-id, --limit, or --allow-bulk-execute.");
  }
}

function matchPriority(row: CompanyCamImportPlanRow) {
  if (row.matchReason === "existing_companycam_link") return 3;
  if (row.matchReason === "project_number_in_name") return 2;
  return 1;
}

function compareMatches(left: CompanyCamImportPlanRow, right: CompanyCamImportPlanRow) {
  if (left.confidence !== right.confidence) return right.confidence - left.confidence;
  const priorityDelta = matchPriority(right) - matchPriority(left);
  if (priorityDelta !== 0) return priorityDelta;
  if (left.photoCount !== right.photoCount) return right.photoCount - left.photoCount;
  return left.companyCamProjectId.localeCompare(right.companyCamProjectId);
}

export function prepareCompanyCamImportRows(
  planRows: CompanyCamImportPlanRow[],
  options: Pick<CompanyCamImportOptions, "projectId" | "limit"> = {}
) {
  const candidates = planRows.filter((row) => row.matchedDealId && row.confidence >= 0.9);
  const byDealId = new Map<string, CompanyCamImportPlanRow[]>();
  for (const row of candidates) {
    byDealId.set(row.matchedDealId!, [...(byDealId.get(row.matchedDealId!) ?? []), row]);
  }

  const keptProjectIds = new Set<string>();
  const conflicts: CompanyCamMatchConflict[] = [];
  for (const [matchedDealId, rows] of byDealId) {
    const [kept, ...dropped] = [...rows].sort(compareMatches);
    if (!kept) continue;
    keptProjectIds.add(kept.companyCamProjectId);
    for (const row of dropped) {
      conflicts.push({
        matchedDealId,
        matchedDealName: kept.matchedDealName,
        keptCompanyCamProjectId: kept.companyCamProjectId,
        keptCompanyCamProjectName: kept.companyCamProjectName,
        keptConfidence: kept.confidence,
        droppedCompanyCamProjectId: row.companyCamProjectId,
        droppedCompanyCamProjectName: row.companyCamProjectName,
        droppedConfidence: row.confidence,
        reason: `CompanyCam project ${row.companyCamProjectId} dropped - deal ${matchedDealId} already matched to higher-confidence project ${kept.companyCamProjectId} (confidence ${kept.confidence} vs ${row.confidence})`,
      });
    }
  }

  return {
    rows: candidates
      .filter((row) => keptProjectIds.has(row.companyCamProjectId))
      .filter((row) => !options.projectId || row.companyCamProjectId === options.projectId)
      .slice(0, options.limit),
    conflicts,
  };
}

export function validateCompanyCamMatchConflicts(
  conflicts: CompanyCamMatchConflict[],
  options: Pick<CompanyCamImportOptions, "execute" | "strictOneToOne">
) {
  if (options.execute && options.strictOneToOne !== false && conflicts.length > 0) {
    throw new Error(`Refusing to import with ${conflicts.length} duplicate CompanyCam deal matches. Review companycam-match-conflicts CSV or pass --no-strict-one-to-one to continue with only the highest-confidence match per deal.`);
  }
}

function csvEscape(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function writeMatchConflictsCsv(conflicts: CompanyCamMatchConflict[], outputPath: string) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const rows = [
    ["matched_deal_id", "matched_deal_name", "kept_project_id", "kept_project_name", "kept_confidence", "dropped_project_id", "dropped_project_name", "dropped_confidence", "reason"],
    ...conflicts.map((conflict) => [
      conflict.matchedDealId,
      conflict.matchedDealName ?? "",
      conflict.keptCompanyCamProjectId,
      conflict.keptCompanyCamProjectName,
      String(conflict.keptConfidence),
      conflict.droppedCompanyCamProjectId,
      conflict.droppedCompanyCamProjectName,
      String(conflict.droppedConfidence),
      conflict.reason,
    ]),
  ];
  fs.writeFileSync(outputPath, rows.map((row) => row.map(csvEscape).join(",")).join("\n"));
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
  const options = parseCompanyCamImportArgs(argv);
  validateCompanyCamImportOptions(options);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const client = new pg.Client({ connectionString: getConnectionString() });
  await client.connect();
  try {
    const [projects, deals] = await Promise.all([getAllProjects(), loadDeals(client, options.tenant)]);
    const plan = buildCompanyCamImportPlan(
      projects.map((project) => ({ id: project.id, name: project.name, photoCount: project.photo_count ?? 0 })),
      deals
    );
    const prepared = prepareCompanyCamImportRows(plan.rows, options);
    const conflictsPath = `docs/audit/companycam-match-conflicts-${timestamp}.csv`;
    if (prepared.conflicts.length > 0) {
      for (const conflict of prepared.conflicts) console.warn(conflict.reason);
      writeMatchConflictsCsv(prepared.conflicts, conflictsPath);
    }
    validateCompanyCamMatchConflicts(prepared.conflicts, options);
    const userId = options.execute ? await getImportUserId(client) : "dry-run";
    const rows = prepared.rows;
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
      matchConflicts: prepared.conflicts.length,
      matchConflictsPath: prepared.conflicts.length > 0 ? conflictsPath : null,
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
