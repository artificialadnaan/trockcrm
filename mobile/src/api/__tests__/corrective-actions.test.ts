import {
  confirmCorrectiveActionUpload,
  discardCorrectiveActionPhoto,
  getCorrectiveActions,
  submitCorrectiveActionResponse,
} from "../endpoints";
import type { Fetcher } from "../endpoints";
import type { CorrectiveActionsResponse } from "../types";

function recordingFetcher(response: unknown) {
  const calls: Array<{ path: string; opts: Parameters<Fetcher>[1] }> = [];
  const fetcher: Fetcher = async (path, opts) => {
    calls.push({ path, opts });
    return response as never;
  };
  return { fetcher, calls };
}

describe("getCorrectiveActions", () => {
  it("GETs the scorecard's corrective-action items and returns the parsed payload", async () => {
    const payload: CorrectiveActionsResponse = {
      items: [
        {
          id: "item-1",
          itemType: "critical_deficiency",
          itemRef: "fall_protection",
          itemLabel: "Fall protection missing",
          status: "open",
          responseComment: null,
          respondedByUserId: null,
          responderName: null,
          responderEmail: null,
          respondedAt: null,
          photos: [],
        },
        {
          id: "item-2",
          itemType: "action_item",
          itemRef: "1",
          itemLabel: "Clean up debris",
          status: "resolved",
          responseComment: "Done, see photos.",
          respondedByUserId: "user-9",
          responderName: "Sam Field",
          responderEmail: "sam@example.com",
          respondedAt: "2026-07-22T18:00:00.000Z",
          photos: [
            { id: "scp-1", fileId: "file-1", clientUploadId: "cu-1", caption: "After cleanup" },
          ],
        },
      ],
    };
    const { fetcher, calls } = recordingFetcher(payload);

    const result = await getCorrectiveActions(fetcher, "sc-1");

    expect(calls).toEqual([{ path: "/field/scorecards/sc-1/corrective-actions", opts: undefined }]);
    expect(result).toEqual(payload);
    expect(result.items[1].photos[0].fileId).toBe("file-1");
  });
});

describe("submitCorrectiveActionResponse", () => {
  it("POSTs the comment + photoFileIds to the per-item route and returns the refreshed items", async () => {
    const refreshed: CorrectiveActionsResponse = { items: [] };
    const { fetcher, calls } = recordingFetcher(refreshed);

    const result = await submitCorrectiveActionResponse(fetcher, "sc-1", "item-1", {
      comment: "Corrected and re-inspected.",
      photoFileIds: ["file-1", "file-2"],
    });

    expect(calls).toEqual([
      {
        path: "/field/scorecards/sc-1/corrective-actions/item-1",
        opts: {
          method: "POST",
          body: { comment: "Corrected and re-inspected.", photoFileIds: ["file-1", "file-2"] },
        },
      },
    ]);
    expect(result).toEqual(refreshed);
  });

  it("omits photoFileIds from the body when none are provided", async () => {
    const { fetcher, calls } = recordingFetcher({ items: [] });

    await submitCorrectiveActionResponse(fetcher, "sc-1", "item-1", { comment: "Fixed." });

    expect(calls[0].opts).toEqual({ method: "POST", body: { comment: "Fixed." } });
  });
});

describe("confirmCorrectiveActionUpload", () => {
  it("POSTs the upload token + objectKey and carries a caption when present", async () => {
    const { fetcher, calls } = recordingFetcher({ fileId: "file-1" });

    await confirmCorrectiveActionUpload(fetcher, "sc-1", {
      uploadToken: "up-token",
      objectKey: "obj-key",
      caption: "Fixed the guardrail",
    });

    expect(calls).toEqual([
      {
        path: "/field/scorecards/sc-1/corrective-actions/upload",
        opts: {
          method: "POST",
          body: { uploadToken: "up-token", objectKey: "obj-key", caption: "Fixed the guardrail" },
        },
      },
    ]);
  });

  it("omits the caption from the body when null or absent", async () => {
    const { fetcher, calls } = recordingFetcher({ fileId: "file-1" });

    await confirmCorrectiveActionUpload(fetcher, "sc-1", {
      uploadToken: "up-token",
      objectKey: "obj-key",
      caption: null,
    });
    await confirmCorrectiveActionUpload(fetcher, "sc-1", { uploadToken: "up-token", objectKey: "obj-key" });

    expect(calls[0].opts).toEqual({
      method: "POST",
      body: { uploadToken: "up-token", objectKey: "obj-key" },
    });
    expect(calls[1].opts).toEqual({
      method: "POST",
      body: { uploadToken: "up-token", objectKey: "obj-key" },
    });
  });
});

describe("discardCorrectiveActionPhoto", () => {
  it("DELETEs the scorecard-scoped upload route for the given fileId", async () => {
    const { fetcher, calls } = recordingFetcher({ discarded: true });

    await discardCorrectiveActionPhoto(fetcher, "sc-1", "file-9");

    expect(calls).toEqual([
      { path: "/field/scorecards/sc-1/corrective-actions/upload/file-9", opts: { method: "DELETE" } },
    ]);
  });
});
