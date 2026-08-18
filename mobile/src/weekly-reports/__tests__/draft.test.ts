import {
  MAX_WEEKLY_REPORT_CAPTION_CHARS,
  MAX_WEEKLY_REPORT_PHOTOS,
  MAX_WEEKLY_REPORT_SECTION_CHARS,
  WEEKLY_REPORT_EMPTY_SIGNATURE,
  createWeeklyReportDraft,
  parseWeeklyReportDelayDays,
  parseWeeklyReportPercent,
  weeklyReportContentSignature,
  weeklyReportDraftBlocker,
  weeklyReportDraftFromDetail,
  weeklyReportDraftPendingUploads,
  weeklyReportDraftReducer,
  weeklyReportDraftSectionsFilled,
  weeklyReportDraftSignature,
  weeklyReportDraftToPatch,
  weeklyReportDraftToPhotoPayload,
  weeklyReportPhotoPreviewUri,
  weeklyReportPickerCandidates,
  weeklyReportStepAt,
  weeklyReportStepIndex,
  type WeeklyReportDraft,
  type WeeklyReportDraftPhoto,
  type WeeklyReportSignableContent,
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

  it("blocks on a bad number and on a photo that has not uploaded", () => {
    expect(weeklyReportDraftBlocker(newDraft({ workCompleted: "done", completionPercent: "999" })))
      .toMatch(/between 0 and 100/i);
    expect(
      weeklyReportDraftBlocker(
        newDraft({
          workCompleted: "done",
          photos: [{ ...galleryPhoto("p"), key: "p", fileId: null, clientUploadId: "p" }],
        }),
      ),
    ).toMatch(/not uploaded/i);
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

  it("arms and disarms the lost-reply marker", () => {
    // The only dispatcher of this action is the wizard's submit, and nothing exercised the branch — a
    // reducer that simply returned the draft unchanged left every suite green. What it costs: the super
    // taps Submit, the transition commits, the reply dies on LTE, and they tap Submit again in the SAME
    // session (no app kill — the common case). `mayHaveCommitted` reads this field, finds null, and the
    // wizard tells them somebody else moved the report. It was their own successful filing.
    const armed = weeklyReportDraftReducer(newDraft(), {
      type: "setPendingTransition",
      to: "pending_review",
    });
    expect(armed.pendingTransitionTo).toBe("pending_review");
    expect(
      weeklyReportDraftReducer(armed, { type: "setPendingTransition", to: null }).pendingTransitionTo,
    ).toBeNull();
  });

  it("takes the provenance a create handed back, keeps it when none is given, clears it on an explicit null", () => {
    // `POST /reports` is idempotent, so it can answer 200 with a row that ALREADY HAS CONTENT on it. If
    // the id landed without the provenance, the draft would go on believing its baseline was an empty
    // report and every later open would report a conflict that is not there.
    const fromServer = { status: "draft" as const, signature: "sig-server" };
    const adopted = weeklyReportDraftReducer(newDraft(), {
      type: "setReportId",
      reportId: "rep-1",
      seededFrom: fromServer,
    });
    expect(adopted).toMatchObject({ reportId: "rep-1", seededFrom: fromServer });
    expect(
      weeklyReportDraftReducer(adopted, { type: "setReportId", reportId: "rep-2" }).seededFrom,
    ).toEqual(fromServer);
    expect(
      weeklyReportDraftReducer(adopted, { type: "setReportId", reportId: "rep-2", seededFrom: null })
        .seededFrom,
    ).toBeNull();
  });

  it("re-stamps the provenance from an acknowledged write without touching a word of the content", () => {
    const before = newDraft({ workCompleted: "Framed levels 3 and 4.", photos: [galleryPhoto("a")] });
    const after = weeklyReportDraftReducer(before, {
      type: "setSeededFrom",
      seededFrom: { status: "draft", signature: "sig-after-patch" },
    });
    expect(after.seededFrom).toEqual({ status: "draft", signature: "sig-after-patch" });
    expect(after.workCompleted).toBe("Framed levels 3 and 4.");
    expect(after.photos).toEqual(before.photos);
  });
});

/**
 * The content fingerprint, one input at a time.
 *
 * This is what "has the user typed anything?" and "has the server moved?" are BOTH computed from, so every
 * input it drops turns "keep the user's work" into "destroy it, silently, under a link labelled Resume".
 * It had no direct test at all: all coverage was incidental, through reconcile scenarios that always also
 * edited a prose section — so three of its six inputs could be deleted with 1406 tests still green.
 *
 * Every case below therefore varies exactly ONE input and holds the rest fixed.
 */
describe("the content fingerprint", () => {
  const BASE: WeeklyReportSignableContent = {
    workCompleted: "Poured the north slab.",
    nextWeekLookAhead: "Start unit framing.",
    issuesConcerns: "Permit still with the city.",
    completionPercent: "12.5",
    weatherDelayDays: "2",
    photos: [
      { key: "file-a", fileId: "file-a", caption: "North slab" },
      { key: "file-b", fileId: "file-b", caption: "Balcony mock-up" },
    ],
  };
  const sign = (override: Partial<WeeklyReportSignableContent> = {}) =>
    weeklyReportContentSignature({ ...BASE, ...override });

  it.each<[string, Partial<WeeklyReportSignableContent>]>([
    ["work completed", { workCompleted: "Poured the north slab. Stripped forms Friday." }],
    // Rewriting only the look-ahead: with this input dropped, the rewrite is thrown away on the next open.
    ["next week look ahead", { nextWeekLookAhead: "Start unit framing. Roof drain rough-in." }],
    ["issues and concerns", { issuesConcerns: "Rebar delivery slipped a week." }],
    ["completion %", { completionPercent: "18" }],
    ["weather delay days", { weatherDelayDays: "3" }],
    ["which photos are on the report", { photos: [BASE.photos[0]!] }],
    // A PM who fixes six captions and changes nothing else. Dropping the caption from the photo tuple
    // loses all six.
    [
      "a caption, with the same photos in the same order",
      {
        photos: [BASE.photos[0]!, { ...BASE.photos[1]!, caption: "Balcony mock-up, approved by the architect" }],
      },
    ],
    // Order IS the print order — the sequence the client reads the report in.
    ["the ORDER of the photos, and nothing else", { photos: [BASE.photos[1]!, BASE.photos[0]!] }],
  ])("changes when %s changes", (_what, override) => {
    expect(sign(override)).not.toBe(sign());
  });

  it.each<[string, Partial<WeeklyReportSignableContent>]>([
    ["whitespace around a section", { workCompleted: "  Poured the north slab.  " }],
    // "12.50" and "12.5" are one value, not a phantom edit that raises a conflict prompt.
    ["a trailing zero on the completion %", { completionPercent: "12.50" }],
    ["whitespace around a caption", { photos: [BASE.photos[0]!, { ...BASE.photos[1]!, caption: " Balcony mock-up " }] }],
    // The local list key is only a fallback identity — once a photo has a file id, that is what it is.
    ["the local list key of a photo that has a file id", { photos: [{ ...BASE.photos[0]!, key: "upload-1" }, BASE.photos[1]!] }],
  ])("ignores %s", (_what, override) => {
    expect(sign(override)).toBe(sign());
  });

  it("tells a blank number from one it cannot parse", () => {
    // Both are "no value on the wire", but only one of them is something the user typed. Collapsing them
    // makes a half-typed entry invisible to the freshness check.
    expect(sign({ completionPercent: "" })).not.toBe(sign({ completionPercent: "abc" }));
    expect(sign({ weatherDelayDays: "" })).not.toBe(sign({ weatherDelayDays: "half a day" }));
  });

  it("counts a photo that is still uploading, which has no server identity yet", () => {
    // An imported photo IS a local edit before the upload gives it a file id, and two different imports
    // are two different reports.
    const uploading = { key: "upload-1", fileId: null, caption: "" };
    expect(sign({ photos: [...BASE.photos, uploading] })).not.toBe(sign());
    expect(sign({ photos: [uploading] })).not.toBe(
      sign({ photos: [{ ...uploading, key: "upload-2" }] }),
    );
  });

  it("is the same function the draft signature and the empty baseline are built from", () => {
    // Two implementations of "what does the server hold" versus "what do I hold" would drift on the first
    // field added, and the symptom would be a conflict prompt on every single open.
    const draft = newDraft({
      workCompleted: BASE.workCompleted,
      nextWeekLookAhead: BASE.nextWeekLookAhead,
      issuesConcerns: BASE.issuesConcerns,
      completionPercent: BASE.completionPercent,
      weatherDelayDays: BASE.weatherDelayDays,
      photos: [
        galleryPhoto("file-a", { caption: "North slab" }),
        galleryPhoto("file-b", { caption: "Balcony mock-up" }),
      ],
    });
    expect(weeklyReportDraftSignature(draft)).toBe(sign());
    // A brand-new local draft is, by construction, the empty report `POST /reports` leaves behind — which
    // is what makes "this draft has never been near the server" answerable at all.
    expect(weeklyReportDraftSignature(newDraft())).toBe(WEEKLY_REPORT_EMPTY_SIGNATURE);
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

describe("the picker's grid", () => {
  function candidate(fileId: string, overrides: Record<string, unknown> = {}) {
    return {
      fileId,
      caption: null,
      originalDescription: null,
      sortOrder: 0,
      takenAt: null,
      mimeType: null,
      thumbnailUrl: `https://example.test/${fileId}-thumb.jpg`,
      fullUrl: null,
      alreadyUsedOn: null,
      selected: false,
      ...overrides,
    };
  }

  it("leaves the server's window untouched when it already carries every selection", () => {
    const merged = weeklyReportPickerCandidates(
      [candidate("a"), candidate("b")],
      [galleryPhoto("a")],
    );
    expect(merged.map((c) => c.fileId)).toEqual(["a", "b"]);
  });

  it("appends a selected photo the window does not carry, so the ticks match the count", () => {
    // The window is CAPPED newest-first and anchored on week_of. A photo picked from the far end of it
    // drops out as soon as enough newer ones exist, and an import carries its own EXIF time so it can
    // fall outside the window entirely. Either way the header kept counting it as selected while no tick
    // appeared anywhere on screen — and there was no way to deselect it.
    const merged = weeklyReportPickerCandidates(
      [candidate("new")],
      [galleryPhoto("old", { caption: "North slab", localUri: "file:///doc/old.jpg" })],
    );
    expect(merged.map((c) => c.fileId)).toEqual(["new", "old"]);
    expect(merged[1]).toMatchObject({
      selected: true,
      caption: "North slab",
      // The durable local copy, not the expired presigned url — same rule as the preview.
      thumbnailUrl: "file:///doc/old.jpg",
    });
  });

  it("ignores a photo that is still uploading, which has no server identity yet", () => {
    const merged = weeklyReportPickerCandidates(
      [candidate("a")],
      [galleryPhoto("pending", { fileId: null, localUri: "file:///doc/pending.jpg" })],
    );
    expect(merged.map((c) => c.fileId)).toEqual(["a"]);
  });

  it("never duplicates a photo, whatever the draft holds twice", () => {
    const merged = weeklyReportPickerCandidates([], [galleryPhoto("a"), galleryPhoto("a", { key: "a2" })]);
    expect(merged.map((c) => c.fileId)).toEqual(["a"]);
  });
});
