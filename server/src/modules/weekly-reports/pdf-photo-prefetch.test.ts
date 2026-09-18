// What the photo PREFETCH does when a render is already doomed.
//
// Its own file because it fakes `loadPhotoBuffer`: the properties here are about the fan-out around it —
// how many originals get fetched after the render has failed, and whether the deadline is noticed between
// photographs — and both are invisible through the real loader, which either succeeds or fails too fast to
// observe. pdf.test.ts deliberately renders with no mocks at all.

import { describe, expect, it, vi, beforeEach } from "vitest";

const harness = vi.hoisted(() => ({
  /** Every photo index the loader was asked for, in call order. */
  calls: [] as number[],
  /** Signals the loader was handed, so "were the siblings actually cancelled?" is observable. */
  signals: [] as Array<AbortSignal | undefined>,
  /** Which index rejects, and with what. */
  failAt: null as null | number,
  /** How long each load takes. */
  delayMs: 1,
  /** When false the fake ignores its signal — which isolates the loop's own abort check. */
  honourSignal: true,
}));

vi.mock("../field/pdf-layout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../field/pdf-layout.js")>();
  return {
    ...actual,
    loadPhotoBuffer: async (
      photo: { id: string },
      signal: AbortSignal | undefined,
    ): Promise<Buffer | null> => {
      const index = Number(photo.id.replace("file-", ""));
      harness.calls.push(index);
      harness.signals.push(signal);
      if (harness.failAt === index) throw new Error("R2: socket hang up");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, harness.delayMs);
        if (!harness.honourSignal || !signal) return;
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("read aborted"));
          },
          { once: true },
        );
      });
      return null;
    },
  };
});

const { renderWeeklyReportPdf } = await import("./pdf.js");

const CREATION_DATE = new Date("2026-08-13T21:00:00.000Z");

function data(photoCount: number) {
  return {
    propertyName: "4123 Cedar Springs",
    weekOfLabel: "8/13/26",
    clientName: "Mack Real Estate Group",
    clientTeam: [{ label: "DOC", name: "Jay Stauble" }],
    trockTeam: [{ label: "PM", name: "Adam Sherwood" }],
    workCompleted: "- Material delivered for balcony mock up",
    nextWeekLookAhead: null,
    issuesConcerns: null,
    schedule: {
      contractDate: "7/8/26",
      projectStartDate: "TBD Permit",
      projectCompletionDate: "TBD Permit",
      completionPercent: "0",
      weatherDelayDays: "0",
    },
    duration: { projectedWeeks: 19, remainingWeeks: 0 },
    photos: Array.from({ length: photoCount }, (_, index) => ({
      fileId: `file-${index}`,
      caption: `Caption ${index}`,
      r2Key: `k/${index}.jpg`,
      externalUrl: null,
      externalThumbnailUrl: null,
      mimeType: "image/jpeg",
    })),
    version: 1,
    superseded: false,
    creationDate: CREATION_DATE,
  };
}

/** Let the workers that were NOT stopped get on with it, so their fetches are counted. */
async function settle(ms = 200) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  harness.calls.length = 0;
  harness.signals.length = 0;
  harness.failAt = null;
  harness.delayMs = 1;
  harness.honourSignal = true;
});

describe("the photo prefetch, when one photo fails the render", () => {
  it("stops the other workers instead of downloading the rest of the report", async () => {
    // `Promise.all` rejects on the first failure and cancels NOTHING. On this route that mattered: a render
    // that fails on photo #1 answers the anonymous request in milliseconds while two workers carry on
    // pulling indices off the shared cursor, fetching and transcoding all 59 remaining originals — up to
    // 40 MB each — for a document that can never be produced. The coalescer entry is cleared on rejection
    // and the deadline backoff deliberately does not cover this class, so one reader on a broken report
    // pressing reload drove fan after overlapping fan of R2 GETs.
    harness.failAt = 0;
    const caller = new AbortController();

    await expect(
      renderWeeklyReportPdf(data(60), { signal: caller.signal, timeoutMs: 30_000 }),
    ).rejects.toThrow(/socket hang up/);
    await settle();

    // Three workers, three photos started, and then nothing: not 60.
    expect(harness.calls).toHaveLength(3);
    // The cancellation is real rather than incidental — the siblings' signal fired.
    expect(harness.signals.at(-1)?.aborted).toBe(true);
    // …and it did NOT reach through to the caller's signal. `pdf-service` asks the render DEADLINE whether
    // it fired to decide between "timed out, back off for a minute" and "failed, try again now"; aborting
    // the caller's signal here would file every strict failure as a timeout.
    expect(caller.signal.aborted).toBe(false);
  });

  it("still loads every photo when nothing fails", async () => {
    // The control. A cancellation that fires on the happy path would leave a report with photographs
    // missing — and the placeholder tile is indistinguishable from a photo that genuinely could not load.
    const pdf = await renderWeeklyReportPdf(data(7), { timeoutMs: 30_000 });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect([...harness.calls].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("the photo prefetch, when the deadline fires", () => {
  it("notices BETWEEN photographs rather than only at the end", async () => {
    // The deadline is otherwise only observed by the layers that accept a signal — an R2 read, a transcode
    // race. A report whose photos resolve from something that does not check it (a cache, a stub, a fast
    // local decode) would run the whole loop to completion and only then be told the budget had gone,
    // having spent it all on a document nobody is waiting for. The fake ignores its signal here precisely
    // so the loop's own check is the only thing that can stop it.
    harness.honourSignal = false;
    harness.delayMs = 20;

    await expect(renderWeeklyReportPdf(data(60), { timeoutMs: 40 })).rejects.toThrow();
    await settle();

    // Exact, not approximate: without the in-loop check every one of the 60 is fetched.
    expect(harness.calls.length).toBeGreaterThan(0);
    expect(harness.calls.length).toBeLessThan(60);
  });
});
