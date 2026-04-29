import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  claimPendingCallRecordings,
  processCallRecordingTranscription,
  resetCallRecordingTranscriptionCostLedger,
} = await import("../../src/jobs/call-recording-transcribe.js");

const recording = {
  schemaName: "office_beta",
  id: "rec-1",
  r2Key: "call-recordings/office-1/rec-1.wav",
  originalFilename: "call.wav",
  mimeType: "audio/wav",
  fileSizeBytes: 44,
  durationSeconds: 60,
  uploadedBy: "user-1",
  entityType: "deal",
  entityId: "deal-1",
  title: "Kickoff",
};

function response(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function createPool() {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    })),
  } as any;
  return { pool, queries };
}

describe("call recording transcription worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCallRecordingTranscriptionCostLedger();
    process.env.OPENAI_API_KEY = "test-openai";
    process.env.ANTHROPIC_API_KEY = "test-anthropic";
    delete process.env.CALL_RECORDING_TRANSCRIPTION_DAILY_CAP_USD;
  });

  it("claims pending recordings with FOR UPDATE SKIP LOCKED and marks them processing", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("FROM \"office_beta\".call_recordings") && sql.includes("FOR UPDATE SKIP LOCKED")) {
          return {
            rowCount: 1,
            rows: [{
              id: "rec-1",
              r2_key: recording.r2Key,
              original_filename: recording.originalFilename,
              mime_type: recording.mimeType,
              file_size_bytes: "44",
              duration_seconds: 60,
              uploaded_by: recording.uploadedBy,
              entity_type: recording.entityType,
              entity_id: recording.entityId,
              title: recording.title,
            }],
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM public.offices")) return { rows: [{ slug: "beta" }], rowCount: 1 };
        if (sql.includes("information_schema.tables")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(async () => client),
    } as any;

    const claimed = await claimPendingCallRecordings(pool, 5);

    expect(claimed).toEqual([recording]);
    expect(queries.some(({ sql }) => sql.includes("FOR UPDATE SKIP LOCKED"))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("SET transcription_status = 'processing'"))).toBe(true);
  });

  it("processes a pending recording through Whisper and Claude", async () => {
    const { pool, queries } = createPool();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response({ text: "Customer committed to send roof photos." }))
      .mockResolvedValueOnce(response({
        content: [{ type: "text", text: "The customer discussed roof photos and committed to sending them. Next step is follow-up after receipt." }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }));

    const result = await processCallRecordingTranscription(recording, {
      dbPool: pool,
      fetchFn,
      downloadObject: vi.fn(async () => Buffer.from("RIFF")),
      now: () => new Date("2026-04-29T12:00:00.000Z"),
    });

    expect(result.status).toBe("complete");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(queries.some(({ sql, params }) =>
      sql.includes("transcription_status = $2") &&
      params?.[1] === "complete" &&
      params?.[2] === "Customer committed to send roof photos." &&
      params?.[3] === "The customer discussed roof photos and committed to sending them. Next step is follow-up after receipt."
    )).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("UPDATE \"office_beta\".activities"))).toBe(true);
  });

  it("fails recordings larger than Whisper's 25 MB limit without calling external APIs", async () => {
    const { pool, queries } = createPool();
    const fetchFn = vi.fn();

    const result = await processCallRecordingTranscription({
      ...recording,
      fileSizeBytes: 26 * 1024 * 1024,
    }, { dbPool: pool, fetchFn });

    expect(result).toEqual({ status: "failed", reason: "file_too_large" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(queries.some(({ params }) => params?.[1] === "failed" && params?.[4] === "file_too_large")).toBe(true);
  });

  it("marks a recording failed when Whisper has a network failure", async () => {
    const { pool, queries } = createPool();
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await processCallRecordingTranscription(recording, {
      dbPool: pool,
      fetchFn,
      downloadObject: vi.fn(async () => Buffer.from("RIFF")),
    });

    expect(result).toEqual({ status: "failed", reason: "network down" });
    expect(queries.some(({ params }) => params?.[1] === "failed" && params?.[4] === "network down")).toBe(true);
  });

  it("leaves recordings queued when the daily cap is already exhausted", async () => {
    const { pool, queries } = createPool();
    process.env.CALL_RECORDING_TRANSCRIPTION_DAILY_CAP_USD = "0";

    const result = await processCallRecordingTranscription(recording, { dbPool: pool });

    expect(result).toEqual({ status: "queued", reason: "daily_cap_exceeded" });
    expect(queries.some(({ params }) => params?.[1] === "pending" && params?.[4] === "daily_cap_exceeded")).toBe(true);
  });
});
