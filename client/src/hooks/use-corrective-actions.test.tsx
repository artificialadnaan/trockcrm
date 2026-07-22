// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const {
  getCorrectiveActions,
  submitCorrectiveActionResponse,
  requestCorrectiveActionUploadUrl,
  confirmCorrectiveActionUpload,
  useCorrectiveActions,
} = await import("./use-corrective-actions");

function flushEffects() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("corrective-action client API", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("getCorrectiveActions hits the field route and omits the token when none is given", async () => {
    apiMock.mockResolvedValue({ items: [] });
    await getCorrectiveActions("sc-1");
    expect(apiMock).toHaveBeenCalledWith("/field/scorecards/sc-1/corrective-actions");
  });

  it("getCorrectiveActions appends ?token= when a token is passed", async () => {
    apiMock.mockResolvedValue({ items: [] });
    await getCorrectiveActions("sc-1", "tok-abc");
    expect(apiMock).toHaveBeenCalledWith("/field/scorecards/sc-1/corrective-actions?token=tok-abc");
  });

  it("submitCorrectiveActionResponse posts the comment/photos and appends the token", async () => {
    apiMock.mockResolvedValue({ items: [] });
    await submitCorrectiveActionResponse("sc-1", "item-1", { comment: "fixed", photoFileIds: ["f1"] }, "tok-abc");
    expect(apiMock).toHaveBeenCalledWith(
      "/field/scorecards/sc-1/corrective-actions/item-1?token=tok-abc",
      expect.objectContaining({ method: "POST", json: { comment: "fixed", photoFileIds: ["f1"] } }),
    );
  });

  it("submitCorrectiveActionResponse omits photoFileIds when absent and omits the token in session mode", async () => {
    apiMock.mockResolvedValue({ items: [] });
    await submitCorrectiveActionResponse("sc-1", "item-1", { comment: "just a note" });
    expect(apiMock).toHaveBeenCalledWith(
      "/field/scorecards/sc-1/corrective-actions/item-1",
      expect.objectContaining({ method: "POST", json: { comment: "just a note" } }),
    );
  });

  it("requestCorrectiveActionUploadUrl posts contentType/sizeBytes and appends the token", async () => {
    apiMock.mockResolvedValue({ uploadUrl: "http://r2", objectKey: "k", uploadToken: "ut", expiresIn: 3600 });
    await requestCorrectiveActionUploadUrl("sc-1", { contentType: "image/jpeg", sizeBytes: 10 }, "tok-abc");
    expect(apiMock).toHaveBeenCalledWith(
      "/field/scorecards/sc-1/corrective-actions/upload/url?token=tok-abc",
      expect.objectContaining({ method: "POST", json: { contentType: "image/jpeg", sizeBytes: 10 } }),
    );
  });

  it("confirmCorrectiveActionUpload posts the uploadToken/objectKey and returns { fileId }", async () => {
    apiMock.mockResolvedValue({ fileId: "file-9" });
    const out = await confirmCorrectiveActionUpload("sc-1", { uploadToken: "ut", objectKey: "k" }, "tok-abc");
    expect(out).toEqual({ fileId: "file-9" });
    expect(apiMock).toHaveBeenCalledWith(
      "/field/scorecards/sc-1/corrective-actions/upload?token=tok-abc",
      expect.objectContaining({ method: "POST", json: { uploadToken: "ut", objectKey: "k" } }),
    );
  });

  it("useCorrectiveActions loads items in token mode and exposes loading/error", async () => {
    const items = [
      { id: "i1", itemType: "action_item", itemRef: "0", itemLabel: "Fix slab", status: "open", responseComment: null, respondedByUserId: null, responderName: null, responderEmail: null, respondedAt: null, photos: [] },
    ];
    apiMock.mockResolvedValue({ items });

    let snapshot: ReturnType<typeof useCorrectiveActions> | null = null;
    function Probe() {
      snapshot = useCorrectiveActions("sc-9", "tok-xyz");
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
      await flushEffects();
    });

    expect(apiMock).toHaveBeenCalledWith("/field/scorecards/sc-9/corrective-actions?token=tok-xyz");
    expect(snapshot!.loading).toBe(false);
    expect(snapshot!.error).toBeNull();
    expect(snapshot!.items).toHaveLength(1);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });

  it("useCorrectiveActions surfaces an expired/invalid token error", async () => {
    apiMock.mockRejectedValue(Object.assign(new Error("This corrective-action link is invalid or has expired."), { status: 401 }));

    let snapshot: ReturnType<typeof useCorrectiveActions> | null = null;
    function Probe() {
      snapshot = useCorrectiveActions("sc-9", "bad-token");
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
      await flushEffects();
    });

    expect(snapshot!.loading).toBe(false);
    expect(snapshot!.error).toContain("invalid or has expired");
    expect(snapshot!.items).toEqual([]);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });
});
