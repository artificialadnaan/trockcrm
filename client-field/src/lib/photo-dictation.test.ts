/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { transcribeDescriptionAudio } from "./photo-dictation";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("./api", () => ({
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  api: apiMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("photo dictation client", () => {
  it("posts raw audio to the field transcription endpoint", async () => {
    apiMock.mockResolvedValue({ transcript: "Sagging stringer" });

    const audio = new Blob(["audio"], { type: "audio/webm" });
    const result = await transcribeDescriptionAudio({
      audio,
      mimeType: "audio/webm",
      fileName: "clip.webm",
    });

    expect(result).toEqual({ transcript: "Sagging stringer" });
    expect(apiMock).toHaveBeenCalledWith("/field/photos/transcribe-description", expect.objectContaining({
      method: "POST",
      body: audio,
      contentType: "audio/webm",
      headers: { "x-file-name": "clip.webm" },
    }));
  });

  it("retries once on rate limit or upstream errors", async () => {
    apiMock
      .mockRejectedValueOnce(new ApiError("Too many requests", 429))
      .mockResolvedValueOnce({ transcript: "Retry success" });

    const result = await transcribeDescriptionAudio({
      audio: new Blob(["audio"], { type: "audio/webm" }),
      mimeType: "audio/webm",
    });

    expect(result.transcript).toBe("Retry success");
    expect(apiMock).toHaveBeenCalledTimes(2);
  });
});
