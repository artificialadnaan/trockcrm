import { afterEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const getSignedUrlMock = vi.fn();
const commandInstances: Array<{ type: string; input: unknown }> = [];

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = sendMock;
  }
  class PutObjectCommand {
    constructor(public input: unknown) { commandInstances.push({ type: "put", input }); }
  }
  class PutBucketCorsCommand {
    constructor(public input: unknown) { commandInstances.push({ type: "cors", input }); }
  }
  class GetObjectCommand {
    constructor(public input: unknown) { commandInstances.push({ type: "get", input }); }
  }
  class DeleteObjectCommand {
    constructor(public input: unknown) { commandInstances.push({ type: "delete", input }); }
  }
  class HeadObjectCommand {
    constructor(public input: unknown) { commandInstances.push({ type: "head", input }); }
  }
  return { S3Client, PutObjectCommand, PutBucketCorsCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

async function importR2() {
  vi.resetModules();
  return import("./r2-client.js");
}

describe("r2-client", () => {
  afterEach(() => {
    vi.clearAllMocks();
    commandInstances.length = 0;
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_BUCKET_NAME;
    delete process.env.R2_ALLOWED_ORIGINS;
    delete process.env.FRONTEND_URL;
    delete process.env.FIELD_APP_URL;
    delete process.env.RAILWAY_SERVICE_TROCKCRM_FIELD_URL;
  });

  it("reports configuration and builds allowed CORS origins", async () => {
    const r2 = await importR2();
    expect(r2.isR2Configured()).toBe(false);
    expect(r2.getAllowedR2CorsOrigins({ R2_ALLOWED_ORIGINS: "https://a.test, https://a.test, https://b.test" } as any)).toEqual(["https://a.test", "https://b.test"]);
    expect(r2.getAllowedR2CorsOrigins({ FRONTEND_URL: "https://crm.test" } as any)).toContain("https://crm.test");

    process.env.R2_ACCOUNT_ID = "acct";
    process.env.R2_ACCESS_KEY_ID = "key";
    process.env.R2_SECRET_ACCESS_KEY = "secret";
    expect(r2.isR2Configured()).toBe(true);
  });

  it("merges configured R2 origins with field app defaults", async () => {
    const r2 = await importR2();
    expect(
      r2.getAllowedR2CorsOrigins({
        R2_ALLOWED_ORIGINS: "https://crm.trockconstruction.com,https://api-production-ad218.up.railway.app",
        RAILWAY_SERVICE_TROCKCRM_FIELD_URL: "trockcam.com",
      } as any)
    ).toEqual([
      "https://trockcam.com",
      "https://crm.trockconstruction.com",
      "https://api-production-ad218.up.railway.app",
    ]);
  });

  it("generates upload and download signed urls with expected commands", async () => {
    process.env.R2_ACCOUNT_ID = "acct";
    process.env.R2_ACCESS_KEY_ID = "key";
    process.env.R2_SECRET_ACCESS_KEY = "secret";
    process.env.R2_BUCKET_NAME = "bucket";
    getSignedUrlMock.mockResolvedValueOnce("https://upload.test").mockResolvedValueOnce("https://download.test");
    const r2 = await importR2();

    await expect(r2.generateUploadUrl("photos/a.jpg", "image/jpeg", 123)).resolves.toEqual({ uploadUrl: "https://upload.test", r2Key: "photos/a.jpg", expiresIn: 30 * 60 });
    await expect(r2.generateDownloadUrl("photos/a.jpg", 60, "a.jpg")).resolves.toBe("https://download.test");

    expect(commandInstances[0]).toMatchObject({ type: "put", input: { Bucket: "bucket", Key: "photos/a.jpg", ContentType: "image/jpeg" } });
    expect(commandInstances[1]).toMatchObject({ type: "get", input: { Bucket: "bucket", Key: "photos/a.jpg", ResponseContentDisposition: 'attachment; filename="a.jpg"' } });
    expect(getSignedUrlMock).toHaveBeenNthCalledWith(1, expect.anything(), expect.anything(), { expiresIn: 30 * 60 });
  });

  it("handles object metadata, buffers, deletes, puts, and CORS", async () => {
    process.env.R2_ACCOUNT_ID = "acct";
    process.env.R2_ACCESS_KEY_ID = "key";
    process.env.R2_SECRET_ACCESS_KEY = "secret";
    process.env.R2_BUCKET_NAME = "bucket";
    const r2 = await importR2();
    async function* body() { yield new Uint8Array([1, 2]); yield new Uint8Array([3]); }
    sendMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce({ ContentType: "image/jpeg", ContentLength: 3 })
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce({ Body: body(), ContentType: "image/jpeg", ContentLength: 3 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await expect(r2.objectExists("a")).resolves.toBe(true);
    await expect(r2.objectExists("missing")).resolves.toBe(false);
    await expect(r2.headObject("a")).resolves.toEqual({ contentType: "image/jpeg", contentLength: 3 });
    await expect(r2.headObject("missing")).resolves.toBeNull();
    await expect(r2.getObjectBuffer("a")).resolves.toMatchObject({ buffer: Buffer.from([1, 2, 3]), contentType: "image/jpeg", contentLength: 3 });
    await expect(r2.deleteObject("a")).resolves.toBeUndefined();
    await expect(r2.putObject("a", Buffer.from([1]), "image/jpeg")).resolves.toBeUndefined();
    await expect(r2.configureR2Cors(["https://crm.test"])).resolves.toBeUndefined();

    expect(commandInstances.map((entry) => entry.type)).toEqual(["head", "head", "head", "head", "get", "delete", "put", "cors"]);
  });

  it("returns mock urls and throws for real URLs when R2 is missing", async () => {
    const r2 = await importR2();
    expect(r2.generateMockUploadUrl("a b.jpg").uploadUrl).toContain("a%20b.jpg");
    expect(r2.generateMockDownloadUrl("a b.jpg")).toContain("a%20b.jpg");
    await expect(r2.generateUploadUrl("a", "image/jpeg", 1)).rejects.toThrow("R2 not configured");
  });
});
