// Crash-safety + concurrency coverage for the device-local review-draft store. expo-file-system is replaced
// with an in-memory FS (store lives inside the factory closure, so no jest-hoist TDZ) that supports
// directory deletes (clearDraft removes the whole owner dir) so we can assert file cleanup, and lets us
// stage the exact interrupted-write states writeManifest can leave behind.
jest.mock("expo-file-system/legacy", () => {
  const store = new Map<string, string>();
  const dirs = new Set<string>();
  const norm = (p: string) => p.replace(/\/$/, "");
  return {
    __store: store,
    __reset: () => { store.clear(); dirs.clear(); },
    documentDirectory: "file:///doc/",
    getInfoAsync: async (p: string) => ({ exists: store.has(p) || dirs.has(p) || dirs.has(norm(p)) }),
    makeDirectoryAsync: async (d: string) => { dirs.add(d); dirs.add(norm(d)); },
    readAsStringAsync: async (p: string) => {
      if (!store.has(p)) throw new Error(`ENOENT ${p}`);
      return store.get(p)!;
    },
    writeAsStringAsync: async (p: string, data: string) => { store.set(p, data); },
    deleteAsync: async (p: string) => {
      // Exact file...
      store.delete(p);
      // ...OR a whole directory: drop everything living under it.
      const prefix = p.endsWith("/") ? p : `${p}/`;
      for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
      dirs.delete(p); dirs.delete(norm(p));
      for (const d of [...dirs]) if (d.startsWith(prefix)) dirs.delete(d);
    },
    moveAsync: async ({ from, to }: { from: string; to: string }) => {
      if (!store.has(from)) throw new Error(`ENOENT move ${from}`);
      store.set(to, store.get(from)!);
      store.delete(from);
    },
    copyAsync: async ({ from, to }: { from: string; to: string }) => { store.set(to, store.get(from) ?? ""); },
  };
});

import * as FileSystem from "expo-file-system/legacy";
import { clearDraft, loadDraft, removeDraftPhotos, stageDraftPhoto, updateDraftCaption } from "../review-draft";
import type { SessionPhoto } from "../session-photo";
import type { DraftCtx } from "../review-draft-core";

const fs = FileSystem as unknown as { __store: Map<string, string>; __reset: () => void };

const ctx: DraftCtx = { target: { dealId: "d1" }, category: "Roof", tags: ["north"] };

function photo(over: Partial<SessionPhoto> & { key: string }): SessionPhoto {
  const key = over.key;
  return {
    clientUploadId: `cu-${key}`,
    uri: `file:///src/${key}.jpg`,
    width: 100,
    height: 200,
    metadata: { takenAt: "t", latitude: 1, longitude: 2, addressSource: "exif" },
    caption: "",
    ...over,
  };
}
// Seed a raw source file so copyAsync has real bytes to copy (proves the durable copy carries content).
async function stage(ownerKey: string, p: SessionPhoto, c: DraftCtx = ctx) {
  fs.__store.set(p.uri, `bytes-of-${p.key}`);
  return stageDraftPhoto(ownerKey, p, c);
}
function manifestKey(): string {
  const key = [...fs.__store.keys()].find((k) => k.endsWith("manifest.json"));
  if (!key) throw new Error("no manifest written yet");
  return key;
}

beforeEach(() => fs.__reset());

describe("review-draft: stage + loadDraft round-trip (staged photos never touch the upload queue)", () => {
  it("copies the file into the draft dir, persists the manifest, and round-trips the item", async () => {
    const returned = await stage("u1", photo({ key: "a", caption: "hi" }));
    // Durable copy lives under review-draft/<owner>/ (NOT the raw uri, NOT any upload-queue dir).
    expect(returned.uri).toMatch(/review-draft\/u1\/cu-a\.jpg$/);
    expect(returned.uri).not.toContain("upload-queue");
    expect(fs.__store.get(returned.uri)).toBe("bytes-of-a");

    const loaded = await loadDraft("u1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      key: "a",
      clientUploadId: "cu-a",
      uri: returned.uri,
      width: 100,
      height: 200,
      caption: "hi",
      metadata: { latitude: 1, longitude: 2 },
      ctx: { target: { dealId: "d1" }, category: "Roof", tags: ["north"] },
    });
  });

  it("stages multiple photos, appended in order", async () => {
    await stage("u1", photo({ key: "a" }));
    await stage("u1", photo({ key: "b" }));
    expect((await loadDraft("u1")).map((i) => i.key)).toEqual(["a", "b"]);
  });

  it("is idempotent on clientUploadId — a re-stage of the same photo does not duplicate", async () => {
    await stage("u1", photo({ key: "a" }));
    await stage("u1", photo({ key: "a" }));
    expect(await loadDraft("u1")).toHaveLength(1);
  });

  it("returns [] for an owner with no draft", async () => {
    expect(await loadDraft("nobody")).toEqual([]);
  });

  it("keeps drafts isolated per owner (one signer never sees another's staged photos)", async () => {
    await stage("u1", photo({ key: "a" }));
    await stage("u2", photo({ key: "b" }));
    expect((await loadDraft("u1")).map((i) => i.key)).toEqual(["a"]);
    expect((await loadDraft("u2")).map((i) => i.key)).toEqual(["b"]);
  });
});

describe("review-draft: updateDraftCaption (crash preserves captions typed so far)", () => {
  it("persists the caption onto the manifest item", async () => {
    await stage("u1", photo({ key: "a" }));
    await updateDraftCaption("u1", "a", "cracked flashing");
    expect((await loadDraft("u1"))[0].caption).toBe("cracked flashing");
  });

  it("patches ONLY the keyed photo, never a sibling", async () => {
    await stage("u1", photo({ key: "a" }));
    await stage("u1", photo({ key: "b" }));
    await updateDraftCaption("u1", "b", "only b");
    const loaded = await loadDraft("u1");
    expect(loaded.find((i) => i.key === "a")!.caption).toBe("");
    expect(loaded.find((i) => i.key === "b")!.caption).toBe("only b");
  });
});

describe("review-draft: removeDraftPhotos (drops manifest entry + deletes the file)", () => {
  it("removes only the keyed items and deletes their copied files", async () => {
    const a = await stage("u1", photo({ key: "a" }));
    await stage("u1", photo({ key: "b" }));
    await removeDraftPhotos("u1", ["a"]);
    expect((await loadDraft("u1")).map((i) => i.key)).toEqual(["b"]);
    expect(fs.__store.has(a.uri)).toBe(false); // file deleted
  });

  it("is a no-op when nothing matches", async () => {
    await stage("u1", photo({ key: "a" }));
    await removeDraftPhotos("u1", ["missing"]);
    expect((await loadDraft("u1")).map((i) => i.key)).toEqual(["a"]);
  });
});

describe("review-draft: clearDraft (Cancel/Done discard — every file + the manifest)", () => {
  it("deletes all copied files AND the manifest, leaving an empty draft", async () => {
    const a = await stage("u1", photo({ key: "a" }));
    const b = await stage("u1", photo({ key: "b" }));
    await clearDraft("u1");
    expect(await loadDraft("u1")).toEqual([]);
    expect(fs.__store.has(a.uri)).toBe(false);
    expect(fs.__store.has(b.uri)).toBe(false);
    expect([...fs.__store.keys()].some((k) => k.includes("review-draft/u1/"))).toBe(false);
  });

  it("throws on a real delete failure so Cancel can keep the review open + retry", async () => {
    await stage("u1", photo({ key: "a" }));
    const spy = jest
      .spyOn(FileSystem, "deleteAsync")
      .mockRejectedValueOnce(new Error("disk error"));
    await expect(clearDraft("u1")).rejects.toThrow("disk error");
    spy.mockRestore();
  });
});

describe("review-draft: crash-safe manifest read (interrupted-write recovery)", () => {
  it("prefers a VALID .tmp over the live manifest (both present after an interrupted rename)", async () => {
    const a = await stage("u1", photo({ key: "a" })); // live = [a]
    // A fully-written newer .tmp that never got renamed:
    fs.__store.set(`${manifestKey()}.tmp`, JSON.stringify([{ ...a, key: "b", clientUploadId: "cu-b", caption: "newer" }]));
    expect((await loadDraft("u1")).map((i) => i.key)).toEqual(["b"]);
  });

  it("falls back to the live manifest when the .tmp is corrupt/partial", async () => {
    await stage("u1", photo({ key: "a" }));
    fs.__store.set(`${manifestKey()}.tmp`, '[{"key":"b" PARTIAL');
    expect((await loadDraft("u1")).map((i) => i.key)).toEqual(["a"]);
  });

  it("falls back to the .bak when both .tmp and the live manifest are gone", async () => {
    const a = await stage("u1", photo({ key: "a" }));
    const mk = manifestKey();
    fs.__store.set(`${mk}.bak`, JSON.stringify([{ ...a, key: "z", clientUploadId: "cu-z" }]));
    fs.__store.delete(mk);
    expect((await loadDraft("u1")).map((i) => i.key)).toEqual(["z"]);
  });

  it("a successful stage leaves ONLY the live manifest — no leftover .tmp", async () => {
    await stage("u1", photo({ key: "a" }));
    const keys = [...fs.__store.keys()];
    expect(keys.some((k) => k.endsWith("manifest.json"))).toBe(true);
    expect(keys.some((k) => k.endsWith("manifest.json.tmp"))).toBe(false);
  });
});

describe("review-draft: serialization (no read-modify-write clobber)", () => {
  it("concurrent stages of different photos BOTH persist (mutex)", async () => {
    await Promise.all([stage("u1", photo({ key: "a" })), stage("u1", photo({ key: "b" }))]);
    expect((await loadDraft("u1")).map((i) => i.key).sort()).toEqual(["a", "b"]);
  });

  it("a stage concurrent with a remove doesn't lose or resurrect the other photo", async () => {
    await stage("u1", photo({ key: "a" }));
    await Promise.all([stage("u1", photo({ key: "b" })), removeDraftPhotos("u1", ["a"])]);
    expect((await loadDraft("u1")).map((i) => i.key)).toEqual(["b"]);
  });
});
