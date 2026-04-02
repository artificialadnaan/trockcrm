import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

let _client: S3Client | null = null;

function getR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME || "trock-crm-files";

  return { accountId, accessKeyId, secretAccessKey, bucketName };
}

/**
 * Check if R2 is configured. Returns false when env vars are missing.
 */
export function isR2Configured(): boolean {
  const { accountId, accessKeyId, secretAccessKey } = getR2Config();
  return !!(accountId && accessKeyId && secretAccessKey);
}

/**
 * Get the singleton S3 client for R2.
 * Throws if R2 env vars are not configured.
 */
export function getR2Client(): S3Client {
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

/**
 * Get the R2 bucket name from env or default.
 */
export function getR2Bucket(): string {
  return getR2Config().bucketName;
}

/**
 * Fetch an object from R2 and return its body as a Buffer.
 * Returns null if the object is not found or R2 is not configured.
 */
export async function getObjectBuffer(r2Key: string): Promise<Buffer | null> {
  if (!isR2Configured()) {
    console.log("[R2:worker] R2 not configured -- skipping object fetch");
    return null;
  }

  const client = getR2Client();
  const bucket = getR2Bucket();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: r2Key,
    })
  );

  if (!response.Body) {
    return null;
  }

  // Convert the readable stream to a Buffer
  const chunks: Uint8Array[] = [];
  const reader = response.Body as AsyncIterable<Uint8Array>;
  for await (const chunk of reader) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
