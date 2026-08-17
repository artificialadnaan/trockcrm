import {
  MAX_WEEKLY_REPORT_CAPTION_CHARS,
  MAX_WEEKLY_REPORT_PHOTOS,
  MAX_WEEKLY_REPORT_SECTION_CHARS,
  createWeeklyReportDraft,
  parseWeeklyReportDelayDays,
  parseWeeklyReportPercent,
  weeklyReportDraftBlocker,
  weeklyReportDraftFromDetail,
  weeklyReportDraftPendingUploads,
  weeklyReportDraftReducer,
  weeklyReportDraftSectionsFilled,
  weeklyReportDraftToPatch,
  weeklyReportDraftToPhotoPayload,
  weeklyReportPhotoPreviewUri,
  weeklyReportStepAt,
  weeklyReportStepIndex,
  type WeeklyReportDraft,
  type WeeklyReportDraftPhoto,
} from "../draft";

function newDraft(overrides: Partial<WeeklyReportDraft> = {}): WeeklyReportDraft {
  return {
    ...createWeeklyReportDraft({
      id: "draft-1",
      clientSubmissionId: "sub-1",
      weeklyReportProjectId: "wrp-1",
      dealId: "deal-1",
      projectName: "4123 Cedar Springs",
      weekOf: "2026-08-13",
      now: 0,
    }),
    ...overrides,
  };
}

function galleryPhoto(fileId: string, overrides: Partial<WeeklyReportDraftPhoto> = {}): WeeklyReportDraftPhoto {
  return {
    key: fileId,
    fileId,
    caption: "",
    originalDescription: null,
    remoteUrl: `https://example.test/${fileId}.jpg`,
    localUri: null,
    takenAt: null,
    ...overrides,
  };
}

describe("creating a draft", () => {
  it("prefills last week's numbers as TEXT so a half-typed decimal survives", () => {
    const draft = createWeeklyReportDraft({
      id: "d",
      clientSubmissionId: "s",
      weeklyReportProjectId: "p",
      dealId: "deal",
      projectName: "Job",
      weekOf: "2026-08-13",
      completionPercent: 12.5,
      weatherDelayDays: 2,
      now: 0,
    });
    expect(draft.completionPercent).toBe("12.5");
    expect(draft.weatherDelayDays).toBe("2");
    expect(draft.step).toBe("work");
    expect(draft.mode).toBe("author");
  });

  it("leaves the numbers blank rather than zero when there is no previous report", () => {
    // A prefilled 0 would be indistinguishable from a superintendent asserting the job has not started.
    const draft = createWeeklyReportDraft({
      id: "d",
      clientSubmissionId: "s",
      weeklyReportProjectId: "p",
      dealId: "deal",
      projectName: "Job",
      weekOf: "2026-08-13",
      completionPercent: null,
      weatherDelayDays: null,
      now: 0,
    });
    expect(draft.completionPercent).toBe("");
    expect(draft.weatherDelayDays).toBe("");
  });
});

describe("seeding from a server report", () => {
  const detail = {
    id: "report-1",
    weeklyReportProjectId: "wrp-1",
    dealId: "deal-1",
    weekOf: "2026-08-13",
    status: "pending_review" as const,
    workCompleted: "- Poured the north slab",
    nextWeekLookAhead: null,
    issuesConcerns: null,
    completionPercent: 12.5,
    weatherDelayDays: 2,
    photos: [
      {
        fileId: "f1",
        caption: "Edited for the client",
        originalDescription: "north stair landing, pre-pour",
        takenAt: "2026-08-11T15:00:00Z",
        thumbnailUrl: "https://example.test/f1.jpg",
      },
    ],
  };

  it("carries the REPORT's caption, not the capture description", () => {
    // The whole point of the separate column: a caption written for a client must not overwrite what the
    // crew typed on site, and must not be overwritten BY it on the next load either.
    const draft = weeklyReportDraftFromDetail({
      id: "d",
      clientSubmissionId: "s",
      projectName: "Job",
      mode: "review",
      report: detail,
      now: 0,
    });
    expect(draft.photos[0].caption).toBe("Edited for the client");
    expect(draft.photos[0].originalDescription).toBe("north stair landing, pre-pour");
    expect(draft.mode).toBe("review");
    expect(draft.reportId).toBe("report-1");
  });

  it("turns absent prose into empty strings, not the literal null", () => {
    const draft = weeklyReportDraftFromDetail({
      id: "d",
      clientSubmissionId: "s",
      projectName: "Job",
      mode: "author",
      report: detail,
      now: 0,
    });
    expect(draft.nextWeekLookAhead).toBe("");
    expect(draft.issuesConcerns).toBe("");
  });
});

describe("prose sections", () => {
  it("appends a dictated paragraph on its own line instead of replacing what is there", () => {
    const draft = weeklyReportDraftReducer(
      newDraft({ workCompleted: "- Poured the north slab" }),
      { type: "appendSection", key: "workCompleted", text: "- Balcony mock up complete" },
    );
    expect(draft.workCompleted).toBe("- Poured the north slab\n- Balcony mock up complete");
  });

  it("appends into an empty section without a leading newline", () => {
    const draft = weeklyReportDraftReducer(newDraft(), {
      type: "appendSection",
      key: "issuesConcerns",
      text: "- Permit pending",
    });
    expect(draft.issuesConcerns).toBe("- Permit pending");
  });

  it("ignores a blank transcript", () => {
    const before = newDraft({ workCompleted: "kept" });
    expect(weeklyReportDraftReducer(before, { type: "appendSection", key: "workCompleted", text: "   " }))
      .toEqual(before);
  });

  it("caps a dictated append at the server's section limit", () => {
    // Dictation appends programmatically, so a TextInput maxLength never applies — without the cap the
    // user sees a complete section while the PATCH 400s at submit.
    const draft = weeklyReportDraftReducer(newDraft(), {
      type: "appendSection",
      key: "workCompleted",
      text: "x".repeat(MAX_WEEKLY_REPORT_SECTION_CHARS + 500),
    });
    expect(draft.workCompleted).toHaveLength(MAX_WEEKLY_REPORT_SECTION_CHARS);
  });
});

describe("photos", () => {
  it("adds a photo and refuses the same key twice", () => {
    // A double-tap on a candidate tile would otherwise send the same fileId twice, which the server
    // rejects outright — surfacing as a failed submit long after the tap.
    let draft = weeklyReportDraftReducer(newDraft(), { type: "addPhoto", photo: galleryPhoto("f1") });
    draft = weeklyReportDraftReducer(draft, { type: "addPhoto", photo: galleryPhoto("f1") });
    expect(draft.photos).toHaveLength(1);
  });

  it("refuses to exceed the server's photo cap", () => {
    let draft = newDraft();
    for (let i = 0; i < MAX_WEEKLY_REPORT_PHOTOS + 5; i += 1) {
      draft = weeklyReportDraftReducer(draft, { type: "addPhoto", photo: galleryPhoto(`f${i}`) });
    }
    expect(draft.photos).toHaveLength(MAX_WEEKLY_REPORT_PHOTOS);
  });

  it("caps a caption at the server's limit", () => {
    let draft = weeklyReportDraftReducer(newDraft(), { type: "addPhoto", photo: galleryPhoto("f1") });
    draft = weeklyReportDraftReducer(draft, {
      type: "setPhotoCaption",
      key: "f1",
      caption: "y".repeat(MAX_WEEKLY_REPORT_CAPTION_CHARS + 100),
    });
    expect(draft.photos[0].caption).toHaveLength(MAX_WEEKLY_REPORT_CAPTION_CHARS);
  });

  it("reorders one position at a time and is a no-op at the ends", () => {
    let draft = newDraft({ photos: [galleryPhoto("a"), galleryPhoto("b"), galleryPhoto("c")] });
    draft = weeklyReportDraftReducer(draft, { type: "movePhoto", key: "c", direction: -1 });
    expect(draft.photos.map((p) => p.fileId)).toEqual(["a", "c", "b"]);
    draft = weeklyReportDraftReducer(draft, { type: "movePhoto", key: "a", direction: -1 });
    expect(draft.photos.map((p) => p.fileId)).toEqual(["a", "c", "b"]);
  });

  it("keeps an import's key when the upload assigns its fileId", () => {
    // The key is the clientUploadId for an import. If resolving the upload renamed it to the fileId, a
    // caption typed while it was uploading would be orphaned and `removePhoto` would miss.
    let draft = weeklyReportDraftReducer(newDraft(), {
      type: "addPhoto",
      photo: {
        key: "upload-1",
        fileId: null,
        caption: "typed while uploading",
        originalDescription: null,
        remoteUrl: null,
        localUri: "file:///doc/weekly-report-drafts/u/draft-1/upload-1.jpg",
        clientUploadId: "upload-1",
        takenAt: null,
      },
    });
    draft = weeklyReportDraftReducer(draft, {
      type: "resolvePhotoUpload",
      key: "upload-1",
      fileId: "file-9",
      remoteUrl: "https://example.test/file-9.jpg",
    });
    expect(draft.photos[0]).toMatchObject({
      key: "upload-1",
      fileId: "file-9",
      caption: "typed while uploading",
    });
  });

  it("prefers the durable local copy over a presigned url for preview", () => {
    // Presigned urls expire; the local copy does not, and draft-store rebases it after a container move.
    expect(
      weeklyReportPhotoPreviewUri(
        galleryPhoto("f1", { localUri: "file:///doc/x.jpg", remoteUrl: "https://example.test/f1.jpg" }),
      ),
    ).toBe("file:///doc/x.jpg");
    expect(weeklyReportPhotoPreviewUri(galleryPhoto("f1"))).toBe("https://example.test/f1.jpg");
  });

  it("refreshes only the urls the read covered, leaving the rest alone", () => {
    // A partial read must not blank a thumbnail that still renders.
    const draft = weeklyReportDraftReducer(
      newDraft({ photos: [galleryPhoto("a"), galleryPhoto("b")] }),
      { type: "refreshPhotoUrls", urlsByFileId: { a: "https://example.test/fresh.jpg" } },
    );
    expect(draft.photos[0].remoteUrl).toBe("https://example.test/fresh.jpg");
    expect(draft.photos[1].remoteUrl).toBe("https://example.test/b.jpg");
  });

  it("clears a url on an EXPLICIT null", () => {
    const draft = weeklyReportDraftReducer(newDraft({ photos: [galleryPhoto("a")] }), {
      type: "refreshPhotoUrls",
      urlsByFileId: { a: null },
    });
    expect(draft.photos[0].remoteUrl).toBeNull();
  });
});

describe("the wire payloads", () => {
  it("sends every field, using explicit nulls for what the author cleared", () => {
    // An omitted key would leave the previous text on the server, so a section the author deliberately
    // deleted would still print on the client's report.
    const patch = weeklyReportDraftToPatch(
      newDraft({ workCompleted: "  - Slab poured  ", nextWeekLookAhead: "", completionPercent: "12.5" }),
    );
    expect(patch).toEqual({
      workCompleted: "- Slab poured",
      nextWeekLookAhead: null,
      issuesConcerns: null,
      completionPercent: 12.5,
      weatherDelayDays: null,
    });
  });

  it("refuses to build a patch from an unparseable number", () => {
    expect(weeklyReportDraftToPatch(newDraft({ completionPercent: "140" }))).toBeNull();
    expect(weeklyReportDraftToPatch(newDraft({ weatherDelayDays: "1.5" }))).toBeNull();
  });

  it("sends photos in draft order and omits ones still uploading", () => {
    const payload = weeklyReportDraftToPhotoPayload(
      newDraft({
        photos: [
          galleryPhoto("b", { caption: " Balcony " }),
          { ...galleryPhoto("pending"), key: "pending", fileId: null, clientUploadId: "pending" },
          galleryPhoto("a"),
        ],
      }),
    );
    // Order IS the print order, and a null fileId would fail the whole PUT and drop the entire selection.
    expect(payload).toEqual([
      { fileId: "b", caption: "Balcony" },
      { fileId: "a", caption: null },
    ]);
  });

  it("counts the still-uploading photos so submit can wait for them", () => {
    const draft = newDraft({
      photos: [galleryPhoto("a"), { ...galleryPhoto("p"), key: "p", fileId: null, clientUploadId: "p" }],
    });
    expect(weeklyReportDraftPendingUploads(draft)).toHaveLength(1);
  });
});

describe("number parsing", () => {
  it.each([
    ["", null],
    ["  ", null],
    ["0", 0],
    ["100", 100],
    ["12.505", 12.51],
  ])("percent %p parses to %p", (input, expected) => {
    expect(parseWeeklyReportPercent(input as string)).toBe(expected);
  });

  it.each(["-1", "101", "abc"])("rejects percent %p", (input) => {
    expect(parseWeeklyReportPercent(input)).toBeUndefined();
  });

  it.each(["1.5", "-2", "abc"])("rejects delay days %p", (input) => {
    expect(parseWeeklyReportDelayDays(input)).toBeUndefined();
  });
});

describe("the submit gate", () => {
  it("mirrors the server's own refusal to queue an empty report for review", () => {
    expect(weeklyReportDraftBlocker(newDraft())).toMatch(/completed this week/i);
  });

  it("blocks on a bad number and on a photo still uploading", () => {
    expect(weeklyReportDraftBlocker(newDraft({ workCompleted: "done", completionPercent: "999" })))
      .toMatch(/between 0 and 100/i);
    expect(
      weeklyReportDraftBlocker(
        newDraft({
          workCompleted: "done",
          photos: [{ ...galleryPhoto("p"), key: "p", fileId: null, clientUploadId: "p" }],
        }),
      ),
    ).toMatch(/still uploading/i);
  });

  it("clears once the report says something and every photo has landed", () => {
    expect(
      weeklyReportDraftBlocker(newDraft({ workCompleted: "- Slab poured", photos: [galleryPhoto("a")] })),
    ).toBeNull();
  });
});

describe("recording where the server moved the report", () => {
  it("advances serverStatus so a retry does not ask for a transition that already happened", () => {
    // The failure this closes: submit transitions the report, then the LOCAL disk delete throws. The user
    // still holds the draft, taps Submit again, and gets a 409 for work that succeeded.
    const draft = weeklyReportDraftReducer(newDraft({ workCompleted: "done" }), {
      type: "setServerStatus",
      status: "pending_review",
    });
    expect(draft.serverStatus).toBe("pending_review");
  });
});

describe("step arithmetic", () => {
  it("clamps at both ends rather than walking off the wizard", () => {
    expect(weeklyReportStepAt(-3)).toBe("work");
    expect(weeklyReportStepAt(99)).toBe("review");
    expect(weeklyReportStepIndex("photos")).toBe(4);
  });

  it("counts only the sections that have text", () => {
    expect(weeklyReportDraftSectionsFilled(newDraft({ workCompleted: "a", issuesConcerns: "  " }))).toBe(1);
  });
});
