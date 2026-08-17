// Crash-safety, concurrency and container-rebase coverage for the weekly-report draft store.
// expo-file-system is replaced with an in-memory FS (the store lives inside the factory closure, so no
// jest-hoist TDZ) so the exact interrupted-write states writeIndex can leave behind can be staged.
jest.mock("expo-file-system/legacy", () => {
  const store = new Map<string, string>();
  const dirs = new Set<string>();
  const norm = (p: string) => p.replace(/\/$/, "");
  return {
    __store: store,
    __reset: () => {
      store.clear();
      dirs.clear();
    },
    documentDirectory: "file:///doc/",
    getInfoAsync: async (p: string) => ({ exists: store.has(p) || dirs.has(p) || dirs.has(norm(p)) }),
    makeDirectoryAsync: async (d: string) => {
      dirs.add(d);
      dirs.add(norm(d));
    },
    readAsStringAsync: async (p: string) => {
      if (!store.has(p)) throw new Error(`ENOENT ${p}`);
      return store.get(p)!;
    },
    writeAsStringAsync: async (p: string, data: string) => {
      store.set(p, data);
    },
    deleteAsync: async (p: string) => {
      store.delete(p);
      dirs.delete(p);
      dirs.delete(norm(p));
      // Real expo-file-system deletes a directory's contents, so drop anything under the deleted path.
      const prefix = `${norm(p)}/`;
      for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key);
      for (const dir of [...dirs]) if (dir.startsWith(prefix)) dirs.delete(dir);
    },
    moveAsync: async ({ from, to }: { from: string; to: string }) => {
      if (!store.has(from)) throw new Error(`ENOENT move ${from}`);
      store.set(to, store.get(from)!);
      store.delete(from);
    },
    copyAsync: async ({ from, to }: { from: string; to: string }) => {
      store.set(to, store.get(from) ?? "");
    },
  };
});

import * as FileSystem from "expo-file-system/legacy";
import {
  copyPhotoIntoWeeklyDraft,
  deleteWeeklyDraftPhotoFile,
  deleteWeeklyReportDraft,
  listWeeklyReportDrafts,
  loadWeeklyReportDraft,
  saveWeeklyReportDraft,
} from "../draft-store";
import type { WeeklyReportDraft, WeeklyReportDraftPhoto } from "../draft";

const fs = FileSystem as unknown as { __store: Map<string, string>; __reset: () => void };

function draft(id: string, photos: WeeklyReportDraftPhoto[] = []): WeeklyReportDraft {
  return {
    id,
    clientSubmissionId: `sub-${id}`,
    weeklyReportProjectId: "wrp-1",
    reportId: null,
    dealId: "deal-1",
    projectName: "4123 Cedar Springs",
    weekOf: "2026-08-13",
    mode: "author",
    serverStatus: null,
    step: "work",
    workCompleted: "",
    nextWeekLookAhead: "",
    issuesConcerns: "",
    completionPercent: "",
    weatherDelayDays: "",
    photos,
    createdAt: 0,
    updatedAt: 0,
  };
}

function indexPath(): string {
  const key = [...fs.__store.keys()].find((k) => k.endsWith("index.json"));
  if (!key) throw new Error("no index written yet");
  return key;
}

beforeEach(() => fs.__reset());

describe("atomic write", () => {
  it("leaves ONLY the live index behind — no stray .tmp", async () => {
    await saveWeeklyReportDraft("u1", draft("a"), 1);
    const keys = [...fs.__store.keys()];
    expect(keys.some((k) => k.endsWith("index.json"))).toBe(true);
    expect(keys.some((k) => k.endsWith("index.json.tmp"))).toBe(false);
    expect((await listWeeklyReportDrafts("u1")).map((d) => d.id)).toEqual(["a"]);
  });

  it("stamps updatedAt at persist time, keeping the reducer time-free", async () => {
    await saveWeeklyReportDraft("u1", draft("a"), 1234);
    expect((await loadWeeklyReportDraft("u1", "a"))!.updatedAt).toBe(1234);
  });

  it("returns [] rather than throwing when nothing has been written", async () => {
    expect(await listWeeklyReportDrafts("u1")).toEqual([]);
  });
});

describe("interrupted-write recovery", () => {
  it("prefers a COMPLETE .tmp over the stale live index", async () => {
    // The only state that produces a .tmp is an interruption after the temp file was fully written but
    // before the rename — and it holds the NEWEST intended state. Reading the live index first would
    // return the pre-save copy, and the next save would overwrite the newer edit already on disk.
    await saveWeeklyReportDraft("u1", draft("a"), 1);
    const path = indexPath();
    const newer = [{ ...draft("a"), workCompleted: "newer", updatedAt: 2 }];
    fs.__store.set(`${path}.tmp`, JSON.stringify(newer));

    expect((await listWeeklyReportDrafts("u1"))[0].workCompleted).toBe("newer");
  });

  it("falls through to the live index when the .tmp is torn", async () => {
    await saveWeeklyReportDraft("u1", draft("a"), 1);
    fs.__store.set(`${indexPath()}.tmp`, '[{"id":"a"');
    expect((await listWeeklyReportDrafts("u1")).map((d) => d.id)).toEqual(["a"]);
  });

  it("hides nothing when the live index itself is corrupt — it just reports empty", async () => {
    await saveWeeklyReportDraft("u1", draft("a"), 1);
    fs.__store.set(indexPath(), "not json");
    expect(await listWeeklyReportDrafts("u1")).toEqual([]);
  });
});

describe("owner isolation", () => {
  it("keeps one user's drafts out of another's list", async () => {
    await saveWeeklyReportDraft("u1:office-a", draft("a"), 1);
    await saveWeeklyReportDraft("u2:office-a", draft("b"), 1);
    expect((await listWeeklyReportDrafts("u1:office-a")).map((d) => d.id)).toEqual(["a"]);
    expect((await listWeeklyReportDrafts("u2:office-a")).map((d) => d.id)).toEqual(["b"]);
  });
});

// Deletion is remembered per owner for the life of the process (the discarded-id guard below), so each
// case here gets its own owner key — otherwise a later test re-saving the same draft id is silently a
// no-op and fails for a reason that has nothing to do with what it is asserting.
describe("deletion", () => {
  it("removes the draft and reclaims its copied photos", async () => {
    const uri = await copyPhotoIntoWeeklyDraft("del-1", "a", "upload-1", "file:///cache/pick.jpg");
    await saveWeeklyReportDraft("del-1", draft("a", [photo("upload-1", uri)]), 1);

    await deleteWeeklyReportDraft("del-1", "a");
    expect(await listWeeklyReportDrafts("del-1")).toEqual([]);
    expect(fs.__store.has(uri)).toBe(false);
  });

  it("beats an autosave queued behind it, so a filed report cannot come back", async () => {
    await saveWeeklyReportDraft("del-2", draft("a"), 1);
    const late = saveWeeklyReportDraft("del-2", { ...draft("a"), workCompleted: "late" }, 2);
    await deleteWeeklyReportDraft("del-2", "a");
    await late;
    expect(await listWeeklyReportDrafts("del-2")).toEqual([]);
  });

  it("deletes one photo file without touching the draft", async () => {
    const uri = await copyPhotoIntoWeeklyDraft("del-3", "a", "upload-1", "file:///cache/pick.jpg");
    await deleteWeeklyDraftPhotoFile(uri);
    expect(fs.__store.has(uri)).toBe(false);
  });
});

function photo(clientUploadId: string, localUri: string): WeeklyReportDraftPhoto {
  return {
    key: clientUploadId,
    fileId: null,
    caption: "",
    originalDescription: null,
    remoteUrl: null,
    localUri,
    clientUploadId,
    takenAt: null,
  };
}

describe("photo-uri rebase on resume (#938)", () => {
  it("heals a rotated iOS container path so a resumed draft's photos still render", async () => {
    // The defect: the absolute uri baked into index.json embeds the app container UUID, which rotates
    // across an update/reinstall/restore. The file moved with the container, so the stored path points at
    // nothing — blank photos, and a re-upload that rejects with an opaque error.
    const stale = "file:///var/mobile/Containers/Data/Application/OLD-UUID/Documents/weekly-report-drafts/u1/a/upload-1.jpg";
    await saveWeeklyReportDraft("u1", draft("a", [photo("upload-1", stale)]), 1);

    const [resumed] = await listWeeklyReportDrafts("u1");
    expect(resumed.photos[0].localUri).toBe("file:///doc/weekly-report-drafts/u1/a/upload-1.jpg");
  });

  it("preserves the file extension when rebasing", async () => {
    const stale = "file:///var/mobile/Containers/Data/Application/OLD/Documents/weekly-report-drafts/u1/a/upload-1.heic";
    await saveWeeklyReportDraft("u1", draft("a", [photo("upload-1", stale)]), 1);
    expect((await listWeeklyReportDrafts("u1"))[0].photos[0].localUri).toMatch(/\.heic$/);
  });

  it("leaves a gallery photo's presigned url alone", async () => {
    // Gallery photos carry no clientUploadId and no local copy; their url is refreshed from the server,
    // and rewriting it into a local path would break every thumbnail on the selection.
    const gallery: WeeklyReportDraftPhoto = {
      key: "file-1",
      fileId: "file-1",
      caption: "",
      originalDescription: null,
      remoteUrl: "https://r2.example.test/file-1.jpg?sig=abc",
      localUri: null,
      takenAt: null,
    };
    await saveWeeklyReportDraft("u1", draft("a", [gallery]), 1);
    expect((await listWeeklyReportDrafts("u1"))[0].photos[0]).toEqual(gallery);
  });

  it("leaves an ALREADY-live path untouched", async () => {
    const live = "file:///doc/weekly-report-drafts/u1/a/upload-1.jpg";
    await saveWeeklyReportDraft("u1", draft("a", [photo("upload-1", live)]), 1);
    expect((await listWeeklyReportDrafts("u1"))[0].photos[0].localUri).toBe(live);
  });
});

describe("copyPhotoIntoWeeklyDraft", () => {
  it("names the copy deterministically, which is what makes the rebase possible", async () => {
    const uri = await copyPhotoIntoWeeklyDraft("u1", "a", "upload-1", "file:///cache/IMG_0001.JPG");
    expect(uri).toBe("file:///doc/weekly-report-drafts/u1/a/upload-1.JPG");
  });

  it("falls back to .jpg for a source with no extension", async () => {
    const uri = await copyPhotoIntoWeeklyDraft("u1", "a", "upload-2", "ph://ASSET-ID");
    expect(uri).toBe("file:///doc/weekly-report-drafts/u1/a/upload-2.jpg");
  });

  it("strips a query string from the extension", async () => {
    const uri = await copyPhotoIntoWeeklyDraft("u1", "a", "upload-3", "file:///cache/pick.jpg?width=100");
    expect(uri).toBe("file:///doc/weekly-report-drafts/u1/a/upload-3.jpg");
  });
});
