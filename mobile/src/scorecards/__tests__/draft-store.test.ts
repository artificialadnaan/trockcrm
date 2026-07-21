// Crash-safety + concurrency coverage for the device-local draft store. expo-file-system is replaced with
// an in-memory FS (store lives inside the factory closure, so no jest-hoist TDZ) that lets us stage the
// exact interrupted-write states writeIndex can leave behind.
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
    deleteAsync: async (p: string) => { store.delete(p); dirs.delete(p); dirs.delete(norm(p)); },
    moveAsync: async ({ from, to }: { from: string; to: string }) => {
      if (!store.has(from)) throw new Error(`ENOENT move ${from}`);
      store.set(to, store.get(from)!);
      store.delete(from);
    },
    copyAsync: async ({ from, to }: { from: string; to: string }) => { store.set(to, store.get(from) ?? ""); },
  };
});

import * as FileSystem from "expo-file-system/legacy";
import {
  saveScorecardDraft,
  listScorecardDrafts,
  loadScorecardDraft,
  listScorecardDraftOwners,
  listScorecardDraftsForUser,
  deleteScorecardDraft,
} from "../draft-store";
import type { ScorecardDraft, NewScorecardDraftPhoto, ExistingScorecardDraftPhoto } from "../draft";

const fs = FileSystem as unknown as { __store: Map<string, string>; __reset: () => void };

function draft(id: string): ScorecardDraft {
  return {
    id, clientSubmissionId: `sub-${id}`, dealId: "d", dealName: "N", projectNumber: null,
    weekOf: "2026-06-30", superintendentName: "", pmName: "",
    scores: {}, notes: {}, photos: [], criticalDeficiencies: [], actionItems: [], createdAt: 0, updatedAt: 0,
  };
}
function indexPath(): string {
  const key = [...fs.__store.keys()].find((k) => k.endsWith("index.json"));
  if (!key) throw new Error("no index written yet");
  return key;
}

beforeEach(() => fs.__reset());

describe("draft-store: atomic write", () => {
  it("a successful save leaves ONLY the live index — no leftover .tmp", async () => {
    await saveScorecardDraft("u1", draft("a"), 1);
    const keys = [...fs.__store.keys()];
    expect(keys.some((k) => k.endsWith("index.json"))).toBe(true);
    expect(keys.some((k) => k.endsWith("index.json.tmp"))).toBe(false);
    expect((await listScorecardDrafts("u1")).map((d) => d.id)).toEqual(["a"]);
  });
});

describe("draft-store: interrupted-write recovery (listScorecardDrafts read order)", () => {
  it("returns [] when nothing is written", async () => {
    expect(await listScorecardDrafts("u1")).toEqual([]);
  });

  it("reads the live index when no .tmp exists", async () => {
    await saveScorecardDraft("u1", draft("a"), 1);
    expect((await listScorecardDrafts("u1")).map((d) => d.id)).toEqual(["a"]);
  });

  it("prefers a VALID .tmp over the live index (both present after an interrupted write)", async () => {
    await saveScorecardDraft("u1", draft("a"), 1); // live = [a]
    fs.__store.set(`${indexPath()}.tmp`, JSON.stringify([draft("b")])); // newer, fully-written tmp
    expect((await listScorecardDrafts("u1")).map((d) => d.id)).toEqual(["b"]);
  });

  it("reads a tmp-only state (live removed before the move completed)", async () => {
    await saveScorecardDraft("u1", draft("a"), 1);
    const idx = indexPath();
    fs.__store.set(`${idx}.tmp`, JSON.stringify([draft("b")]));
    fs.__store.delete(idx);
    expect((await listScorecardDrafts("u1")).map((d) => d.id)).toEqual(["b"]);
  });

  it("falls back to the live index when the .tmp is corrupt/partial", async () => {
    await saveScorecardDraft("u1", draft("a"), 1);
    fs.__store.set(`${indexPath()}.tmp`, '[{"id":"b" PARTIAL'); // unparseable
    expect((await listScorecardDrafts("u1")).map((d) => d.id)).toEqual(["a"]);
  });
});

describe("draft-store: serialization (no read-modify-write clobber)", () => {
  it("concurrent saves of different drafts BOTH persist (mutex)", async () => {
    await Promise.all([
      saveScorecardDraft("u1", draft("a"), 1),
      saveScorecardDraft("u1", draft("b"), 2),
    ]);
    expect((await listScorecardDrafts("u1")).map((d) => d.id).sort()).toEqual(["a", "b"]);
  });

  it("a save concurrent with a delete doesn't resurrect or lose the other draft", async () => {
    await saveScorecardDraft("u1", draft("a"), 1);
    await Promise.all([
      saveScorecardDraft("u1", draft("b"), 2),
      deleteScorecardDraft("u1", "a"),
    ]);
    expect((await listScorecardDrafts("u1")).map((d) => d.id)).toEqual(["b"]);
  });

  it("a concurrent save + delete of the SAME id lets deletion win", async () => {
    await saveScorecardDraft("u1", draft("a"), 1);
    await Promise.all([
      saveScorecardDraft("u1", draft("a"), 2), // re-save the same draft
      deleteScorecardDraft("u1", "a"), // ...while deleting it
    ]);
    const list = await listScorecardDrafts("u1");
    expect(list).toEqual([]);
  });

  it("ignores an autosave that arrives after a draft was discarded", async () => {
    await saveScorecardDraft("u1", draft("a"), 1);
    await deleteScorecardDraft("u1", "a");
    await saveScorecardDraft("u1", draft("a"), 2);
    expect(await listScorecardDrafts("u1")).toEqual([]);
  });
});

describe("draft-store: cross-office recovery", () => {
  it("registers every office namespace and always includes the active fallback", async () => {
    await saveScorecardDraft("recover-user:office-b", draft("cross-office"), 10);

    await expect(listScorecardDraftOwners("recover-user", "recover-user:office-a")).resolves.toEqual([
      { ownerKey: "recover-user:office-a", officeId: "office-a" },
      { ownerKey: "recover-user:office-b", officeId: "office-b" },
    ]);
  });

  it("aggregates drafts across office namespaces with the key needed to resume or discard them", async () => {
    await saveScorecardDraft("aggregate-user:office-a", draft("primary"), 10);
    await saveScorecardDraft("aggregate-user:office-b", draft("cross-office"), 20);

    const located = await listScorecardDraftsForUser("aggregate-user", "aggregate-user:office-a");
    expect(located.map(({ ownerKey, officeId, draft: item }) => ({ ownerKey, officeId, id: item.id }))).toEqual([
      { ownerKey: "aggregate-user:office-a", officeId: "office-a", id: "primary" },
      { ownerKey: "aggregate-user:office-b", officeId: "office-b", id: "cross-office" },
    ]);
  });

  it("keeps another user's registered office namespaces isolated", async () => {
    await saveScorecardDraft("isolation-user-a:office-a", draft("a"), 10);
    await saveScorecardDraft("isolation-user-b:office-b", draft("b"), 20);

    const located = await listScorecardDraftsForUser("isolation-user-a", "isolation-user-a:office-a");
    expect(located.map((entry) => entry.draft.id)).toEqual(["a"]);
  });

  it("ignores corrupt registry entries whose owner key and office do not match", async () => {
    fs.__store.set("file:///doc/scorecard-drafts/owners.json", JSON.stringify([
      { userId: "registry-user", ownerKey: "another-user:office-b", officeId: "office-b" },
      { userId: "registry-user", ownerKey: "registry-user:office-c", officeId: "wrong-office" },
    ]));

    await expect(listScorecardDraftOwners("registry-user", "registry-user:office-a")).resolves.toEqual([
      { ownerKey: "registry-user:office-a", officeId: "office-a" },
    ]);
  });
});

describe("draft-store: stale-container photo uri rebasing (the James Helms resume bug)", () => {
  const OWNER = "u1";
  // A draft whose NEW-evidence photo uri was frozen under a DIFFERENT iOS container UUID (the file physically
  // moved with the container; the baked uri is now dead). The live document dir is file:///doc/.
  function draftWithStalePhoto(id: string): ScorecardDraft {
    const stale: NewScorecardDraftPhoto = {
      key: "p1",
      uri: "file:///var/mobile/Containers/Data/Application/OLD-UUID/Documents/scorecard-drafts/u1/" + id + "/cu-1.jpg",
      clientUploadId: "cu-1",
      sectionKey: "schedule",
      caption: "",
    };
    return { ...draft(id), photos: [stale] };
  }
  // Seed an index directly (bypassing saveScorecardDraft, which would stamp a fresh uri) to model a resume
  // after a container rotation.
  async function seedIndex(id: string): Promise<void> {
    fs.__store.set(`file:///doc/scorecard-drafts/${OWNER}/index.json`, JSON.stringify([draftWithStalePhoto(id)]));
  }

  it("rebases a new-evidence photo uri onto the LIVE per-draft directory on load", async () => {
    await seedIndex("d1");
    const loaded = await loadScorecardDraft(OWNER, "d1");
    expect(loaded?.photos[0].uri).toBe("file:///doc/scorecard-drafts/u1/d1/cu-1.jpg");
  });

  it("rebases via listScorecardDrafts too (same read core)", async () => {
    await seedIndex("d1");
    const [only] = await listScorecardDrafts(OWNER);
    expect(only.photos[0].uri).toBe("file:///doc/scorecard-drafts/u1/d1/cu-1.jpg");
  });

  it("heals a stale uri surfaced via the .tmp recovery path", async () => {
    fs.__store.set(
      `file:///doc/scorecard-drafts/${OWNER}/index.json.tmp`,
      JSON.stringify([draftWithStalePhoto("d1")]),
    );
    const loaded = await loadScorecardDraft(OWNER, "d1");
    expect(loaded?.photos[0].uri).toBe("file:///doc/scorecard-drafts/u1/d1/cu-1.jpg");
  });

  it("leaves retained (existingScorecardPhotoId, presigned remote) evidence untouched", async () => {
    const retained: ExistingScorecardDraftPhoto = {
      key: "r1",
      uri: "https://cdn.example.com/evidence/abc.jpg?sig=xyz",
      existingScorecardPhotoId: "sp-1",
      sectionKey: "schedule",
      caption: "",
    };
    fs.__store.set(
      `file:///doc/scorecard-drafts/${OWNER}/index.json`,
      JSON.stringify([{ ...draft("d1"), photos: [retained] }]),
    );
    const loaded = await loadScorecardDraft(OWNER, "d1");
    expect(loaded?.photos[0].uri).toBe("https://cdn.example.com/evidence/abc.jpg?sig=xyz");
  });

  it("leaves a photo already rooted at the live directory unchanged", async () => {
    const already: NewScorecardDraftPhoto = {
      key: "p1", uri: "file:///doc/scorecard-drafts/u1/d1/cu-1.jpg", clientUploadId: "cu-1",
      sectionKey: "schedule", caption: "",
    };
    fs.__store.set(
      `file:///doc/scorecard-drafts/${OWNER}/index.json`,
      JSON.stringify([{ ...draft("d1"), photos: [already] }]),
    );
    const loaded = await loadScorecardDraft(OWNER, "d1");
    expect(loaded?.photos[0].uri).toBe("file:///doc/scorecard-drafts/u1/d1/cu-1.jpg");
  });
});
