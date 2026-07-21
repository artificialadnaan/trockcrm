import { isDurableStoreUri, rebaseDocumentDirectoryUri, reconstructDurablePhotoUri } from "../doc-dir-uri";

// Realistic iOS document directories: same app, DIFFERENT container UUID after an update/reinstall.
const OLD_DOC = "file:///var/mobile/Containers/Data/Application/AAAA-1111/Documents/";
const NEW_DOC = "file:///var/mobile/Containers/Data/Application/BBBB-2222/Documents/";

describe("rebaseDocumentDirectoryUri", () => {
  it("rebases a stale-container draft-photo uri onto the live document directory", () => {
    const stored = `${OLD_DOC}scorecard-drafts/user_office/draft-1/cu-abc.jpg`;
    expect(rebaseDocumentDirectoryUri(stored, NEW_DOC)).toBe(
      `${NEW_DOC}scorecard-drafts/user_office/draft-1/cu-abc.jpg`,
    );
  });

  it("rebases upload-queue and review-draft uris the same way (shared layout)", () => {
    expect(rebaseDocumentDirectoryUri(`${OLD_DOC}upload-queue/user_office/cu-1.jpg`, NEW_DOC)).toBe(
      `${NEW_DOC}upload-queue/user_office/cu-1.jpg`,
    );
    expect(rebaseDocumentDirectoryUri(`${OLD_DOC}review-draft/user_office/cu-2.heic`, NEW_DOC)).toBe(
      `${NEW_DOC}review-draft/user_office/cu-2.heic`,
    );
  });

  it("preserves the .tmp recovery suffix and any relative tail verbatim", () => {
    expect(rebaseDocumentDirectoryUri(`${OLD_DOC}upload-queue/u/index.json.tmp`, NEW_DOC)).toBe(
      `${NEW_DOC}upload-queue/u/index.json.tmp`,
    );
  });

  it("leaves a uri already rooted at the live directory unchanged", () => {
    const stored = `${NEW_DOC}scorecard-drafts/u/d/cu.jpg`;
    expect(rebaseDocumentDirectoryUri(stored, NEW_DOC)).toBe(stored);
  });

  it("leaves remote http(s) uris (retained presigned evidence) unchanged", () => {
    const remote = "https://cdn.example.com/scorecards/evidence/abc.jpg?sig=xyz";
    expect(rebaseDocumentDirectoryUri(remote, NEW_DOC)).toBe(remote);
  });

  it("leaves raw camera/library cache uris (not under Documents) unchanged", () => {
    const cache = "file:///var/mobile/Containers/Data/Application/AAAA-1111/tmp/ImagePicker/x.jpg";
    expect(rebaseDocumentDirectoryUri(cache, NEW_DOC)).toBe(cache);
    const asset = "ph://ABCD-1234/L0/001";
    expect(rebaseDocumentDirectoryUri(asset, NEW_DOC)).toBe(asset);
  });

  it("is a no-op when the live document directory is null/empty (very early startup)", () => {
    const stored = `${OLD_DOC}scorecard-drafts/u/d/cu.jpg`;
    expect(rebaseDocumentDirectoryUri(stored, null)).toBe(stored);
    expect(rebaseDocumentDirectoryUri(stored, "")).toBe(stored);
  });

  it("is a no-op for an empty stored uri", () => {
    expect(rebaseDocumentDirectoryUri("", NEW_DOC)).toBe("");
  });

  it("is a no-op when the live doc dir lacks a Documents segment (defensive)", () => {
    const weirdLive = "file:///data/user/0/app/files/";
    const stored = `${OLD_DOC}scorecard-drafts/u/d/cu.jpg`;
    // No /Documents/ in the live root → we can't safely splice → leave it alone.
    expect(rebaseDocumentDirectoryUri(stored, weirdLive)).toBe(stored);
  });
});

describe("isDurableStoreUri", () => {
  it("is true for a uri under the live document directory", () => {
    expect(isDurableStoreUri(`${NEW_DOC}scorecard-drafts/u/d/cu.jpg`, NEW_DOC)).toBe(true);
  });

  it("is true for a stale-container file:// uri under some /Documents/ path", () => {
    expect(isDurableStoreUri(`${OLD_DOC}upload-queue/u/cu.jpg`, NEW_DOC)).toBe(true);
  });

  it("is false for remote presigned evidence uris", () => {
    expect(isDurableStoreUri("https://cdn.example.com/x.jpg?sig=y", NEW_DOC)).toBe(false);
  });

  it("is false for raw cache / asset uris not under Documents", () => {
    expect(isDurableStoreUri("file:///var/.../tmp/ImagePicker/x.jpg", NEW_DOC)).toBe(false);
    expect(isDurableStoreUri("ph://ABCD-1234/L0/001", NEW_DOC)).toBe(false);
  });

  it("is false for empty uri", () => {
    expect(isDurableStoreUri("", NEW_DOC)).toBe(false);
  });
});

describe("reconstructDurablePhotoUri", () => {
  it("rebuilds the durable path from the live directory + clientUploadId, keeping the stored extension", () => {
    const stored = `${OLD_DOC}scorecard-drafts/u/d/cu-abc.jpg`;
    const liveDir = `${NEW_DOC}scorecard-drafts/u/d/`;
    expect(reconstructDurablePhotoUri(stored, liveDir, "cu-abc")).toBe(`${liveDir}cu-abc.jpg`);
  });

  it("preserves a non-jpg extension (heic/png) and strips any query/fragment", () => {
    const liveDir = `${NEW_DOC}review-draft/u/`;
    expect(reconstructDurablePhotoUri(`${OLD_DOC}review-draft/u/cu-2.heic`, liveDir, "cu-2")).toBe(
      `${liveDir}cu-2.heic`,
    );
    expect(reconstructDurablePhotoUri(`${OLD_DOC}x/cu-3.png?v=1`, liveDir, "cu-3")).toBe(`${liveDir}cu-3.png`);
  });

  it("yields an extension-less path when the stored uri has no extension", () => {
    const liveDir = `${NEW_DOC}upload-queue/u/`;
    expect(reconstructDurablePhotoUri(`${OLD_DOC}upload-queue/u/cu-noext`, liveDir, "cu-noext")).toBe(
      `${liveDir}cu-noext`,
    );
  });

  it("heals even when the doc-dir shape has no /Documents/ segment (deterministic, layout-driven)", () => {
    // Android-style live dir with no /Documents/ — reconstruction still works off the live directory + id.
    const liveDir = "file:///data/user/0/app/files/scorecard-drafts/u/d/";
    expect(reconstructDurablePhotoUri("file:///old/scorecard-drafts/u/d/cu.jpg", liveDir, "cu")).toBe(
      `${liveDir}cu.jpg`,
    );
  });

  it("returns the uri UNCHANGED without a clientUploadId (no `${liveDir}undefined` corruption)", () => {
    const stored = `${OLD_DOC}scorecard-drafts/u/d/cu.jpg`;
    const liveDir = `${NEW_DOC}scorecard-drafts/u/d/`;
    expect(reconstructDurablePhotoUri(stored, liveDir, "")).toBe(stored);
    expect(reconstructDurablePhotoUri(stored, liveDir, null)).toBe(stored);
    expect(reconstructDurablePhotoUri(stored, liveDir, undefined)).toBe(stored);
  });
});
