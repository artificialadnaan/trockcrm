import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Pool, PoolClient } from "pg";
import { pool } from "../db.js";

const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_DAILY_CAP_USD = 50;

type TranscriptionStatus = "pending" | "processing" | "complete" | "failed";

export interface ClaimedCallRecording {
  schemaName: string;
  id: string;
  r2Key: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  durationSeconds: number | null;
  uploadedBy: string;
  entityType: string;
  entityId: string;
  title: string | null;
}

interface AnthropicSummaryResult {
  summary: string;
  inputTokens: number;
  outputTokens: number;
}

interface RunOptions {
  dbPool?: Pool;
  batchSize?: number;
  fetchFn?: typeof fetch;
  downloadObject?: (key: string) => Promise<Buffer>;
  now?: () => Date;
}

let r2Client: S3Client | null = null;
const dailyCostLedger = new Map<string, number>();

function quoteIdent(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
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

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function getTodayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function getDailyCapUsd() {
  const raw = process.env.CALL_RECORDING_TRANSCRIPTION_DAILY_CAP_USD;
  if (raw == null || raw.trim() === "") return DEFAULT_DAILY_CAP_USD;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DAILY_CAP_USD;
}

function getCostRate(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function estimateWhisperCost(durationSeconds: number | null) {
  const ratePerMinute = getCostRate("CALL_RECORDING_WHISPER_COST_PER_MINUTE_USD", 0.006);
  if (!durationSeconds || durationSeconds <= 0) return 0;
  return (durationSeconds / 60) * ratePerMinute;
}

function estimateClaudeCost(inputTokens: number, outputTokens: number) {
  const inputRate = getCostRate("CALL_RECORDING_CLAUDE_INPUT_COST_PER_MILLION_USD", 3);
  const outputRate = getCostRate("CALL_RECORDING_CLAUDE_OUTPUT_COST_PER_MILLION_USD", 15);
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}

function getSpentToday(now = new Date()) {
  return dailyCostLedger.get(getTodayKey(now)) ?? 0;
}

function addSpentToday(amountUsd: number, now = new Date()) {
  const key = getTodayKey(now);
  dailyCostLedger.set(key, (dailyCostLedger.get(key) ?? 0) + amountUsd);
}

export function resetCallRecordingTranscriptionCostLedger() {
  dailyCostLedger.clear();
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const stream = body as AsyncIterable<Uint8Array> & { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof stream.transformToByteArray === "function") {
    return Buffer.from(await stream.transformToByteArray());
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function downloadR2Object(key: string) {
  requireEnv("R2_ACCOUNT_ID");
  requireEnv("R2_ACCESS_KEY_ID");
  requireEnv("R2_SECRET_ACCESS_KEY");

  const result = await getR2Client().send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME || "trock-crm-files",
    Key: key,
  }));
  return bodyToBuffer(result.Body);
}

async function transcribeWithWhisper(
  audio: Buffer,
  recording: ClaimedCallRecording,
  fetchFn: typeof fetch
) {
  const form = new FormData();
  const audioPart = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
  form.append("model", "whisper-1");
  form.append("file", new Blob([audioPart], { type: recording.mimeType }), recording.originalFilename);

  const response = await fetchFn("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
    },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Whisper transcription failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as { text?: string };
  return payload.text?.trim() ?? "";
}

async function summarizeWithClaude(transcript: string, fetchFn: typeof fetch): Promise<AnthropicSummaryResult> {
  const response = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": requireEnv("ANTHROPIC_API_KEY"),
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Summarize this call in 3-5 sentences for a CRM activity timeline. Focus on: what was discussed, key decisions or commitments, next steps. Be direct and skip pleasantries.\n\n${transcript}`,
      }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Claude summary failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const summary = payload.content
    ?.filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n")
    .trim() ?? "";

  return {
    summary,
    inputTokens: payload.usage?.input_tokens ?? 0,
    outputTokens: payload.usage?.output_tokens ?? 0,
  };
}

async function getActiveOfficeSchemas(dbPool: Pool) {
  const offices = await dbPool.query<{ slug: string }>(
    "SELECT slug FROM public.offices WHERE is_active = true"
  );
  return offices.rows.map((office) => `office_${office.slug}`);
}

async function hasCallRecordingsTable(dbPool: Pool, schemaName: string) {
  const exists = await dbPool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'call_recordings'",
    [schemaName]
  );
  return (exists.rowCount ?? 0) > 0;
}

async function claimFromSchema(client: PoolClient, schemaName: string, limit: number) {
  const quotedSchema = quoteIdent(schemaName);
  await client.query("BEGIN");
  try {
    const rows = await client.query<{
      id: string;
      r2_key: string;
      original_filename: string;
      mime_type: string;
      file_size_bytes: string | number;
      duration_seconds: number | null;
      uploaded_by: string;
      entity_type: string;
      entity_id: string;
      title: string | null;
    }>(
      `SELECT id, r2_key, original_filename, mime_type, file_size_bytes, duration_seconds, uploaded_by, entity_type, entity_id, title
       FROM ${quotedSchema}.call_recordings
       WHERE transcription_status = 'pending'
         AND deleted_at IS NULL
         AND file_size_bytes > 0
       ORDER BY uploaded_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );

    if ((rows.rowCount ?? 0) > 0) {
      await client.query(
        `UPDATE ${quotedSchema}.call_recordings
         SET transcription_status = 'processing',
             transcription_error = NULL
         WHERE id = ANY($1::uuid[])`,
        [rows.rows.map((row) => row.id)]
      );
    }

    await client.query("COMMIT");
    return rows.rows.map((row) => ({
      schemaName,
      id: row.id,
      r2Key: row.r2_key,
      originalFilename: row.original_filename,
      mimeType: row.mime_type,
      fileSizeBytes: Number(row.file_size_bytes),
      durationSeconds: row.duration_seconds,
      uploadedBy: row.uploaded_by,
      entityType: row.entity_type,
      entityId: row.entity_id,
      title: row.title,
    }));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export async function claimPendingCallRecordings(dbPool: Pool, limit = DEFAULT_BATCH_SIZE) {
  const claimed: ClaimedCallRecording[] = [];
  for (const schemaName of await getActiveOfficeSchemas(dbPool)) {
    if (claimed.length >= limit) break;
    if (!await hasCallRecordingsTable(dbPool, schemaName)) continue;

    const client = await dbPool.connect();
    try {
      const rows = await claimFromSchema(client, schemaName, limit - claimed.length);
      claimed.push(...rows);
    } finally {
      client.release();
    }
  }
  return claimed;
}

async function setTranscriptionStatus(
  dbPool: Pool,
  recording: ClaimedCallRecording,
  status: TranscriptionStatus,
  updates: {
    transcriptText?: string | null;
    transcriptSummary?: string | null;
    transcriptionError?: string | null;
  } = {}
) {
  const quotedSchema = quoteIdent(recording.schemaName);
  await dbPool.query(
    `UPDATE ${quotedSchema}.call_recordings
     SET transcription_status = $2,
         transcript_text = COALESCE($3, transcript_text),
         transcript_summary = COALESCE($4, transcript_summary),
         transcription_error = $5
     WHERE id = $1`,
    [
      recording.id,
      status,
      updates.transcriptText ?? null,
      updates.transcriptSummary ?? null,
      updates.transcriptionError ?? null,
    ]
  );
}

async function updateActivitySummary(dbPool: Pool, recording: ClaimedCallRecording, summary: string) {
  const quotedSchema = quoteIdent(recording.schemaName);
  await dbPool.query(
    `UPDATE ${quotedSchema}.activities
     SET body = $5
     WHERE id = (
       SELECT id
       FROM ${quotedSchema}.activities
       WHERE type = 'call'
         AND source_entity_type = $1
         AND source_entity_id = $2
         AND responsible_user_id = $3
         AND subject = $4
       ORDER BY occurred_at DESC, created_at DESC
       LIMIT 1
     )`,
    [
      recording.entityType,
      recording.entityId,
      recording.uploadedBy,
      `Call recording uploaded: ${recording.title || recording.originalFilename}`,
      summary,
    ]
  );
}

function normalizeError(err: unknown) {
  if (err instanceof Error) return err.message.slice(0, 1000);
  return String(err).slice(0, 1000);
}

export async function processCallRecordingTranscription(
  recording: ClaimedCallRecording,
  options: RunOptions = {}
) {
  const dbPool = options.dbPool ?? pool;
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now?.() ?? new Date();
  const spentToday = getSpentToday(now);
  const capUsd = getDailyCapUsd();

  if (spentToday >= capUsd) {
    await setTranscriptionStatus(dbPool, recording, "pending", { transcriptionError: "daily_cap_exceeded" });
    return { status: "queued" as const, reason: "daily_cap_exceeded" };
  }

  if (recording.fileSizeBytes > WHISPER_MAX_BYTES) {
    await setTranscriptionStatus(dbPool, recording, "failed", { transcriptionError: "file_too_large" });
    return { status: "failed" as const, reason: "file_too_large" };
  }

  try {
    const download = options.downloadObject ?? downloadR2Object;
    const audio = await download(recording.r2Key);
    const transcript = await transcribeWithWhisper(audio, recording, fetchFn);
    const summaryResult = await summarizeWithClaude(transcript, fetchFn);
    const whisperCost = estimateWhisperCost(recording.durationSeconds);
    const claudeCost = estimateClaudeCost(summaryResult.inputTokens, summaryResult.outputTokens);
    const totalCost = whisperCost + claudeCost;

    await setTranscriptionStatus(dbPool, recording, "complete", {
      transcriptText: transcript,
      transcriptSummary: summaryResult.summary,
      transcriptionError: null,
    });
    await updateActivitySummary(dbPool, recording, summaryResult.summary);
    addSpentToday(totalCost, now);

    console.log("[Worker:call-recordings] Transcribed recording", {
      recordingId: recording.id,
      whisperCostUsd: Number(whisperCost.toFixed(6)),
      claudeCostUsd: Number(claudeCost.toFixed(6)),
      totalCostUsd: Number(totalCost.toFixed(6)),
      spentTodayUsd: Number(getSpentToday(now).toFixed(6)),
      capUsd,
    });

    return { status: "complete" as const, costUsd: totalCost };
  } catch (err) {
    const message = normalizeError(err);
    await setTranscriptionStatus(dbPool, recording, "failed", { transcriptionError: message });
    console.error("[Worker:call-recordings] Transcription failed", {
      recordingId: recording.id,
      error: message,
    });
    return { status: "failed" as const, reason: message };
  }
}

export async function runCallRecordingTranscription(options: RunOptions = {}) {
  const dbPool = options.dbPool ?? pool;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const recordings = await claimPendingCallRecordings(dbPool, batchSize);
  const stats = { claimed: recordings.length, complete: 0, failed: 0, queued: 0 };

  for (const recording of recordings) {
    const result = await processCallRecordingTranscription(recording, options);
    if (result.status === "complete") stats.complete += 1;
    if (result.status === "failed") stats.failed += 1;
    if (result.status === "queued") stats.queued += 1;
  }

  if (stats.claimed > 0) {
    console.log("[Worker:call-recordings] Transcription batch complete", stats);
  }
  return stats;
}
