import { describe, it, expect, vi, beforeEach } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";

// Mock the AWS SDK modules. A hoisted sendMock lets individual tests control S3 responses.
const sendMock = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: sendMock,
  })),
  PutObjectCommand: vi.fn(),
  PutBucketCorsCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn(),
  HeadObjectCommand: vi.fn(),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://r2.example.com/signed-url"),
}));

describe("R2 Client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset module cache so env vars are re-read
    vi.resetModules();
  });

  describe("isR2Configured", () => {
    it("should return false when env vars are missing", async () => {
      delete process.env.R2_ACCOUNT_ID;
      delete process.env.R2_ACCESS_KEY_ID;
      delete process.env.R2_SECRET_ACCESS_KEY;

      const { isR2Configured } = await import("../../src/lib/r2-client.js");
      expect(isR2Configured()).toBe(false);
    });

    it("should return true when all env vars are set", async () => {
      process.env.R2_ACCOUNT_ID = "test-account";
      process.env.R2_ACCESS_KEY_ID = "test-key";
      process.env.R2_SECRET_ACCESS_KEY = "test-secret";

      const { isR2Configured } = await import("../../src/lib/r2-client.js");
      expect(isR2Configured()).toBe(true);

      delete process.env.R2_ACCOUNT_ID;
      delete process.env.R2_ACCESS_KEY_ID;
      delete process.env.R2_SECRET_ACCESS_KEY;
    });
  });

  describe("Mock URL Generation", () => {
    it("should generate valid mock upload URLs", async () => {
      const { generateMockUploadUrl } = await import("../../src/lib/r2-client.js");
      const result = generateMockUploadUrl("office_dallas/deals/TR-2026-0001/photos/test.jpg");

      expect(result.uploadUrl).toContain("/api/files/dev-upload");
      expect(result.uploadUrl).toContain("key=");
      expect(result.r2Key).toBe("office_dallas/deals/TR-2026-0001/photos/test.jpg");
      expect(result.expiresIn).toBe(30 * 60);
    });

    it("should generate valid mock download URLs", async () => {
      const { generateMockDownloadUrl } = await import("../../src/lib/r2-client.js");
      const url = generateMockDownloadUrl("office_dallas/deals/TR-2026-0001/photos/test.jpg");

      expect(url).toContain("/api/files/dev-download");
      expect(url).toContain("key=");
    });
  });

  describe("Presigned URL Expiry", () => {
    it("should use 30-minute expiry for uploads", async () => {
      const { PRESIGNED_URL_EXPIRY_SECONDS } = await import(
        "../../src/modules/files/file-constants.js"
      );
      expect(PRESIGNED_URL_EXPIRY_SECONDS).toBe(30 * 60);
    });
  });

  describe("R2 CORS origins", () => {
    it("uses comma-separated R2_ALLOWED_ORIGINS when configured", async () => {
      const { getAllowedR2CorsOrigins } = await import("../../src/lib/r2-client.js");

      expect(getAllowedR2CorsOrigins({
        R2_ALLOWED_ORIGINS: "https://crm.trockconstruction.com, https://api-production-ad218.up.railway.app, https://crm.trockconstruction.com",
      } as NodeJS.ProcessEnv)).toEqual([
        "https://crm.trockconstruction.com",
        "https://api-production-ad218.up.railway.app",
      ]);
    });

    it("falls back to the legacy frontend and local origins when unset", async () => {
      const { getAllowedR2CorsOrigins } = await import("../../src/lib/r2-client.js");

      expect(getAllowedR2CorsOrigins({
        FRONTEND_URL: "https://frontend-production-bcab.up.railway.app",
      } as NodeJS.ProcessEnv)).toEqual([
        "https://frontend-production-bcab.up.railway.app",
        "http://localhost:5173",
        "http://localhost:3000",
      ]);
    });
  });

  describe("getObjectBuffer size cap", () => {
    const KEY = "office_dallas/deals/TR-1/photos/huge.png";
    beforeEach(() => {
      // The outer beforeEach's vi.restoreAllMocks() strips the S3Client implementation — re-apply it so
      // getClient() returns a client whose .send is our controllable sendMock.
      (S3Client as unknown as { mockImplementation: (fn: () => unknown) => void }).mockImplementation(() => ({ send: sendMock }));
      process.env.R2_ACCOUNT_ID = "acct";
      process.env.R2_ACCESS_KEY_ID = "key";
      process.env.R2_SECRET_ACCESS_KEY = "secret";
      process.env.R2_BUCKET_NAME = "bucket";
      sendMock.mockReset();
    });

    function fakeBody(chunks: Uint8Array[], destroy: () => void, onIterate?: () => void) {
      return {
        destroy,
        async *[Symbol.asyncIterator]() {
          onIterate?.();
          for (const c of chunks) yield c;
        },
      };
    }

    it("rejects (ObjectTooLargeError) + destroys the stream when Content-Length exceeds maxBytes — body never read", async () => {
      const destroy = vi.fn();
      let iterated = false;
      sendMock.mockResolvedValue({ Body: fakeBody([new Uint8Array(10)], destroy, () => { iterated = true; }), ContentLength: 100 * 1024 * 1024 });
      const { getObjectBuffer, ObjectTooLargeError } = await import("../../src/lib/r2-client.js");

      await expect(getObjectBuffer(KEY, { maxBytes: 1024 })).rejects.toBeInstanceOf(ObjectTooLargeError);
      expect(destroy).toHaveBeenCalled();
      expect(iterated).toBe(false); // the oversized body is never streamed
    });

    it("aborts + destroys mid-stream when chunks exceed maxBytes despite an absent Content-Length", async () => {
      const destroy = vi.fn();
      sendMock.mockResolvedValue({ Body: fakeBody([new Uint8Array(800), new Uint8Array(800)], destroy) }); // no ContentLength
      const { getObjectBuffer, ObjectTooLargeError } = await import("../../src/lib/r2-client.js");

      await expect(getObjectBuffer(KEY, { maxBytes: 1000 })).rejects.toBeInstanceOf(ObjectTooLargeError);
      expect(destroy).toHaveBeenCalled();
    });

    it("returns the buffer when within the cap", async () => {
      sendMock.mockResolvedValue({ Body: fakeBody([new Uint8Array([1, 2, 3])], vi.fn()), ContentLength: 3, ContentType: "image/png" });
      const { getObjectBuffer } = await import("../../src/lib/r2-client.js");

      const { buffer } = await getObjectBuffer(KEY, { maxBytes: 1024 });
      expect(buffer.equals(Buffer.from([1, 2, 3]))).toBe(true);
    });
  });
});
