import { ApiError, api } from "./api";

export type PhotoDictationResult = {
  transcript: string;
  language?: string;
  duration?: number;
};

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function transcribeDescriptionAudio(input: {
  audio: Blob;
  mimeType: string;
  fileName?: string;
  signal?: AbortSignal;
}): Promise<PhotoDictationResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await api<PhotoDictationResult>("/field/photos/transcribe-description", {
        method: "POST",
        body: input.audio,
        contentType: input.mimeType,
        signal: input.signal,
        headers: input.fileName ? { "x-file-name": input.fileName } : undefined,
      });
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ApiError && (error.status === 429 || error.status >= 500);
      if (!retryable || attempt === 1) break;
      await sleep(500 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Voice transcription failed.");
}
