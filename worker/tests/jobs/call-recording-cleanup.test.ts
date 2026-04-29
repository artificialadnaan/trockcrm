import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../../src/db.js", () => ({
  pool: {
    query: queryMock,
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  DeleteObjectCommand: vi.fn(),
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn(),
  })),
}));

const { runCallRecordingCleanup } = await import("../../src/jobs/call-recording-cleanup.js");

describe("call recording cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
  });

  it("hard-deletes abandoned zero-byte uploads older than one hour", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ slug: "beta" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: 1 }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: "rec-1", r2_key: "call-recordings/office/rec-1.mp3", cleanup_reason: "abandoned" }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await runCallRecordingCleanup();

    expect(result).toEqual({ deletedRecords: 1, deletedObjects: 0, abandonedRecords: 1 });
    expect(queryMock.mock.calls.some(([sql]) =>
      typeof sql === "string" &&
      sql.includes("file_size_bytes = 0") &&
      sql.includes("uploaded_at < now() - interval '1 hour'")
    )).toBe(true);
  });
});
