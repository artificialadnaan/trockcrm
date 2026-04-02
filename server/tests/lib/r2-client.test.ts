import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the AWS SDK modules
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn(),
  })),
  PutObjectCommand: vi.fn(),
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
      expect(result.expiresIn).toBe(900);
    });

    it("should generate valid mock download URLs", async () => {
      const { generateMockDownloadUrl } = await import("../../src/lib/r2-client.js");
      const url = generateMockDownloadUrl("office_dallas/deals/TR-2026-0001/photos/test.jpg");

      expect(url).toContain("/api/files/dev-download");
      expect(url).toContain("key=");
    });
  });

  describe("Presigned URL Expiry", () => {
    it("should use 15-minute expiry for uploads", async () => {
      const { PRESIGNED_URL_EXPIRY_SECONDS } = await import(
        "../../src/modules/files/file-constants.js"
      );
      expect(PRESIGNED_URL_EXPIRY_SECONDS).toBe(15 * 60); // 900 seconds
    });
  });
});
