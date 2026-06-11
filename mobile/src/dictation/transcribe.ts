import * as FileSystem from "expo-file-system/legacy";
import { API_BASE_URL } from "../config";
import { ApiError } from "../api/client";
import type { TranscribeResult } from "../api/types";

/**
 * POST a recorded audio clip as a RAW body to the field transcription endpoint.
 *
 * This bypasses the JSON apiFetch client because the server expects a raw
 * `audio/*` body (express.raw) with an `x-file-name` header — so we stream the
 * file with expo-file-system uploadAsync (BINARY_CONTENT) and still send the
 * field auth + CSRF headers. Retries twice on 429/5xx with 500ms backoff,
 * mirroring web photo-dictation.transcribeDescriptionAudio.
 */
export async function transcribeAudio(input: {
  token: string;
  officeId?: string | null;
  fileUri: string;
  mimeType: string;
  fileName?: string;
  timeoutMs?: number;
}): Promise<TranscribeResult> {
  const headers: Record<string, string> = {
    "Content-Type": input.mimeType || "audio/m4a",
    Authorization: `Bearer ${input.token}`,
    "x-requested-with": "XMLHttpRequest",
  };
  if (input.officeId) headers["x-office-id"] = input.officeId;
  if (input.fileName) headers["x-file-name"] = input.fileName;

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await FileSystem.uploadAsync(
        `${API_BASE_URL}/api/field/photos/transcribe-description`,
        input.fileUri,
        {
          httpMethod: "POST",
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers,
        },
      );
      if (res.status < 200 || res.status >= 300) {
        throw new ApiError(extractError(res.body) ?? `Transcription failed (${res.status})`, res.status);
      }
      return JSON.parse(res.body) as TranscribeResult;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ApiError && (error.status === 429 || error.status >= 500);
      if (!retryable || attempt === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Voice transcription failed.");
}

function extractError(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    const err = (parsed as { error?: unknown }).error;
    if (typeof err === "string") return err;
    if (err && typeof (err as { message?: string }).message === "string") return (err as { message: string }).message;
  } catch {
    /* non-JSON body */
  }
  return undefined;
}
