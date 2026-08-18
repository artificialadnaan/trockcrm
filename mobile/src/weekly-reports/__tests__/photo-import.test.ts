// The ORDER of the batch import, which is the whole of its correctness.
//
// The regression this file exists for: nothing was written to the durable draft until a live-GPS lookup
// (up to 8s indoors) had resolved, and each asset after the first waited for every earlier asset's network
// upload. A user who picked a dozen photos and pocketed the phone kept only however many had made it
// through — the rest had never been recorded anywhere, so the retry path (which works off photos already
// attached to the draft) could not bring them back either.
//
// Every dependency is injected, so the assertions here are about sequencing rather than about
// expo-image-picker or the uploader.

import {
  importWeeklyReportPhotoBatch,
  weeklyReportImportNotice,
  type WeeklyReportImportAsset,
  type WeeklyReportImportDeps,
} from "../photo-import";

/** EXIF with a usable fix, so a batch can be made to need no live lookup at all. */
const WITH_COORDS = {
  GPSLatitude: 32.81,
  GPSLatitudeRef: "N",
  GPSLongitude: 96.79,
  GPSLongitudeRef: "W",
  DateTimeOriginal: "2026:08:11 09:30:00",
};

function assets(count: number, exif: Record<string, unknown> | null = null): WeeklyReportImportAsset[] {
  return Array.from({ length: count }, (_, i) => ({
    uri: `ph://asset-${i}`,
    width: 4032,
    height: 3024,
    exif,
  }));
}

type Harness = {
  deps: WeeklyReportImportDeps;
  events: string[];
  attached: string[];
  resolveGps: () => void;
  /** Uploads park here until released, so "did the batch persist first?" is observable. */
  releaseUploads: () => void;
};

function harness(
  overrides: Partial<WeeklyReportImportDeps> & { holdGps?: boolean; holdUploads?: boolean } = {},
): Harness {
  const events: string[] = [];
  const attached: string[] = [];
  let letGpsThrough = () => {};
  let letUploadsThrough = () => {};
  const gpsGate = overrides.holdGps
    ? new Promise<void>((resolve) => {
        letGpsThrough = resolve;
      })
    : Promise.resolve();
  const uploadGate = overrides.holdUploads
    ? new Promise<void>((resolve) => {
        letUploadsThrough = resolve;
      })
    : Promise.resolve();

  let seq = 0;
  const deps: WeeklyReportImportDeps = {
    newClientUploadId: () => `cu-${seq++}`,
    copyIntoDraft: async (clientUploadId, srcUri) => {
      events.push(`copy:${srcUri}`);
      return `file:///draft/${clientUploadId}.jpg`;
    },
    addPhoto: (photo) => {
      events.push(`attach:${photo.key}`);
      attached.push(photo.key);
    },
    getLiveGps: async () => {
      events.push("gps:start");
      await gpsGate;
      events.push("gps:done");
      return { latitude: 32.8, longitude: -96.8, addressSource: "live_gps", takenAt: "2026-08-13T12:00:00.000Z" };
    },
    upload: async (input) => {
      events.push(`upload:${input.clientUploadId}`);
      await uploadGate;
      return { fileId: `file-${input.clientUploadId}`, remoteUrl: `https://cdn/${input.clientUploadId}` };
    },
    resolveUpload: (clientUploadId) => events.push(`resolved:${clientUploadId}`),
    ...overrides,
  };

  return { deps, events, attached, resolveGps: () => letGpsThrough(), releaseUploads: () => letUploadsThrough() };
}

describe("weekly-report batch import", () => {
  it("copies and attaches EVERY picked asset before it waits for GPS", async () => {
    const h = harness({ holdGps: true });
    const run = importWeeklyReportPhotoBatch(assets(3), h.deps);

    // Let the three local copies settle. The GPS gate is still shut, so if any asset were waiting on it
    // the draft would be missing photos at this point — which is precisely the kill-window bug.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.attached).toEqual(["cu-0", "cu-1", "cu-2"]);

    h.resolveGps();
    await run;
  });

  it("does not make one photo's upload a precondition for the next one being persisted", async () => {
    const h = harness({ holdUploads: true });
    const run = importWeeklyReportPhotoBatch(assets(3), h.deps);

    await new Promise((resolve) => setTimeout(resolve, 0));
    // Everything is on the draft and only the FIRST upload has been started.
    expect(h.attached).toHaveLength(3);
    expect(h.events.filter((e) => e.startsWith("upload:"))).toEqual(["upload:cu-0"]);

    h.releaseUploads();
    await run;

    // The full shape: persist the batch, one GPS lookup, then the uploads.
    expect(h.events).toEqual([
      "copy:ph://asset-0",
      "attach:cu-0",
      "copy:ph://asset-1",
      "attach:cu-1",
      "copy:ph://asset-2",
      "attach:cu-2",
      "gps:start",
      "gps:done",
      "upload:cu-0",
      "resolved:cu-0",
      "upload:cu-1",
      "resolved:cu-1",
      "upload:cu-2",
      "resolved:cu-2",
    ]);
  });

  it("skips the GPS lookup entirely when every shot already carries a fix", async () => {
    const h = harness();
    const outcome = await importWeeklyReportPhotoBatch(assets(2, WITH_COORDS), h.deps);
    expect(h.events).not.toContain("gps:start");
    expect(outcome).toEqual({ persisted: 2, failedToPersist: 0, failedToUpload: 0 });
  });

  it("keeps the rest of the batch when one upload fails, and reports it", async () => {
    const h = harness({
      upload: async (input) => {
        if (input.clientUploadId === "cu-1") throw new Error("socket closed");
        return { fileId: `file-${input.clientUploadId}`, remoteUrl: null };
      },
    });
    const outcome = await importWeeklyReportPhotoBatch(assets(3), h.deps);

    expect(outcome).toEqual({ persisted: 3, failedToPersist: 0, failedToUpload: 1 });
    // The failed one stays attached with no fileId — weeklyReportDraftBlocker holds submit until it lands.
    expect(h.attached).toEqual(["cu-0", "cu-1", "cu-2"]);
    expect(h.events).toContain("resolved:cu-2");
    expect(h.events).not.toContain("resolved:cu-1");
  });

  it("counts a copy failure separately, and still persists and uploads the others", async () => {
    const h = harness({
      copyIntoDraft: async (clientUploadId, srcUri) => {
        if (srcUri === "ph://asset-0") throw new Error("source vanished");
        return `file:///draft/${clientUploadId}.jpg`;
      },
    });
    const outcome = await importWeeklyReportPhotoBatch(assets(3), h.deps);

    expect(outcome).toEqual({ persisted: 2, failedToPersist: 1, failedToUpload: 0 });
    expect(h.attached).toEqual(["cu-1", "cu-2"]);
  });

  it("does no work at all when nothing could be persisted", async () => {
    const h = harness({
      copyIntoDraft: async () => {
        throw new Error("no space");
      },
    });
    const outcome = await importWeeklyReportPhotoBatch(assets(2), h.deps);
    expect(outcome).toEqual({ persisted: 0, failedToPersist: 2, failedToUpload: 0 });
    expect(h.events).not.toContain("gps:start");
  });

  it("sends the live fix but never the live TIMESTAMP, so a late report keeps its photos", async () => {
    // A photo restamped to `now` falls outside the 14-day window the picker filters on and vanishes from
    // its own selection on reload.
    const seen: Array<{ latitude?: number; takenAt?: string }> = [];
    const h = harness({
      upload: async (input) => {
        seen.push({ latitude: input.metadata.latitude, takenAt: input.metadata.takenAt });
        return { fileId: "f", remoteUrl: null };
      },
    });
    await importWeeklyReportPhotoBatch(
      [{ uri: "ph://a", exif: { DateTimeOriginal: "2026:08:11 09:30:00" } }],
      h.deps,
    );
    expect(seen[0]!.latitude).toBe(32.8);
    expect(seen[0]!.takenAt).toBe(new Date(2026, 7, 11, 9, 30, 0).toISOString());
  });
});

describe("weeklyReportImportNotice", () => {
  it("says nothing when everything landed", () => {
    expect(weeklyReportImportNotice({ persisted: 4, failedToPersist: 0, failedToUpload: 0 })).toBeNull();
  });

  it("keeps a lost pick and a stalled upload as different problems", () => {
    // They call for opposite actions — re-pick vs wait for signal — so collapsing them would send someone
    // back to the gallery for photos already visible on the report.
    const notice = weeklyReportImportNotice({ persisted: 2, failedToPersist: 1, failedToUpload: 2 })!;
    expect(notice).toContain("1 photo couldn’t be added");
    expect(notice).toContain("2 photos couldn’t upload");
  });
});
