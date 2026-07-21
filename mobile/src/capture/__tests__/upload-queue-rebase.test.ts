// Integration coverage for readQueue's stale-container uri rebasing (via the public getQueuedUploads). The
// upload-queue module transitively pulls in native/side-effect deps (keep-awake, compress, camera-adjacent
// upload path) that don't run under jsdom; mock the leaf side-effect modules so the REAL queue read logic
// (readQueue → rebaseQueuedUris) runs against an in-memory FS.
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
    readAsStringAsync: async (p: string) => { if (!store.has(p)) throw new Error(`ENOENT ${p}`); return store.get(p)!; },
    writeAsStringAsync: async (p: string, data: string) => { store.set(p, data); },
    deleteAsync: async (p: string) => { store.delete(p); dirs.delete(p); dirs.delete(norm(p)); },
    moveAsync: async ({ from, to }: { from: string; to: string }) => { store.set(to, store.get(from) ?? ""); store.delete(from); },
    copyAsync: async ({ from, to }: { from: string; to: string }) => { store.set(to, store.get(from) ?? ""); },
  };
});
jest.mock("expo-keep-awake", () => ({ activateKeepAwakeAsync: jest.fn(), deactivateKeepAwake: jest.fn() }));
jest.mock("../upload", () => ({
  runConcurrentUploads: jest.fn(),
  uploadCapture: jest.fn(),
  UploadCancelledError: class UploadCancelledError extends Error {},
}));

import * as FileSystem from "expo-file-system/legacy";
import { getQueuedUploads } from "../upload-queue";

const fs = FileSystem as unknown as { __store: Map<string, string>; __reset: () => void };

beforeEach(() => fs.__reset());

function queuedItem(id: string, uri: string) {
  return {
    clientUploadId: id, uri, target: { dealId: "d1" }, category: null, caption: null, tags: [],
    metadata: {}, enqueuedAt: 0, attempts: 0,
  };
}

describe("upload-queue: stale-container uri rebasing on read", () => {
  it("rebases a queued item's uri onto the live owner dir (heals a rotated container)", async () => {
    const stale = "file:///var/mobile/Containers/Data/Application/OLD-UUID/Documents/upload-queue/u1/cu-1.jpg";
    fs.__store.set("file:///doc/upload-queue/u1/index.json", JSON.stringify([queuedItem("cu-1", stale)]));
    const [only] = await getQueuedUploads("u1");
    expect(only.uri).toBe("file:///doc/upload-queue/u1/cu-1.jpg");
  });

  it("leaves a non-durable (remote) uri untouched", async () => {
    const remote = "https://cdn.example.com/x.jpg?sig=y";
    fs.__store.set("file:///doc/upload-queue/u1/index.json", JSON.stringify([queuedItem("cu-1", remote)]));
    const [only] = await getQueuedUploads("u1");
    expect(only.uri).toBe(remote);
  });

  it("leaves a uri already rooted at the live dir unchanged", async () => {
    const live = "file:///doc/upload-queue/u1/cu-1.jpg";
    fs.__store.set("file:///doc/upload-queue/u1/index.json", JSON.stringify([queuedItem("cu-1", live)]));
    const [only] = await getQueuedUploads("u1");
    expect(only.uri).toBe(live);
  });
});
