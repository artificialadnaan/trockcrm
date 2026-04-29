import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { pool } from "../db.js";

let r2Client: S3Client | null = null;

function isR2Configured() {
  return Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

function getR2Client() {
  if (r2Client) return r2Client;
  r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  return r2Client;
}

async function deleteR2Object(key: string) {
  if (!isR2Configured()) return false;
  await getR2Client().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME || "trock-crm-files",
    Key: key,
  }));
  return true;
}

function quoteIdent(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export async function runCallRecordingCleanup() {
  const offices = await pool.query<{ slug: string }>(
    "SELECT slug FROM public.offices WHERE is_active = true"
  );

  let deletedRecords = 0;
  let deletedObjects = 0;

  for (const office of offices.rows) {
    const schemaName = `office_${office.slug}`;
    const quotedSchema = quoteIdent(schemaName);
    const schemaExists = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'call_recordings'",
      [schemaName]
    );
    if (schemaExists.rowCount === 0) continue;

    const expired = await pool.query<{ id: string; r2_key: string }>(
      `SELECT id, r2_key FROM ${quotedSchema}.call_recordings WHERE expires_at < now()`
    );

    for (const row of expired.rows) {
      if (await deleteR2Object(row.r2_key)) {
        deletedObjects += 1;
      }
    }

    if ((expired.rowCount ?? 0) > 0) {
      await pool.query(
        `DELETE FROM ${quotedSchema}.call_recordings WHERE expires_at < now()`
      );
      deletedRecords += expired.rowCount ?? 0;
    }
  }

  console.log(`[Worker:call-recordings] Cleanup deleted ${deletedRecords} records and ${deletedObjects} R2 objects`);
  return { deletedRecords, deletedObjects };
}
