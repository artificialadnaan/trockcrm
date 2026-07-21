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
import { saveScorecardDraft, listScorecardDrafts, deleteScorecardDraft } from "../draft-store";
import type { ScorecardDraft, ScorecardDraftPhoto } from "../draft";
import { FIELD_SCORECARD_SECTION_KEYS } from "../scoring";

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

describe("draft-store: photo URI rebasing on resume (rotated iOS container)", () => {
  // A stale container path from a PRIOR install (different UUID), including the /Documents/ segment so it
  // reads as a durable-store uri. The mock's live documentDirectory is file:///doc/.
  const STALE = "file:///var/mobile/Containers/Data/Application/OLD-1111/Documents/";
  function photo(uri: string): ScorecardDraftPhoto {
    return { key: "p1", uri, clientUploadId: "cu-1", sectionKey: FIELD_SCORECARD_SECTION_KEYS[0], caption: "" };
  }
  function draftWithPhoto(id: string, uri: string): ScorecardDraft {
    return { ...draft(id), photos: [photo(uri)] };
  }

  it("rebases a stale-container photo uri onto the live per-draft directory on load", async () => {
    await saveScorecardDraft("u1", draftWithPhoto("a", `${STALE}scorecard-drafts/u1/a/cu-1.jpg`), 1);
    const loaded = await listScorecardDrafts("u1");
    // Healed onto the live doc dir (file:///doc/scorecard-drafts/<owner>/a/), keeping the deterministic
    // <clientUploadId><ext> filename — so the resumed draft's photo renders and submit's copyAsync succeeds.
    expect(loaded[0].photos[0].uri).toMatch(/^file:\/\/\/doc\/scorecard-drafts\/.*\/a\/cu-1\.jpg$/);
    expect(loaded[0].photos[0].uri).not.toContain("OLD-1111");
  });

  it("leaves an already-live photo uri unchanged (idempotent)", async () => {
    await saveScorecardDraft("u1", draftWithPhoto("a", `${STALE}scorecard-drafts/u1/a/cu-1.jpg`), 1);
    const liveUri = (await listScorecardDrafts("u1"))[0].photos[0].uri;
    await saveScorecardDraft("u1", draftWithPhoto("a", liveUri), 2);
    expect((await listScorecardDrafts("u1"))[0].photos[0].uri).toBe(liveUri);
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

  it("a concurrent save + delete of the SAME id leaves a consistent index (no duplicate / corruption)", async () => {
    await saveScorecardDraft("u1", draft("a"), 1);
    await Promise.all([
      saveScorecardDraft("u1", draft("a"), 2), // re-save the same draft
      deleteScorecardDraft("u1", "a"), // ...while deleting it
    ]);
    const list = await listScorecardDrafts("u1");
    // The mutex serializes the two RMWs, so the result is one clean state — never a duplicate or a
    // half-written index. Either ends deleted (delete last) or present exactly once (save last).
    expect(list.filter((d) => d.id === "a").length).toBeLessThanOrEqual(1);
    expect([0, 1]).toContain(list.length);
  });
});
