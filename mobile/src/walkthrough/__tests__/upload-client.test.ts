// Confirms the concrete client is actually wired to the real endpoints (not a placeholder/no-op) — the
// gap the task set out to close: upload.ts's WalkthroughUploadClient interface had no implementation.
import type { Fetcher } from "../../api/endpoints";
import { walkthroughUploadClient } from "../upload-client";

describe("walkthroughUploadClient", () => {
  it("requestUploadUrl hits the presign endpoint with dealId on the path", async () => {
    const calls: Array<{ path: string; opts: Parameters<Fetcher>[1] }> = [];
    const fetcher: Fetcher = async (path, opts) => {
      calls.push({ path, opts });
      return { uploadUrl: "https://r2.test/x", r2Key: "office/deal/walk/video", expiresIn: 900 } as never;
    };

    const result = await walkthroughUploadClient.requestUploadUrl(fetcher, "deal-42", {
      walkId: "walk-1",
      idempotencyKey: "walk-1:video",
      kind: "video",
      mimeType: "video/mp4",
      fileSizeBytes: 1024,
    });

    expect(calls[0]!.path).toBe("/field/projects/deal-42/glasses-walkthroughs/artifacts/upload-url");
    expect(calls[0]!.opts).toMatchObject({ method: "POST" });
    expect(result).toEqual({ uploadUrl: "https://r2.test/x", r2Key: "office/deal/walk/video", expiresIn: 900 });
  });

  it("completeWalk hits the completion endpoint with dealId on the path", async () => {
    const calls: Array<{ path: string; opts: Parameters<Fetcher>[1] }> = [];
    const fetcher: Fetcher = async (path, opts) => {
      calls.push({ path, opts });
      return { walkId: "walk-1", files: [], forwarding: { status: "queued", jobId: "1" } } as never;
    };

    const result = await walkthroughUploadClient.completeWalk(fetcher, "deal-42", {
      walkId: "walk-1",
      title: "Post RE Group - Building C — 30 Jul 2026, 9:15 PM",
      siteLabel: "",
      projectId: null,
      capturedAt: "2026-07-30T02:15:00.000Z",
      artifacts: [],
    });

    expect(calls[0]!.path).toBe("/field/projects/deal-42/glasses-walkthroughs");
    expect(calls[0]!.opts).toMatchObject({ method: "POST" });
    expect(result.walkId).toBe("walk-1");
  });
});
