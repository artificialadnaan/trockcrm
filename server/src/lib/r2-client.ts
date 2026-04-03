import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PRESIGNED_URL_EXPIRY_SECONDS } from "../modules/files/file-constants.js";

let _client: S3Client | null = null;

function getR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME || "trock-crm-files";

  return { accountId, accessKeyId, secretAccessKey, bucketName };
}

/**
 * Check if R2 is configured. Returns false in dev mode when env vars are missing.
 */
export function isR2Configured(): boolean {
  const { accountId, accessKeyId, secretAccessKey } = getR2Config();
  return !!(accountId && accessKeyId && secretAccessKey);
}

/**
 * Get the singleton S3 client for R2.
 * Throws if R2 env vars are not configured.
 */
function getClient(): S3Client {
  if (_client) return _client;

  const { accountId, accessKeyId, secretAccessKey } = getR2Config();

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY."
    );
  }

  _client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return _client;
}

function getBucket(): string {
  return getR2Config().bucketName;
}

/**
 * Generate a presigned PUT URL for direct browser upload to R2.
 *
 * @param r2Key   - Full object key (e.g. "office_dallas/deals/TR-2026-0142/photos/file.jpg")
 * @param mimeType - Content-Type for the upload
 * @param _maxSizeBytes - Maximum allowed file size (validated server-side, not signed)
 * @returns Presigned URL valid for PRESIGNED_URL_EXPIRY_SECONDS
 */
export async function generateUploadUrl(
  r2Key: string,
  mimeType: string,
  _maxSizeBytes: number
): Promise<{ uploadUrl: string; r2Key: string; expiresIn: number }> {
  const client = getClient();
  const bucket = getBucket();

  // NOTE: Do NOT include ContentLength in the presigned PutObjectCommand.
  // Browsers cannot set the Content-Length header on XHR/fetch uploads —
  // the browser calculates it automatically. Including it in the signed
  // headers causes a SignatureDoesNotMatch error.
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: r2Key,
    ContentType: mimeType,
  });

  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  });

  return {
    uploadUrl,
    r2Key,
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  };
}

/**
 * Generate a presigned GET URL for file download / preview.
 *
 * @param r2Key - Full object key
 * @param expiresIn - URL validity in seconds (default 1 hour)
 * @param filename - Optional Content-Disposition filename for download
 * @returns Presigned download URL
 */
export async function generateDownloadUrl(
  r2Key: string,
  expiresIn: number = 3600,
  filename?: string
): Promise<string> {
  const client = getClient();
  const bucket = getBucket();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: r2Key,
    ...(filename
      ? { ResponseContentDisposition: `attachment; filename="${filename}"` }
      : {}),
  });

  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Check if an object exists in R2.
 */
export async function objectExists(r2Key: string): Promise<boolean> {
  const client = getClient();
  const bucket = getBucket();

  try {
    await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: r2Key })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * HEAD an R2 object and return its metadata.
 * Used by confirmUpload() to verify the object was actually written to R2
 * and that Content-Type / Content-Length match the declared values.
 */
export async function headObject(
  r2Key: string
): Promise<{ contentType?: string; contentLength?: number } | null> {
  const client = getClient();
  const bucket = getBucket();

  try {
    const resp = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: r2Key })
    );
    return {
      contentType: resp.ContentType,
      contentLength: resp.ContentLength,
    };
  } catch {
    return null;
  }
}

/**
 * Delete an object from R2 (soft-delete in DB, hard-delete in R2).
 * Used for cleanup of orphaned uploads or permanent deletions.
 */
export async function deleteObject(r2Key: string): Promise<void> {
  const client = getClient();
  const bucket = getBucket();

  await client.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: r2Key })
  );
}

/**
 * Upload a buffer directly to R2 from the server.
 * Used for server-side imports (e.g. CompanyCam photo sync).
 */
export async function putObject(
  r2Key: string,
  body: Buffer | Uint8Array,
  mimeType: string
): Promise<void> {
  const client = getClient();
  const bucket = getBucket();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: r2Key,
      Body: body,
      ContentType: mimeType,
    })
  );
}

/**
 * Dev mode: generate a mock presigned URL when R2 is not configured.
 * Returns a localhost URL so the upload flow can be tested locally.
 */
export function generateMockUploadUrl(r2Key: string): {
  uploadUrl: string;
  r2Key: string;
  expiresIn: number;
} {
  return {
    uploadUrl: `http://localhost:3001/api/files/dev-upload?key=${encodeURIComponent(r2Key)}`,
    r2Key,
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  };
}

/**
 * Dev mode: generate a mock download URL.
 */
export function generateMockDownloadUrl(r2Key: string): string {
  return `http://localhost:3001/api/files/dev-download?key=${encodeURIComponent(r2Key)}`;
}
